"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type {
  Action,
  AnalyzeResponse,
  Certainty,
  Evidence,
  Finding,
  Hypothesis,
  Impact,
  Severity,
  Signal,
} from "@/lib/incident/types";

// Ordena y rellena listas faltantes para que la UI no se rompa si el backend omite algo.
function normalize(raw: AnalyzeResponse): AnalyzeResponse {
  if (!raw?.incident) throw new Error("Respuesta inválida: falta el incidente");
  const a: Partial<AnalyzeResponse["analysis"]> = raw.analysis ?? {};
  return {
    incident: raw.incident,
    signals: [...(raw.signals ?? [])].sort(
      (x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp),
    ),
    analysis: {
      summary: a.summary ?? "",
      impact: a.impact ?? {
        summary: "",
        certainty: "verify",
        seatsTotal: 0,
        seatsAffected: 0,
        activeCallsAtRisk: [],
        agencies: [],
      },
      findings: a.findings ?? [],
      hypotheses: (a.hypotheses ?? [])
        .map((h) => ({
          ...h,
          evidenceFor: h.evidenceFor ?? [],
          evidenceAgainst: h.evidenceAgainst ?? [],
        }))
        .sort((x, y) => y.confidence - x.confidence),
      misleadingSignals: a.misleadingSignals ?? [],
      contradictions: (a.contradictions ?? []).map((c) => ({
        ...c,
        signalIds: c.signalIds ?? [],
      })),
      actions: [...(a.actions ?? [])].sort((x, y) => x.priority - y.priority),
      followUp: a.followUp ?? [],
    },
  };
}

async function fetchAnalysis(signal: AbortSignal) {
  const res = await fetch("/api/analyze", { cache: "no-store", signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `La API respondió ${res.status}`);
  return normalize(body);
}

// ─── Estilos y formato ───────────────────────────────────────────────────────

const PANEL = "rounded-xl border border-white/[0.07] bg-[#0b0f15]/90";
const SCROLL = "[scrollbar-color:rgba(255,255,255,0.14)_transparent] [scrollbar-width:thin]";

const SEVERITY_STYLES: Record<Severity, { label: string; badge: string; dot: string }> = {
  critical: { label: "Crítica", badge: "bg-red-500/15 text-red-300 ring-red-500/40", dot: "bg-red-500" },
  high: { label: "Alta", badge: "bg-orange-500/15 text-orange-300 ring-orange-500/40", dot: "bg-orange-500" },
  medium: { label: "Media", badge: "bg-amber-400/10 text-amber-200 ring-amber-400/35", dot: "bg-amber-400" },
  low: { label: "Baja", badge: "bg-sky-400/10 text-sky-300 ring-sky-400/35", dot: "bg-sky-400" },
  info: { label: "Info", badge: "bg-white/[0.06] text-zinc-300 ring-white/15", dot: "bg-zinc-400" },
};

const SEVERITY_ALIASES: Record<string, Severity> = {
  sev1: "critical",
  sev2: "high",
  sev3: "medium",
  sev4: "low",
  error: "high",
  warning: "medium",
  warn: "medium",
};

function severityStyle(value: string) {
  const key = (value ?? "").toLowerCase();
  return (
    SEVERITY_STYLES[(SEVERITY_ALIASES[key] ?? key) as Severity] ?? {
      ...SEVERITY_STYLES.info,
      label: value,
    }
  );
}

type SourceStyle = { dot: string; text: string };

// Evita rojo/naranja/ámbar/verde, que ya significan severidad o evidencia.
const SOURCE_PALETTE: SourceStyle[] = [
  { dot: "bg-violet-400", text: "text-violet-300" },
  { dot: "bg-blue-400", text: "text-blue-300" },
  { dot: "bg-pink-400", text: "text-pink-300" },
  { dot: "bg-lime-400", text: "text-lime-300" },
  { dot: "bg-teal-300", text: "text-teal-200" },
  { dot: "bg-fuchsia-400", text: "text-fuchsia-300" },
  { dot: "bg-indigo-300", text: "text-indigo-200" },
  { dot: "bg-yellow-200", text: "text-yellow-100" },
];

const SOURCE_LABELS: Record<string, string> = {
  server: "Servidor",
  deploy: "Deploy",
  carrier: "Carriers",
  heartbeats: "Heartbeats",
};

const sourceLabel = (source: string) =>
  SOURCE_LABELS[source.toLowerCase()] ?? source.charAt(0).toUpperCase() + source.slice(1);

const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};
// Los datos del incidente se muestran en UTC (así se correlacionan); las acciones del usuario, en hora local.
const utcFormat = new Intl.DateTimeFormat("es-ES", { ...TIME_OPTIONS, timeZone: "UTC" });
const localFormat = new Intl.DateTimeFormat("es-ES", TIME_OPTIONS);

