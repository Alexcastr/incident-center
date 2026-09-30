import { describe, expect, test } from "bun:test";
import { parseHeartbeats, parseLog, parseSeats } from "./parse";

describe("parseLog", () => {
  test("normaliza zonas horarias no UTC a UTC y conserva el original", () => {
    const [event] = parseLog("2026-09-29T08:04:50-05:00 DEPLOY candidate build=2026.09.29.5", "deploy", "deploy.log");
    expect(event.at).toBe("2026-09-29T13:04:50.000Z");
    expect(event.originalTimestamp).toBe("2026-09-29T08:04:50-05:00");
    expect(event.fields.build).toBe("2026.09.29.5");
  });

  test("separa nivel, mensaje y campos key=value", () => {
    const [event] = parseLog(
      "2026-09-29T13:05:18Z ERROR import Cannot find export 'normalizeCallIndex' module=call-index.js",
      "server",
      "server.log",
    );
    expect(event.level).toBe("ERROR");
    expect(event.message).toStartWith("import Cannot find export");
    expect(event.fields.module).toBe("call-index.js");
    expect(event.id).toBe("srv-01");
  });

  test("ignora líneas vacías o sin timestamp y conserva el número de línea real", () => {
    const events = parseLog("\nbasura\n2026-09-29T13:01:00Z carrier=Alpha action=quote status=200\n", "carrier", "carrier.log");
    expect(events).toHaveLength(1);
    expect(events[0].line).toBe(3);
    expect(events[0].fields).toEqual({ carrier: "Alpha", action: "quote", status: "200" });
  });
});

describe("JSON", () => {
  test("parsea seats y heartbeats", () => {
    expect(parseSeats('[{"seat":"S001","agency":"A","active_call":true}]')).toEqual([
      { seat: "S001", agency: "A", activeCall: true },
    ]);
    expect(parseHeartbeats('[{"seat":"S001","build":"b1","last_seen":"2026-09-29T13:04:55Z"}]')[0].lastSeen).toBe(
      "2026-09-29T13:04:55.000Z",
    );
  });

  test("rechaza filas inválidas con un mensaje claro", () => {
    expect(() => parseSeats('[{"agency":"A"}]')).toThrow("seats.json[0]");
    expect(() => parseHeartbeats("{}")).toThrow("se esperaba un arreglo");
  });
});
