import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { analyzeIncident } from "./analyze";
import { parseHeartbeats, parseLog, parseSeats } from "./parse";
import type { AnalyzeResponse } from "./types";

const dir = path.join(import.meta.dir, "..", "..", "docs", "incident-command");
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");

let result: AnalyzeResponse;

beforeAll(() => {
  result = analyzeIncident({
    events: [
      ...parseLog(read("server.log"), "server", "server.log"),
      ...parseLog(read("deploy.log"), "deploy", "deploy.log"),
      ...parseLog(read("carrier.log"), "carrier", "carrier.log"),
    ],
    seats: parseSeats(read("seats.json")),
    heartbeats: parseHeartbeats(read("client-heartbeats.json")),
  });
});

const statements = (certainty: string) =>
  result.analysis.findings.filter((f) => f.certainty === certainty).map((f) => f.statement).join("\n");

describe("dataset del reto", () => {
  test("abre el incidente en el primer síntoma y usa el último evento como 'ahora'", () => {
    expect(result.incident.openedAt).toBe("2026-09-29T13:05:18.000Z");
    expect(result.incident.asOf).toBe("2026-09-29T13:09:44.000Z");
    expect(result.incident.severity).toBe("critical");
  });

  test("la timeline está en UTC: el deploy (-05:00) cae justo antes del error", () => {
    const deploy = result.signals.find((s) => s.ref === "deploy.log:1")!;
    expect(deploy.timestamp).toBe("2026-09-29T13:04:50.000Z");
    expect(deploy.originalTimestamp).toBe("2026-09-29T08:04:50-05:00");
    const order = result.signals.map((s) => s.ref);
    expect(order.indexOf("deploy.log:1")).toBeLessThan(order.indexOf("server.log:5"));
  });

  test("la hipótesis principal es el deploy incompleto, no el error más ruidoso", () => {
    const [top, ...rest] = result.analysis.hypotheses;
    expect(top.id).toBe("h-deploy");
    expect(top.title).toContain("normalizeCallIndex");
    expect(top.confidence).toBeGreaterThan(0.7);
    for (const h of rest) expect(h.confidence).toBeLessThan(top.confidence);
    expect(result.analysis.hypotheses.find((h) => h.id === "h-carrier-beta")!.confidence).toBeLessThan(0.2);
  });

  test("separa lo que sabemos, lo que inferimos y lo que falta verificar", () => {
    expect(statements("known")).toContain("4 reinicios de systemd");
    expect(statements("known")).toContain("S003, S007, S014 dejaron de reportar antes del deploy");
    expect(statements("inferred")).toContain("crash loop");
    expect(statements("inferred")).toContain("carrier Beta es un incidente separado");
    expect(statements("verify")).toContain("S002, S005, S011");
  });

  test("estima el impacto a partir de seats y heartbeats", () => {
    const { impact } = result.analysis;
    expect(impact.seatsTotal).toBe(20);
    expect(impact.seatsAffected).toBe(20);
    expect(impact.activeCallsAtRisk).toEqual(["S002", "S005", "S011"]);
    expect(impact.agencies.map((a) => a.name)).toEqual(["Demo Agency A", "Demo Agency B"]);
  });

  test("marca como engañosas el health vía proxy, el WARN benigno, el carrier y el build viejo", () => {
    const misleading = result.analysis.misleadingSignals.map((m) => m.signalId);
    const refOf = (id: string) => result.signals.find((s) => s.id === id)!.ref;
    expect(misleading.map(refOf)).toEqual(
      expect.arrayContaining(["server.log:10", "server.log:2", "carrier.log:3", "server.log:3"]),
    );
    expect(result.signals.find((s) => s.message.includes("2026.09.28.9"))!.id).toBeOneOf(misleading);
    expect(misleading).not.toContain(result.signals.find((s) => s.ref === "server.log:5")!.id);
  });

  test("el siguiente paso seguro es verificar sin proxy y luego hacer rollback con aprobación", () => {
    const [first, second] = result.analysis.actions;
    expect(first).toMatchObject({ id: "verify-origin", priority: 1, requiresApproval: false });
    expect(second).toMatchObject({ id: "rollback", priority: 1, requiresApproval: true });
    expect(second.description).toContain("2026.09.29.4");
  });

  test("toda evidencia apunta a una señal existente de la timeline", () => {
    const known = new Set(result.signals.map((s) => s.id));
    const referenced = [
      ...result.analysis.findings.flatMap((f) => f.signalIds),
      ...result.analysis.hypotheses.flatMap((h) => [...h.evidenceFor, ...h.evidenceAgainst].map((e) => e.signalId)),
      ...result.analysis.contradictions.flatMap((c) => c.signalIds),
      ...result.analysis.misleadingSignals.map((m) => m.signalId),
    ];
    for (const id of referenced) expect(known.has(id)).toBe(true);
  });
});