function formatTime(value: string | number, format = utcFormat) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return format === utcFormat ? `${format.format(date)}Z` : format.format(date);
}

const formatLocalTime = (value: number) => formatTime(value, localFormat);

// El marcador codifica la certeza: lleno = hecho, mitad = inferencia, vacío = por verificar.
const CERTAINTY: Record<Certainty, { label: string; marker: string; tone: string; hint: string }> = {
  known: {
    label: "Sabemos",
    marker: "bg-current",
    tone: "text-sky-300",
    hint: "Observado directamente en una fuente",
  },
  inferred: {
    label: "Inferimos",
    marker: "bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]",
    tone: "text-violet-300",
    hint: "Conclusión razonada a partir de varias señales",
  },
  verify: {
    label: "Por verificar",
    marker: "",
    tone: "text-amber-300",
    hint: "Falta confirmarlo antes de actuar",
  },
};

const pad = (n: number) => String(n).padStart(2, "0");

function formatDuration(ms: number) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  s %= 86400;
  const hms = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return days ? `${days}d ${hms}` : hms;
}

// Desfase de la señal respecto a la apertura del incidente: T+04:12, T−1:02:00.
function formatOffset(ms: number) {
  if (Number.isNaN(ms)) return "";
  const total = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `T${ms < 0 ? "−" : "+"}${h ? `${h}:` : ""}${pad(m)}:${pad(total % 60)}`;
}

const toPercent = (confidence: number) =>
  Math.round(Math.min(100, Math.max(0, confidence <= 1 ? confidence * 100 : confidence)));

function confidenceTone(pct: number) {
  if (pct >= 60) return { bar: "bg-linear-to-r from-cyan-500 to-cyan-300", text: "text-cyan-200" };
  if (pct >= 30) return { bar: "bg-cyan-700", text: "text-zinc-200" };
  return { bar: "bg-zinc-600", text: "text-zinc-400" };
}

function priorityStyle(priority: number) {
  if (priority <= 1) return "bg-red-500/15 text-red-300 ring-red-500/40";
  if (priority === 2) return "bg-orange-500/15 text-orange-300 ring-orange-500/40";
  if (priority === 3) return "bg-amber-400/10 text-amber-200 ring-amber-400/30";
  return "bg-white/5 text-zinc-400 ring-white/10";
}

// ─── Iconos ──────────────────────────────────────────────────────────────────

const ICONS = {
  refresh: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6",
  chevron: "m6 9 6 6 6-6",
  check: "M20 6 9 17l-5-5",
  warning:
    "M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
  target: "M12 2v4m0 12v4M2 12h4m12 0h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  split: "M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
};

