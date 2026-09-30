import type { Heartbeat, LogEvent, Seat, SourceId } from "./types";

const SOURCE_PREFIX: Record<SourceId, string> = {
  server: "srv",
  deploy: "dep",
  carrier: "car",
  heartbeats: "hb",
};

// Timestamp ISO 8601 con zona obligatoria (Z o ±HH:MM) al inicio de la línea.
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(.*)$/;
const LEVEL = /^(DEBUG|INFO|WARN|ERROR)\s+(.*)$/;
const KEY_VALUE = /(\w+)=("[^"]*"|\S+)/g;

export const signalId = (source: SourceId, n: number) =>
  `${SOURCE_PREFIX[source]}-${String(n).padStart(2, "0")}`;

/** Parsea un log de texto. Las líneas sin timestamp válido se ignoran. */
export function parseLog(text: string, source: SourceId, file: string): LogEvent[] {
  return text.split(/\r?\n/).flatMap((raw, index) => {
    const match = LINE.exec(raw.trim());
    if (!match) return [];
    const [, timestamp, rest] = match;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return [];

    const leveled = LEVEL.exec(rest);
    const message = leveled ? leveled[2] : rest;
    const fields = Object.fromEntries(
      [...message.matchAll(KEY_VALUE)].map(([, key, value]) => [key, value.replace(/^"|"$/g, "")]),
    );

    return [
      {
        id: signalId(source, index + 1),
        at: date.toISOString(),
        originalTimestamp: timestamp,
        source,
        file,
        line: index + 1,
        level: leveled?.[1],
        message,
        fields,
      },
    ];
  });
}

function parseArray(text: string, file: string): Record<string, unknown>[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`${file}: se esperaba un arreglo JSON`);
  return data;
}

export function parseSeats(text: string, file = "seats.json"): Seat[] {
  return parseArray(text, file).map((row, i) => {
    if (typeof row.seat !== "string" || typeof row.agency !== "string") {
      throw new Error(`${file}[${i}]: faltan "seat" o "agency"`);
    }
    return { seat: row.seat, agency: row.agency, activeCall: row.active_call === true };
  });
}

export function parseHeartbeats(text: string, file = "client-heartbeats.json"): Heartbeat[] {
  return parseArray(text, file).map((row, i) => {
    const lastSeen = new Date(String(row.last_seen));
    if (typeof row.seat !== "string" || Number.isNaN(lastSeen.getTime())) {
      throw new Error(`${file}[${i}]: faltan "seat" o "last_seen" válido`);
    }
    return { seat: row.seat, build: String(row.build ?? "desconocido"), lastSeen: lastSeen.toISOString() };
  });
}
