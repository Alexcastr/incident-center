import { runAnalysis } from "@/lib/incident/load";

export async function GET() {
  try {
    return Response.json(await runAnalysis());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/analyze]", error);
    return Response.json({ error: `No se pudo analizar el incidente: ${message}` }, { status: 500 });
  }
}