function Icon({ name, className = "size-3.5" }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

// ─── Página ──────────────────────────────────────────────────────────────────

export default function IncidentCommandCenter() {
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzedAt, setAnalyzedAt] = useState<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const analyze = useCallback(() => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    fetchAnalysis(request.signal)
      .then((next) => {
        setData(next);
        setAnalyzedAt(Date.now());
        setError(null);
      })
      .catch((err: unknown) => {
        if (!request.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (requestRef.current === request) setLoading(false);
      });
  }, []);

  useEffect(() => {
    analyze();
    return () => requestRef.current?.abort();
  }, [analyze]);

  const reanalyze = () => {
    setLoading(true);
    analyze();
  };

  return (
    <div className="relative isolate flex min-h-dvh flex-1 flex-col bg-[#05070b] font-sans text-zinc-100 lg:h-dvh lg:min-h-0 lg:flex-none lg:overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 [background-image:linear-gradient(rgba(148,163,184,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.05)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_70%_45%_at_50%_-5%,rgba(34,211,238,0.10),transparent_70%)]"
      />
      {loading && data && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 animate-pulse bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.8)]" />
      )}

      {data ? (
        <Dashboard
          data={data}
          loading={loading}
          error={error}
          analyzedAt={analyzedAt}
          onReanalyze={reanalyze}
        />
      ) : loading ? (
        <LoadingState />
      ) : (
        <ErrorState message={error ?? "Sin datos"} onRetry={reanalyze} />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5">
      <div className="relative size-14">
        <div className="absolute inset-0 rounded-full border-2 border-cyan-400/15" />
        <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-cyan-400" />
      </div>
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-zinc-400">Analizando incidente…</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className={`${PANEL} max-w-md p-6 text-center`}>
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/30">
          <Icon name="warning" className="size-5" />
        </div>
        <h1 className="mt-4 text-base font-semibold">No se pudo obtener el análisis</h1>
        <p className="mt-1 font-mono text-xs text-zinc-500">GET /api/analyze · {message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-300"
        >
          <Icon name="refresh" /> Reintentar
        </button>
      </div>
    </div>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

function Dashboard({
  data,
  loading,
  error,
  analyzedAt,
  onReanalyze,
}: {
  data: AnalyzeResponse;
  loading: boolean;
  error: string | null;
  analyzedAt: number | null;
  onReanalyze: () => void;
}) {
  const { incident, signals, analysis } = data;

  // Vacío = todas las fuentes visibles.
  const [selectedSources, setSelectedSources] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [approvals, setApprovals] = useState<Record<string, number>>({});
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);

  const signalById = useMemo(() => new Map(signals.map((s) => [s.id, s])), [signals]);
  const misleading = useMemo(
    () => new Map(analysis.misleadingSignals.map((m) => [m.signalId, m.reason])),
    [analysis.misleadingSignals],
  );
  const sourceStyles = useMemo(() => {
    const sources = [...new Set(signals.map((s) => s.source))].sort();
    return new Map(sources.map((s, i) => [s, SOURCE_PALETTE[i % SOURCE_PALETTE.length]]));
  }, [signals]);

  const focusSignal = useCallback(
    (id: string) => {
      const signal = signalById.get(id);
      if (!signal) return;
      // Si el filtro actual oculta la señal, se agrega su fuente para que sea visible.
      setSelectedSources((prev) => {
        if (prev.size === 0 || prev.has(signal.source)) return prev;
        return new Set(prev).add(signal.source);
      });
      setFocus({ id, nonce: Date.now() });
    },
    [signalById],
  );

  useEffect(() => {
    if (!focus) return;
    document
      .getElementById(`signal-${focus.id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timeout = setTimeout(() => setFocus((f) => (f === focus ? null : f)), 3200);
    return () => clearTimeout(timeout);
  }, [focus]);

  const toggleSource = (source: string) =>
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });

  const toggleHypothesis = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const approve = (id: string) => setApprovals((prev) => ({ ...prev, [id]: Date.now() }));

  const signalLink = (id: string) => (
    <SignalLink key={id} id={id} exists={signalById.has(id)} onFocus={focusSignal} />
  );

  return (
    <>
      <Header incident={incident} loading={loading} analyzedAt={analyzedAt} onReanalyze={onReanalyze} />

      <main
        className={`flex min-h-0 flex-1 flex-col gap-4 p-4 transition-opacity duration-300 lg:px-6 lg:pb-5 ${
          loading ? "opacity-60" : ""
        }`}
      >
        <DiagnosisBanner summary={analysis.summary} impact={analysis.impact} />

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200"
          >
            <Icon name="warning" className="size-4 shrink-0" />
            No se pudo re-analizar ({error}). Se muestra el último análisis.
          </div>
        )}

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:grid-rows-[minmax(0,1fr)]">
          <Timeline
            signals={signals}
            openedAt={incident.openedAt}
            misleading={misleading}
            sourceStyles={sourceStyles}
            selectedSources={selectedSources}
            onToggleSource={toggleSource}
            onShowAll={() => setSelectedSources(new Set())}
            focusedId={focus?.id ?? null}
          />

          <div className={`flex min-h-0 flex-col gap-4 lg:overflow-y-auto lg:pr-1 ${SCROLL}`}>
            <KnowledgePanel findings={analysis.findings} signalLink={signalLink} />

            <Panel title="Hipótesis de causa" meta={`${analysis.hypotheses.length}, ordenadas por confianza`}>
              {analysis.hypotheses.length === 0 ? (
                <Empty>Sin hipótesis.</Empty>
              ) : (
                <div className="space-y-2 p-3">
                  {analysis.hypotheses.map((h, i) => (
                    <HypothesisCard
                      key={h.id}
                      hypothesis={h}
                      rank={i + 1}
                      open={expanded.has(h.id)}
                      onToggle={() => toggleHypothesis(h.id)}
                      signalLink={signalLink}
                    />
                  ))}
                </div>
              )}
            </Panel>

            <ActionsPanel actions={analysis.actions} approvals={approvals} onApprove={approve} />

            <Panel title="Contradicciones" meta={`${analysis.contradictions.length} detectadas`}>
              {analysis.contradictions.length === 0 ? (
                <Empty>No se detectaron contradicciones.</Empty>
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {analysis.contradictions.map((c, i) => (
                    <li key={i} className="flex gap-3 px-4 py-3">
                      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-400/10 text-amber-300 ring-1 ring-inset ring-amber-400/30">
                        <Icon name="split" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13px] leading-snug text-zinc-200">{c.description}</p>
                        {c.signalIds.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">{c.signalIds.map(signalLink)}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Follow-up post-incidente" meta={`${analysis.followUp.length} tareas`}>
              {analysis.followUp.length === 0 ? (
                <Empty>Sin tareas de seguimiento.</Empty>
              ) : (
                <ul className="space-y-2.5 px-4 py-3.5">
                  {analysis.followUp.map((item, i) => (
                    <li key={i} className="flex gap-3 text-[13px] leading-snug text-zinc-300">
                      <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-zinc-600" />
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </main>
    </>
  );
}

// ─── Header y diagnóstico ────────────────────────────────────────────────────

function Header({
  incident,
  loading,
  analyzedAt,
  onReanalyze,
}: {
  incident: AnalyzeResponse["incident"];
  loading: boolean;
  analyzedAt: number | null;
  onReanalyze: () => void;
}) {
  const severity = severityStyle(incident.severity);
  const duration = Date.parse(incident.asOf) - Date.parse(incident.openedAt);
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-b border-white/[0.06] bg-black/40 px-4 py-3.5 backdrop-blur lg:px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 text-xs text-zinc-500">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500/70" />
            <span className="relative inline-flex size-2 rounded-full bg-red-500" />
          </span>
          <span className="font-medium text-red-400">Incidente activo</span>
          <span className="text-zinc-700">/</span>
          <span className="font-mono">{incident.service}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-sm font-medium text-zinc-300 ring-1 ring-inset ring-white/10">
            {incident.id}
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">{incident.title}</h1>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-inset ${severity.badge}`}
          >
            <span className={`size-1.5 rounded-full ${severity.dot}`} />
            Severidad {severity.label.toLowerCase()}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div className="text-right">
          <div className="text-xs text-zinc-500">Duración observada</div>
          <div className="font-mono text-2xl font-semibold leading-tight tabular-nums text-zinc-50">
            {Number.isNaN(duration) ? "--:--:--" : formatDuration(duration)}
          </div>
          <div className="font-mono text-[11px] text-zinc-500">
            {formatTime(incident.openedAt)} → {formatTime(incident.asOf)}
          </div>
        </div>
        <div className="h-12 w-px bg-white/10" />
        <div className="flex flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={onReanalyze}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-3.5 py-2 text-sm font-semibold text-zinc-950 shadow-[0_0_24px_-6px_rgba(34,211,238,0.7)] transition hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-70"
          >
            <Icon name="refresh" className={`size-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Analizando…" : "Re-analizar"}
          </button>
          <span className="text-[11px] text-zinc-500">
            Último análisis {analyzedAt ? formatLocalTime(analyzedAt) : "—"}
          </span>
        </div>
      </div>
    </header>
  );
}

function DiagnosisBanner({ summary, impact }: { summary: string; impact: Impact }) {
  const certainty = CERTAINTY[impact.certainty];
  return (
    <section className="relative overflow-hidden rounded-xl border border-cyan-400/20 bg-linear-to-r from-cyan-500/[0.09] via-[#0b0f15]/90 to-[#0b0f15]/90">
      <div className="absolute inset-y-0 left-0 w-1 bg-cyan-400 shadow-[0_0_16px_rgba(34,211,238,0.8)]" />
      <div className="grid gap-4 p-4 pl-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div>
          <h2 className="text-sm font-semibold text-cyan-300">Causa probable</h2>
          <p className="mt-1.5 max-w-[80ch] text-[15px] leading-relaxed text-zinc-100">{summary || "—"}</p>
        </div>
        <div className="rounded-lg border border-red-500/25 bg-red-500/[0.07] px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-red-300">
            <Icon name="warning" className="size-3.5" /> Impacto en usuarios
            <span className={`ml-auto inline-flex items-center gap-1.5 text-xs font-normal ${certainty.tone}`} title={certainty.hint}>
              <CertaintyMarker certainty={impact.certainty} /> {certainty.label.toLowerCase()}
            </span>
          </h2>
          <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2">
            <p>
              <span className="font-mono text-2xl font-semibold tabular-nums text-red-50">
                {impact.seatsAffected}
                <span className="text-base text-red-200/60">/{impact.seatsTotal}</span>
              </span>
              <span className="ml-2 text-xs text-red-100/80">seats sin conexión</span>
            </p>
            <p>
              <span className="font-mono text-2xl font-semibold tabular-nums text-red-50">
                {impact.activeCallsAtRisk.length}
              </span>
              <span className="ml-2 text-xs text-red-100/80">
                llamadas activas en riesgo{impact.activeCallsAtRisk.length ? ` (${impact.activeCallsAtRisk.join(", ")})` : ""}
              </span>
            </p>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-red-100/70">
            {impact.agencies.map((a) => `${a.name}: ${a.affected}/${a.total}`).join(", ")}
          </p>
        </div>
      </div>
    </section>
  );
}

function CertaintyMarker({ certainty }: { certainty: Certainty }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2.5 shrink-0 rounded-full border-[1.5px] border-current ${CERTAINTY[certainty].marker}`}
    />
  );
}

function KnowledgePanel({
  findings,
  signalLink,
}: {
  findings: Finding[];
  signalLink: (id: string) => ReactNode;
}) {
  return (
    <Panel title="Qué sabemos y qué no" meta="Cada afirmación enlaza a su evidencia">
      <div className="grid gap-px bg-white/[0.05] xl:grid-cols-3">
        {(Object.keys(CERTAINTY) as Certainty[]).map((certainty) => {
          const style = CERTAINTY[certainty];
          const items = findings.filter((f) => f.certainty === certainty);
          return (
            <div key={certainty} className="bg-[#0b0f15] px-4 py-3">
              <h3 className={`flex items-center gap-2 text-sm font-semibold ${style.tone}`}>
                <CertaintyMarker certainty={certainty} />
                {style.label}
                <span className="font-mono text-xs font-normal text-zinc-500">{items.length}</span>
              </h3>
              <p className="mt-0.5 text-[11px] text-zinc-500">{style.hint}</p>
              {items.length === 0 ? (
                <p className="mt-3 text-xs text-zinc-600">Nada en esta categoría.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {items.map((f) => (
                    <li key={f.id} className="text-[12.5px] leading-snug text-zinc-300">
                      {f.statement}
                      {f.signalIds.length > 0 && (
                        <span className="mt-1.5 flex flex-wrap gap-1">{f.signalIds.map(signalLink)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ─── Timeline ────────────────────────────────────────────────────────────────

function Timeline({
  signals,
  openedAt,
  misleading,
  sourceStyles,
  selectedSources,
  onToggleSource,
  onShowAll,
  focusedId,
}: {
  signals: Signal[];
  openedAt: string;
  misleading: Map<string, string>;
  sourceStyles: Map<string, SourceStyle>;
  selectedSources: Set<string>;
  onToggleSource: (source: string) => void;
  onShowAll: () => void;
  focusedId: string | null;
}) {
  const visible =
    selectedSources.size === 0 ? signals : signals.filter((s) => selectedSources.has(s.source));
  const counts = new Map<string, number>();
  for (const s of signals) counts.set(s.source, (counts.get(s.source) ?? 0) + 1);
  const openedAtMs = Date.parse(openedAt);

  return (
    <section className={`${PANEL} flex max-h-[42rem] min-h-0 flex-col lg:max-h-none`}>
      <PanelHeader
        title="Timeline de señales"
        meta={`${visible.length} de ${signals.length} · ${misleading.size} engañosas`}
      />

      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-4 py-2.5">
        <span className="mr-1 text-xs text-zinc-500">Fuente</span>
        <FilterChip active={selectedSources.size === 0} onClick={onShowAll} label="Todas" count={signals.length} />
        {[...sourceStyles].map(([source, style]) => (
          <FilterChip
            key={source}
            active={selectedSources.has(source)}
            onClick={() => onToggleSource(source)}
            label={sourceLabel(source)}
            count={counts.get(source) ?? 0}
            dot={style.dot}
          />
        ))}
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto px-4 pb-32 pt-4 ${SCROLL}`}>
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">No hay señales para este filtro.</p>
        ) : (
          <ol className="relative space-y-2.5 before:absolute before:inset-y-3 before:left-[5px] before:w-px before:bg-white/10">
            {visible.map((signal) => (
              <SignalItem
                key={signal.id}
                signal={signal}
                offset={formatOffset(Date.parse(signal.timestamp) - openedAtMs)}
                style={sourceStyles.get(signal.source) ?? SOURCE_PALETTE[0]}
                misleadingReason={misleading.get(signal.id)}
                focused={focusedId === signal.id}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  dot?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ring-1 ring-inset transition ${
        active
          ? "bg-white/10 text-zinc-100 ring-white/25"
          : "text-zinc-400 ring-white/[0.08] hover:bg-white/[0.05] hover:text-zinc-200"
      }`}
    >
      {dot && <span className={`size-2 rounded-full ${dot}`} />}
      {label}
      <span className="font-mono text-[10px] text-zinc-500">{count}</span>
    </button>
  );
}

function SignalItem({
  signal,
  offset,
  style,
  misleadingReason,
  focused,
}: {
  signal: Signal;
  offset: string;
  style: SourceStyle;
  misleadingReason?: string;
  focused: boolean;
}) {
  const isMisleading = misleadingReason !== undefined;
  return (
    <li id={`signal-${signal.id}`} className="relative pl-7">
      <span
        aria-hidden
        className={`absolute left-0 top-3.5 size-[11px] rounded-full ring-4 ring-[#0b0f15] ${style.dot}`}
      />
      {focused && (
        <span
          aria-hidden
          className={`absolute left-0 top-3.5 size-[11px] animate-ping rounded-full ${style.dot}`}
        />
      )}

      <div
        tabIndex={isMisleading ? 0 : undefined}
        className={`group/card relative rounded-lg border px-3 py-2.5 transition-all duration-500 ${
          isMisleading
            ? "cursor-help border-dashed border-amber-400/55 bg-amber-400/[0.03] focus-visible:outline-2 focus-visible:outline-amber-300"
            : "border-white/[0.06] bg-white/[0.02]"
        } ${
          focused
            ? "bg-cyan-400/[0.08] shadow-[0_0_32px_-6px_rgba(34,211,238,0.55)] ring-2 ring-cyan-400"
            : "ring-0 ring-transparent"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <time dateTime={signal.timestamp} className="font-mono tabular-nums text-zinc-200">
            {formatTime(signal.timestamp)}
          </time>
          <span className="font-mono text-[10px] tabular-nums text-zinc-600">{offset}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${style.text}`}>
            {sourceLabel(signal.source)}
          </span>
          <SeverityBadge severity={signal.severity} />
          {isMisleading && (
            <span className="ml-auto inline-flex items-center gap-1 rounded border border-dashed border-amber-400/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
              <Icon name="warning" className="size-3" /> Engañosa
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-zinc-200">{signal.message}</p>
        <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-zinc-600">
          <span className="text-zinc-500">{signal.id}</span>
          <span>{signal.ref}</span>
          {signal.originalTimestamp && (
            <span className="text-sky-300/80" title="La fuente no estaba en UTC; se normalizó para correlacionar">
              original {signal.originalTimestamp}
            </span>
          )}
        </div>

        {isMisleading && (
          <div
            role="tooltip"
            className="pointer-events-none absolute right-3 top-full z-30 mt-2 w-80 max-w-[calc(100%-1.5rem)] translate-y-1 rounded-lg border border-amber-400/40 bg-[#1b1608] p-3 text-xs leading-relaxed text-amber-50 opacity-0 shadow-2xl shadow-black/70 transition duration-150 before:absolute before:-top-[7px] before:right-6 before:size-3 before:rotate-45 before:border-l before:border-t before:border-amber-400/40 before:bg-[#1b1608] group-hover/card:translate-y-0 group-hover/card:opacity-100 group-focus-visible/card:translate-y-0 group-focus-visible/card:opacity-100"
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
              Por qué es engañosa
            </div>
            {misleadingReason}
          </div>
        )}
      </div>
    </li>
  );
}

// ─── Hipótesis ───────────────────────────────────────────────────────────────

function HypothesisCard({
  hypothesis,
  rank,
  open,
  onToggle,
  signalLink,
}: {
  hypothesis: Hypothesis;
  rank: number;
  open: boolean;
  onToggle: () => void;
  signalLink: (id: string) => ReactNode;
}) {
  const pct = toPercent(hypothesis.confidence);
  const tone = confidenceTone(pct);
  return (
    <article
      className={`rounded-lg border transition-colors ${
        open
          ? "border-cyan-400/30 bg-cyan-400/[0.03]"
          : "border-white/[0.06] bg-white/[0.02] hover:border-white/15"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left"
      >
        <span className="font-mono text-[11px] text-zinc-500">H{rank}</span>
        <span className="block min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{hypothesis.title}</span>
            {rank === 1 && (
              <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-cyan-300 ring-1 ring-inset ring-cyan-400/30">
                Más probable
              </span>
            )}
          </span>
          <span className="mt-2 flex items-center gap-3">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <span
                style={{ "--confidence": `${pct}%` } as CSSProperties}
                className={`block h-full w-(--confidence) rounded-full transition-[width] duration-700 ease-out starting:w-0 ${tone.bar}`}
              />
            </span>
            <span className={`w-10 text-right font-mono text-sm font-semibold tabular-nums ${tone.text}`}>
              {pct}%
            </span>
          </span>
        </span>
        <Icon
          name="chevron"
          className={`size-4 shrink-0 text-zinc-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-white/[0.05] px-3.5 pb-3.5 pt-3">
          {hypothesis.description && (
            <p className="mb-3 text-[13px] leading-relaxed text-zinc-400">{hypothesis.description}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <EvidenceList kind="for" items={hypothesis.evidenceFor} signalLink={signalLink} />
            <EvidenceList kind="against" items={hypothesis.evidenceAgainst} signalLink={signalLink} />
          </div>
        </div>
      )}
    </article>
  );
}

function EvidenceList({
  kind,
  items,
  signalLink,
}: {
  kind: "for" | "against";
  items: Evidence[];
  signalLink: (id: string) => ReactNode;
}) {
  const isFor = kind === "for";
  return (
    <div
      className={`rounded-md border p-2.5 ${
        isFor ? "border-emerald-500/25 bg-emerald-500/[0.05]" : "border-rose-500/25 bg-rose-500/[0.05]"
      }`}
    >
      <div
        className={`mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${
          isFor ? "text-emerald-300" : "text-rose-300"
        }`}
      >
        <Icon name={isFor ? "plus" : "minus"} className="size-3" />
        {isFor ? "A favor" : "En contra"}
        <span className="font-mono text-zinc-500">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-zinc-500">Sin evidencia.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((e, i) => (
            <li key={`${e.signalId}-${i}`} className="text-xs leading-snug text-zinc-300">
              <span className="mr-1.5">{signalLink(e.signalId)}</span>
              {e.note}
              <span className={`ml-1.5 font-mono text-[10px] ${isFor ? "text-emerald-400/70" : "text-rose-400/70"}`}>
                {isFor ? "+" : "−"}
                {e.weight.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SignalLink({
  id,
  exists,
  onFocus,
}: {
  id: string;
  exists: boolean;
  onFocus: (id: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={!exists}
      onClick={() => onFocus(id)}
      title={exists ? "Resaltar en el timeline" : "La señal no está en el timeline"}
      className="inline-flex items-center gap-1 rounded bg-cyan-400/10 px-1.5 py-px align-baseline font-mono text-[10.5px] text-cyan-300 ring-1 ring-inset ring-cyan-400/30 transition hover:bg-cyan-400/20 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon name="target" className="size-3" />
      {id}
    </button>
  );
}

// ─── Acciones ────────────────────────────────────────────────────────────────

function ActionsPanel({
  actions,
  approvals,
  onApprove,
}: {
  actions: Action[];
  approvals: Record<string, number>;
  onApprove: (id: string) => void;
}) {
  const pending = actions.filter((a) => a.requiresApproval && !approvals[a.id]).length;
  return (
    <Panel
      title="Siguiente paso seguro"
      meta={
        pending > 0 ? (
          <span className="text-amber-300">{pending} pendientes de aprobación</span>
        ) : (
          `${actions.length} por prioridad`
        )
      }
    >
      {actions.length === 0 ? (
        <Empty>Sin acciones recomendadas.</Empty>
      ) : (
        <ol className="space-y-2 p-3">
          {actions.map((action) => {
            const approvedAt = approvals[action.id];
            return (
              <li
                key={action.id}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-300 ${
                  approvedAt
                    ? "border-emerald-500/30 bg-emerald-500/[0.05]"
                    : "border-white/[0.06] bg-white/[0.02]"
                }`}
              >
                <span
                  className={`mt-px rounded px-1.5 py-0.5 font-mono text-[11px] font-bold ring-1 ring-inset ${priorityStyle(action.priority)}`}
                >
                  P{action.priority}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium leading-snug text-zinc-100">{action.description}</p>
                  {(action.owner || action.rationale) && (
                    <p className="mt-1 text-xs leading-snug text-zinc-500">
                      {action.owner && <span className="text-zinc-400">{action.owner}</span>}
                      {action.owner && action.rationale && " · "}
                      {action.rationale}
                    </p>
                  )}
                </div>
                <div className="shrink-0 self-center">
                  {!action.requiresApproval ? (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                      Sin aprobación
                    </span>
                  ) : approvedAt ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-500/40">
                      <Icon name="check" />
                      Aprobada a las <span className="font-mono tabular-nums">{formatLocalTime(approvedAt)}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onApprove(action.id)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-inset ring-amber-400/40 transition hover:bg-amber-400 hover:text-zinc-950"
                    >
                      <Icon name="lock" className="size-3" />
                      Aprobar
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

// ─── Piezas compartidas ──────────────────────────────────────────────────────

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`${PANEL} shrink-0`}>
      <PanelHeader title={title} meta={meta} />
      {children}
    </section>
  );
}

function PanelHeader({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
      <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
      {meta && <span className="text-xs text-zinc-500">{meta}</span>}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const style = severityStyle(severity);
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset ${style.badge}`}
    >
      {style.label}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-4 text-sm text-zinc-500">{children}</p>;
}
