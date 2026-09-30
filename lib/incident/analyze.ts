import type {
  Action,
  AnalyzeResponse,
  Contradiction,
  Evidence,
  Finding,
  Heartbeat,
  Hypothesis,
  LogEvent,
  Seat,
  Severity,
  Signal,
} from "./types";

// Umbrales explícitos: cambiarlos cambia el diagnóstico, por eso viven aquí y no dispersos.
const RESTART_LOOP_MIN = 3; // reinicios sin boot posterior para considerar crash loop
const HEARTBEAT_STALE_MS = 60_000; // sin heartbeat por más de esto = seat desconectado
const SERVICE = "live-call-server";

export type IncidentInput = { events: LogEvent[]; seats: Seat[]; heartbeats: Heartbeat[] };

const ms = (iso: string) => Date.parse(iso);
const hhmmss = (iso: string) => `${iso.slice(11, 19)}Z`;
const list = (items: string[]) => items.join(", ");
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Confianza = prior + Σ pesos a favor − Σ pesos en contra, acotada a [0.02, 0.95]. */
function score(prior: number, evidenceFor: Evidence[], evidenceAgainst: Evidence[]) {
  const sum = (items: Evidence[]) => items.reduce((acc, e) => acc + e.weight, 0);
  return Number(clamp(prior + sum(evidenceFor) - sum(evidenceAgainst), 0.02, 0.95).toFixed(2));
}

function severityOf(event: LogEvent): Severity {
  const status = Number(event.fields.status);
  if (event.level === "ERROR") return /import|cannot find/i.test(event.message) ? "critical" : "high";
  if (/restarting service|HEALTHCHECK failed|HALTED/.test(event.message)) return "high";
  if (event.level === "WARN" || status >= 400) return "medium";
  return "info";
}

