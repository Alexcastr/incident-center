// Contrato compartido entre el motor (servidor) y el dashboard (cliente).

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type SourceId = "server" | "deploy" | "carrier" | "heartbeats";

/** Línea de log parseada, con el timestamp ya normalizado a UTC. */
export type LogEvent = {
  id: string; // "srv-05"
  at: string; // ISO 8601 en UTC
  originalTimestamp: string; // tal cual aparece en el archivo
  source: SourceId;
  file: string;
  line: number;
  level?: string; // INFO | WARN | ERROR (solo server.log)
  message: string; // texto después del timestamp y del nivel
  fields: Record<string, string>; // pares key=value
};

export type Seat = { seat: string; agency: string; activeCall: boolean };

export type Heartbeat = { seat: string; build: string; lastSeen: string };

export type Signal = {
  id: string;
  timestamp: string; // UTC
  originalTimestamp?: string; // solo si el origen no estaba en UTC
  source: SourceId;
  severity: Severity;
  message: string;
  ref: string; // "server.log:5"
};

/** known = observado en una fuente; inferred = conclusión razonada; verify = falta confirmar. */
export type Certainty = "known" | "inferred" | "verify";

export type Finding = {
  id: string;
  certainty: Certainty;
  statement: string;
  signalIds: string[];
};

export type Evidence = { signalId: string; note: string; weight: number };

export type Hypothesis = {
  id: string;
  title: string;
  description?: string;
  confidence: number; // 0–1, calculada a partir de los pesos de la evidencia
  evidenceFor: Evidence[];
  evidenceAgainst: Evidence[];
};

export type Contradiction = { description: string; signalIds: string[] };

export type Action = {
  id: string;
  description: string;
  priority: number; // 1 = máxima
  requiresApproval: boolean;
  owner?: string;
  rationale?: string;
};

export type Impact = {
  summary: string;
  certainty: Certainty;
  seatsTotal: number;
  seatsAffected: number;
  activeCallsAtRisk: string[];
  agencies: { name: string; total: number; affected: number }[];
};

export type AnalyzeResponse = {
  incident: {
    id: string;
    title: string;
    service: string;
    severity: Severity;
    openedAt: string; // primer síntoma del incidente principal
    asOf: string; // último evento observado: el "ahora" del análisis
  };
  signals: Signal[];
  analysis: {
    summary: string;
    impact: Impact;
    findings: Finding[];
    hypotheses: Hypothesis[];
    misleadingSignals: { signalId: string; reason: string }[];
    contradictions: Contradiction[];
    actions: Action[];
    followUp: string[];
  };
};
