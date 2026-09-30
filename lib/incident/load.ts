// Lectura de archivos: solo se importa desde la ruta API (servidor).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeIncident, type IncidentInput } from "./analyze";
import { parseHeartbeats, parseLog, parseSeats } from "./parse";

export const DATA_DIR = path.join(process.cwd(), "docs", "incident-command");

const read = (file: string) => readFile(path.join(DATA_DIR, file), "utf8");

export async function loadIncidentInput(): Promise<IncidentInput> {
  const [server, deploy, carrier, seats, heartbeats] = await Promise.all([
    read("server.log"),
    read("deploy.log"),
    read("carrier.log"),
    read("seats.json"),
    read("client-heartbeats.json"),
  ]);
  return {
    events: [
      ...parseLog(server, "server", "server.log"),
      ...parseLog(deploy, "deploy", "deploy.log"),
      ...parseLog(carrier, "carrier", "carrier.log"),
    ],
    seats: parseSeats(seats),
    heartbeats: parseHeartbeats(heartbeats),
  };
}

export async function runAnalysis() {
  return analyzeIncident(await loadIncidentInput());
}