export function analyzeIncident({ events, seats, heartbeats }: IncidentInput): AnalyzeResponse {
  const sorted = [...events].sort((a, b) => ms(a.at) - ms(b.at));
  const server = sorted.filter((e) => e.source === "server");
  const deploy = sorted.filter((e) => e.source === "deploy");
  const carrier = sorted.filter((e) => e.source === "carrier");
  const find = (from: LogEvent[], pattern: RegExp) => from.find((e) => pattern.test(e.message));

  // ── Deploy y estado del servicio ──────────────────────────────────────────
  const candidate = find(deploy, /^DEPLOY candidate/);
  const preflight = find(deploy, /^PREFLIGHT passed/);
  const healthFailed = find(deploy, /^HEALTHCHECK failed/);
  const halted = find(deploy, /^DEPLOY HALTED/);
  const patchNote = find(deploy, /^NOTE /);
  const candidateBuild = candidate?.fields.build ?? "desconocido";
  const deployStart = candidate ? ms(candidate.at) : Number.POSITIVE_INFINITY;

  const importError = server.find((e) => e.level === "ERROR" && /cannot find (export|module)/i.test(e.message));
  const missingExport = importError ? /export '([^']+)'/.exec(importError.message)?.[1] : undefined;
  const brokenModule = importError?.fields.module;

  const restarts = server.filter((e) => /restarting service/.test(e.message));
  const boots = server.filter((e) => /^boot\b/.test(e.message));
  const lastRestart = restarts.at(-1);
  const crashLoop =
    restarts.length >= RESTART_LOOP_MIN && !boots.some((b) => lastRestart && ms(b.at) > ms(lastRestart.at));
  const lastGoodBoot = boots.filter((b) => ms(b.at) < deployStart).at(-1);
  const stableBuild = lastGoodBoot?.fields.build;

  const proxyHealth = server.filter(
    (e) => /health/.test(e.message) && e.fields.proxy && crashLoop && ms(e.at) > ms(restarts[0].at),
  );
  const benignWarns = server.filter((e) => e.level === "WARN" && Number(e.fields.loaded) === seats.length);
  const websocketErrors = server.filter((e) => e.level === "ERROR" && /websocket/.test(e.message));

  // ── Carriers: fallos de autenticación por carrier ─────────────────────────
  const authFailures = carrier.filter((e) => Number(e.fields.status) === 401);
  const failingCarriers = [...new Set(authFailures.map((e) => e.fields.carrier))];
  const healthyCarrierAfter = carrier.filter(
    (e) => !failingCarriers.includes(e.fields.carrier) && Number(e.fields.status) < 400 && ms(e.at) > deployStart,
  );

  // ── Heartbeats y seats ────────────────────────────────────────────────────
  const asOfMs = Math.max(...sorted.map((e) => ms(e.at)), ...heartbeats.map((h) => ms(h.lastSeen)));
  const asOf = new Date(asOfMs).toISOString();
  const byLastSeen = groupBy(heartbeats, (h) => h.lastSeen);
  const heartbeatSignals: Signal[] = [...byLastSeen].map(([lastSeen, group], i) => ({
    id: `hb-${String(i + 1).padStart(2, "0")}`,
    timestamp: lastSeen,
    source: "heartbeats",
    severity: ms(lastSeen) < deployStart ? "medium" : "info",
    message: `Último heartbeat de ${group.length} seat${group.length > 1 ? "s" : ""}: ${list(group.map((h) => h.seat))}`,
    ref: "client-heartbeats.json",
  }));
  const hbSignalFor = (seat: string) =>
    heartbeatSignals.find((s) => s.message.includes(seat))?.id ?? heartbeatSignals[0]?.id;
  const lostBeforeDeploy = heartbeats.filter((h) => ms(h.lastSeen) < deployStart).map((h) => h.seat);
  const lastHeartbeat = heartbeats.reduce((max, h) => (h.lastSeen > max ? h.lastSeen : max), "");
  const lastHeartbeatSignal = heartbeatSignals.find((s) => s.timestamp === lastHeartbeat)?.id;
  const preDeploySignal = lostBeforeDeploy.length ? hbSignalFor(lostBeforeDeploy[0]) : undefined;

  const builds = groupBy(heartbeats, (h) => h.build);
  const majorityBuild = [...builds].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const skewed = heartbeats.filter((h) => h.build !== majorityBuild);
  const skewSignal: Signal | undefined = skewed.length
    ? {
        id: `hb-${String(heartbeatSignals.length + 1).padStart(2, "0")}`,
        timestamp: skewed.reduce((max, h) => (h.lastSeen > max ? h.lastSeen : max), ""),
        source: "heartbeats",
        severity: "low",
        message: `${skewed.length} seats reportan build ${skewed[0].build} (el resto usa ${majorityBuild}): ${list(skewed.map((h) => h.seat))}`,
        ref: "client-heartbeats.json",
      }
    : undefined;

  const stale = new Set(heartbeats.filter((h) => asOfMs - ms(h.lastSeen) > HEARTBEAT_STALE_MS).map((h) => h.seat));
  const activeCallsAtRisk = seats.filter((s) => s.activeCall && stale.has(s.seat)).map((s) => s.seat);
  const agencies = [...groupBy(seats, (s) => s.agency)].map(([name, group]) => ({
    name,
    total: group.length,
    affected: group.filter((s) => stale.has(s.seat)).length,
  }));

  // ── Señales para la timeline ──────────────────────────────────────────────
  const signals: Signal[] = [
    ...sorted.map((e) => ({
      id: e.id,
      timestamp: e.at,
      originalTimestamp: e.originalTimestamp.endsWith("Z") ? undefined : e.originalTimestamp,
      source: e.source,
      severity: severityOf(e),
      message: e.level ? `${e.level} ${e.message}` : e.message,
      ref: `${e.file}:${e.line}`,
    })),
    ...heartbeatSignals,
    ...(skewSignal ? [skewSignal] : []),
  ].sort((a, b) => ms(a.timestamp) - ms(b.timestamp));

  const ids = (items: (LogEvent | Signal | undefined)[]) =>
    items.filter((x): x is LogEvent | Signal => Boolean(x)).map((x) => x.id);

  // ── Hallazgos: sabemos / inferimos / por verificar ────────────────────────
  const findings: Finding[] = [];
  const add = (certainty: Finding["certainty"], statement: string, signalIds: string[] = []) =>
    findings.push({ id: `f${findings.length + 1}`, certainty, statement, signalIds });

  const shifted = sorted.filter((e) => !e.originalTimestamp.endsWith("Z"));
  if (shifted.length) {
    const files = [...new Set(shifted.map((e) => e.file))];
    add(
      "known",
      `${list(files)} usa una zona horaria distinta de UTC (${shifted[0].originalTimestamp.slice(19)}). Normalizado, ${
        candidate ? `el deploy de ${candidateBuild} empieza a las ${hhmmss(candidate.at)}` : "se alinea con el resto"
      }.`,
      ids([shifted[0]]),
    );
  }
  if (importError) {
    add(
      "known",
      `${SERVICE} no encuentra el export '${missingExport}' en ${brokenModule} (${hhmmss(importError.at)}).`,
      ids([importError]),
    );
  }
  if (healthFailed && halted) {
    add("known", `El healthcheck falla y el deploy se detiene (${hhmmss(halted.at)}).`, ids([healthFailed, halted]));
  }
  if (crashLoop && lastRestart) {
    const span = Math.round((ms(lastRestart.at) - ms(restarts[0].at)) / 1000);
    add("known", `${restarts.length} reinicios de systemd en ${span} s sin ningún "boot" posterior.`, ids(restarts));
  }
  if (lastGoodBoot) {
    add("known", `Último arranque exitoso: build ${stableBuild} a las ${hhmmss(lastGoodBoot.at)}.`, ids([lastGoodBoot]));
  }
  add(
    "known",
    `${seats.length} seats en ${agencies.length} agencias; ${seats.filter((s) => s.activeCall).length} con llamada activa (${list(
      seats.filter((s) => s.activeCall).map((s) => s.seat),
    )}).`,
  );
  add(
    "known",
    `Ningún seat reporta heartbeat después de ${hhmmss(lastHeartbeat)}.${
      lostBeforeDeploy.length ? ` ${list(lostBeforeDeploy)} dejaron de reportar antes del deploy.` : ""
    }`,
    ids(heartbeatSignals),
  );
  for (const name of failingCarriers) {
    const first = authFailures.find((e) => e.fields.carrier === name)!;
    add(
      "known",
      `El carrier ${name} responde 401 (${first.fields.message ?? "sin detalle"}) desde ${hhmmss(first.at)}.`,
      ids(authFailures.filter((e) => e.fields.carrier === name)),
    );
  }

  if (crashLoop && importError) {
    add(
      "inferred",
      `El deploy de ${candidateBuild} dejó un artefacto parcial: ${SERVICE} no puede arrancar y quedó en crash loop. HALTED detuvo el pipeline, pero no revirtió el servicio.`,
      ids([candidate, importError, halted, lastRestart]),
    );
  }
  if (proxyHealth.length) {
    add(
      "inferred",
      `El /health 200 de ${hhmmss(proxyHealth[0].at)} viene de ${proxyHealth[0].fields.proxy}, no del origen: no demuestra que el servicio esté sano.`,
      ids(proxyHealth),
    );
  }
  add(
    "inferred",
    `Impacto: ${stale.size} de ${seats.length} seats sin conexión; ${activeCallsAtRisk.length} llamadas activas en riesgo.`,
    ids([lastHeartbeatSignal ? heartbeatSignals.find((s) => s.id === lastHeartbeatSignal) : undefined]),
  );
  for (const name of failingCarriers) {
    const first = authFailures.find((e) => e.fields.carrier === name)!;
    if (ms(first.at) < deployStart) {
      add(
        "inferred",
        `El fallo del carrier ${name} es un incidente separado: empieza antes del deploy${
          healthyCarrierAfter.length ? ` y ${healthyCarrierAfter[0].fields.carrier} sigue respondiendo 200` : ""
        }.`,
        ids([first, healthyCarrierAfter[0]]),
      );
    }
  }
  if (lostBeforeDeploy.length) {
    add(
      "inferred",
      `La desconexión de ${list(lostBeforeDeploy)} tiene otra causa: empezó antes del deploy.`,
      ids([heartbeatSignals.find((s) => s.id === preDeploySignal)]),
    );
  }

  add("verify", `Qué build está realmente en disco y ejecutándose (systemctl status ${SERVICE}).`);
  add("verify", "Si el origen responde consultándolo directo, sin pasar por el proxy.", ids(proxyHealth));
  add(
    "verify",
    "En qué momento se tomó la instantánea de heartbeats: si fue a las 13:05, los seats podrían seguir sanos.",
    ids([heartbeatSignals.find((s) => s.id === lastHeartbeatSignal)]),
  );
  if (activeCallsAtRisk.length) add("verify", `Estado real de las llamadas activas en ${list(activeCallsAtRisk)}.`);
  if (patchNote) add("verify", `Si el parche de ${hhmmss(patchNote.at)} fue compilado y probado antes de desplegarlo.`, ids([patchNote]));
  if (lostBeforeDeploy.length) add("verify", `Causa de la desconexión previa de ${list(lostBeforeDeploy)} (red o cliente).`);

  // ── Hipótesis con evidencia ponderada ─────────────────────────────────────
  const ev = (item: LogEvent | Signal | undefined, note: string, weight: number): Evidence[] =>
    item ? [{ signalId: item.id, note, weight }] : [];
  const hbLast = heartbeatSignals.find((s) => s.id === lastHeartbeatSignal);
  const hbPre = heartbeatSignals.find((s) => s.id === preDeploySignal);

  const hypotheses: Hypothesis[] = [];
  const hypothesis = (h: Omit<Hypothesis, "confidence">, prior: number) =>
    hypotheses.push({ ...h, confidence: score(prior, h.evidenceFor, h.evidenceAgainst) });

  if (importError) {
    const secondsAfter = candidate ? Math.round((ms(importError.at) - deployStart) / 1000) : undefined;
    hypothesis(
      {
        id: "h-deploy",
        title: `Deploy ${candidateBuild} incompleto: falta el export '${missingExport}' y ${SERVICE} no arranca`,
        description: "El único error de carga de código aparece segundos después de iniciar el deploy y coincide con el fallo del healthcheck y el crash loop.",
        evidenceFor: [
          ...ev(candidate, `El deploy empieza ${secondsAfter} s antes del error.`, 0.15),
          ...ev(importError, `Error de import en ${brokenModule}.`, 0.2),
          ...ev(healthFailed, `El healthcheck de ${SERVICE} falla.`, 0.1),
          ...ev(lastRestart, `${restarts.length} reinicios sin boot: el servicio no levanta.`, 0.15),
          ...ev(hbLast, "Ningún heartbeat después del deploy.", 0.05),
        ],
        evidenceAgainst: ev(proxyHealth[0], "/health responde 200, aunque vía proxy.", 0.05),
      },
      0.2,
    );
  }
  for (const name of failingCarriers) {
    const failures = authFailures.filter((e) => e.fields.carrier === name);
    hypothesis(
      {
        id: `h-carrier-${name.toLowerCase()}`,
        title: `Sesión expirada con el carrier ${name}`,
        description: "Es un problema real, pero afecta cotizaciones, no la conexión de los seats.",
        evidenceFor: [
          ...ev(failures[0], "401 session_expired.", 0.1),
          ...ev(failures[1], "Se repite en el siguiente intento.", 0.05),
        ],
        evidenceAgainst: [
          ...ev(hbLast, "El servicio seguía sano 3 min después del primer 401.", 0.15),
          ...ev(healthyCarrierAfter[0], "Otro carrier responde 200 durante el incidente.", 0.05),
          ...ev(importError, "La falla del servicio es un error de código, no de autenticación.", 0.1),
        ],
      },
      0.2,
    );
  }
  if (lostBeforeDeploy.length) {
    hypothesis(
      {
        id: "h-network",
        title: `Falla de red o de cliente en ${list(lostBeforeDeploy)}`,
        description: "Explica esos seats puntuales, no la caída general.",
        evidenceFor: [
          ...ev(hbPre, "Dejaron de reportar antes del deploy.", 0.15),
          ...ev(websocketErrors.find((e) => ms(e.at) < deployStart), "Timeout de reconexión previo al deploy.", 0.1),
        ],
        evidenceAgainst: [
          ...ev(hbLast, "El resto de los seats seguía conectado.", 0.1),
          ...ev(lastRestart, "El crash loop afecta a todo el servicio.", 0.1),
        ],
      },
      0.2,
    );
  }
  if (skewSignal) {
    hypothesis(
      {
        id: "h-build-skew",
        title: `Incompatibilidad del build de cliente ${skewed[0].build}`,
        evidenceFor: ev(skewSignal, "Hay seats con un build anterior.", 0.05),
        evidenceAgainst: [
          ...ev(hbLast, "Esos seats reportaban igual que el resto.", 0.1),
          ...ev(importError, "El error ocurre en el servidor, no en los clientes.", 0.05),
        ],
      },
      0.15,
    );
  }
  hypotheses.sort((a, b) => b.confidence - a.confidence);

  // ── Señales engañosas ─────────────────────────────────────────────────────
  const misleadingSignals = [
    ...proxyHealth.map((e) => ({
      signalId: e.id,
      reason: `Responde ${e.fields.proxy}, no el origen: antes hubo ${restarts.length} reinicios sin boot. Puede ser una respuesta del edge o de caché.`,
    })),
    ...benignWarns.map((e) => ({
      signalId: e.id,
      reason: `Tiene nivel WARN, pero loaded=${e.fields.loaded} coincide con los ${seats.length} seats de seats.json: es informativo.`,
    })),
    ...authFailures.map((e) => ({
      signalId: e.id,
      reason: `Ruidoso pero independiente: el carrier ${e.fields.carrier} falla antes del deploy y solo afecta cotizaciones.`,
    })),
    ...websocketErrors
      .filter((e) => ms(e.at) < deployStart)
      .map((e) => ({
        signalId: e.id,
        reason: "Ocurre antes del deploy: pertenece a la desconexión previa de un grupo de seats, no al crash loop.",
      })),
    ...(skewSignal
      ? [{ signalId: skewSignal.id, reason: "Esos seats reportaban heartbeat igual que el resto: no hay evidencia de impacto." }]
      : []),
  ];

  // ── Contradicciones ───────────────────────────────────────────────────────
  const contradictions: Contradiction[] = [];
  if (proxyHealth.length && lastRestart) {
    contradictions.push({
      description: `/health responde 200 vía ${proxyHealth[0].fields.proxy}, mientras el servicio no logra arrancar.`,
      signalIds: ids([proxyHealth[0], lastRestart]),
    });
  }
  if (preflight && importError) {
    contradictions.push({
      description: "El PREFLIGHT pasó, pero el build falla al cargar módulos segundos después: el preflight no valida el arranque.",
      signalIds: ids([preflight, importError]),
    });
  }
  if (halted && crashLoop) {
    contradictions.push({
      description: "El deploy quedó HALTED, pero systemd siguió reiniciando el servicio roto: detener no es revertir.",
      signalIds: ids([halted, restarts[0]]),
    });
  }
  const lateWebsocket = websocketErrors.filter((e) => ms(e.at) > deployStart && lostBeforeDeploy.includes(e.fields.seat));
  if (lateWebsocket.length) {
    contradictions.push({
      description: `${list(lateWebsocket.map((e) => e.fields.seat))} reportan websocket unavailable después del deploy, pero su último heartbeat es anterior al deploy.`,
      signalIds: ids([...lateWebsocket, hbPre]),
    });
  }

  // ── Acciones y follow-up ──────────────────────────────────────────────────
  const actions: Action[] = [
    {
      id: "verify-origin",
      priority: 1,
      requiresApproval: false,
      description: `Verificar el origen sin proxy y ejecutar systemctl status ${SERVICE}`,
      owner: "On-call",
      rationale: "Solo lectura: confirma si el servicio está caído y qué build ejecuta.",
    },
    ...(stableBuild
      ? [
          {
            id: "rollback",
            priority: 1,
            requiresApproval: true,
            description: `Rollback de ${SERVICE} a ${stableBuild}`,
            owner: "On-call + Incident Commander",
            rationale: `Último arranque sano (${hhmmss(lastGoodBoot!.at)}). Es más seguro que desplegar un parche sin validar.`,
          },
        ]
      : []),
    {
      id: "notify",
      priority: 2,
      requiresApproval: true,
      description: `Avisar a ${list(agencies.map((a) => a.name))}${
        activeCallsAtRisk.length ? ` y priorizar las llamadas activas (${list(activeCallsAtRisk)})` : ""
      }`,
      owner: "Incident Commander",
    },
    {
      id: "freeze",
      priority: 2,
      requiresApproval: false,
      description: `Congelar deploys de ${SERVICE} hasta que el parche pase un preflight con arranque real`,
      owner: "Release",
    },
    ...failingCarriers.map((name) => ({
      id: `carrier-${name.toLowerCase()}`,
      priority: 3,
      requiresApproval: true,
      description: `Renovar la sesión del carrier ${name} (incidente separado)`,
      owner: "Integraciones",
      rationale: "Requiere credenciales; no bloquea la recuperación del servicio.",
    })),
    ...(lostBeforeDeploy.length
      ? [
          {
            id: "seat-network",
            priority: 3,
            requiresApproval: false,
            description: `Revisar la conectividad de ${list(lostBeforeDeploy)}`,
            owner: "Soporte",
            rationale: "El problema es previo al deploy.",
          },
        ]
      : []),
  ];

  const followUp = [
    "El preflight debe arrancar el build y resolver imports (smoke boot), no solo validar el paquete.",
    "Si el healthcheck falla, el pipeline debe hacer rollback automático, no solo HALT.",
    "El healthcheck debe consultar el origen, no un endpoint detrás del proxy.",
    `Alertar cuando ningún seat reporte heartbeat durante más de ${HEARTBEAT_STALE_MS / 1000} s.`,
    ...(shifted.length ? [`Emitir todos los logs en UTC (${list([...new Set(shifted.map((e) => e.file))])} no lo hace).`] : []),
    ...(failingCarriers.length ? ["Monitorear la expiración de sesiones de carriers y renovarlas de forma proactiva."] : []),
    ...(skewed.length ? [`Política de versiones de cliente: ${skewed.length} seats siguen en ${skewed[0].build}.`] : []),
  ];

  const openedAt = importError?.at ?? healthFailed?.at ?? sorted[0]?.at ?? asOf;

  return {
    incident: {
      id: `INC-${openedAt.slice(0, 10).replaceAll("-", "")}-${openedAt.slice(11, 16).replace(":", "")}`,
      title: crashLoop ? `${SERVICE} caído tras el deploy ${candidateBuild}` : "Degradación sin causa confirmada",
      service: SERVICE,
      severity: activeCallsAtRisk.length || stale.size > seats.length / 2 ? "critical" : "high",
      openedAt,
      asOf,
    },
    signals,
    analysis: {
      summary: crashLoop
        ? `El deploy ${candidateBuild} dejó ${SERVICE} en un bucle de reinicios: al arrancar no encuentra el export '${missingExport}' en ${brokenModule}. El deploy se detuvo por healthcheck, pero no se revirtió; desde entonces ningún seat reporta heartbeat. El 200 de /health viene del proxy, no del origen.`
        : "No se detectó un crash loop del servicio; revisar hallazgos y señales.",
      impact: {
        summary: `${stale.size} de ${seats.length} seats sin conexión desde ~${hhmmss(lastHeartbeat)}. ${activeCallsAtRisk.length} llamadas activas en riesgo; probablemente no se pueden iniciar llamadas nuevas.`,
        certainty: "inferred",
        seatsTotal: seats.length,
        seatsAffected: stale.size,
        activeCallsAtRisk,
        agencies,
      },
      findings,
      hypotheses,
      misleadingSignals,
      contradictions,
      actions,
      followUp,
    },
  };
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}
