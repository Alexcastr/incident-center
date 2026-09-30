# Spec: Centro de Comando de Incidentes

> SDD parcial: esta spec y `tasks/plan.md` se aprueban juntas en un único gate por la restricción de 60 minutos.

## Objetivo

Una herramienta web que, a partir de las fuentes de observabilidad de `docs/incident-command/`, ayuda a un ingeniero de guardia a:

1. **Detectar** el incidente (qué está roto y desde cuándo).
2. **Correlacionar** eventos de fuentes distintas en una sola línea de tiempo normalizada a UTC.
3. **Estimar el impacto** sobre usuarios (seats, agencias, llamadas activas).
4. **Identificar una causa probable** con evidencia a favor y en contra, sin asumir que el error más ruidoso es la causa.
5. **Recomendar el siguiente paso seguro**, separando acciones de solo lectura de las que requieren aprobación.

Y en todo momento deja explícito **qué sabemos** (hecho observado en un log), **qué inferimos** (conclusión razonada) y **qué falta verificar**.

Usuario: ingeniero de guardia durante un incidente activo. Éxito: en menos de 30 segundos entiende la causa probable, el impacto y la siguiente acción segura, y puede rastrear cada afirmación hasta la línea de log que la respalda.

## Supuestos

1. **Se reutiliza la base del dashboard existente** (`app/page.tsx`) y se adapta a lo que pide el reto: panel Sabemos / Inferimos / Por verificar, KPIs de impacto, trazabilidad `archivo:línea` y tiempos en UTC. No existe backend, parsers ni motor: se construyen desde cero. *(Aprobado)*
2. **El motor de análisis es determinista** *(Aprobado)* (reglas explícitas en TypeScript), sin LLM: es reproducible, testeable, no requiere API keys y cada conclusión es auditable. Un LLM queda como trabajo futuro.
3. **"Ahora" es el último evento observado** (`asOf` = 13:09:44Z), no el reloj real, porque los datos son históricos o sintéticos.
4. Los datos se leen del disco en el servidor desde `docs/incident-command/`; no hay carga de archivos por el usuario en esta versión.
5. El deploy de la demo es en Vercel, importando el repo desde GitHub (paso del usuario).

## Resultado esperado del análisis (criterio de aceptación del motor)

| Tipo | Afirmación | Evidencia |
|---|---|---|
| Sabemos | `deploy.log` usa `-05:00`; normalizado, el deploy de `2026.09.29.5` inicia a las 13:04:50Z | deploy.log L1 |
| Sabemos | Error de import `normalizeCallIndex` a las 13:05:18Z; healthcheck falla y el deploy se detiene | server.log, deploy.log |
| Sabemos | 4 reinicios de systemd en 15 s y ningún `boot` posterior | server.log |
| Sabemos | 20 seats en 2 agencias; 3 con llamada activa (S002, S005, S011) | seats.json |
| Sabemos | Ningún heartbeat después de 13:04:55Z; S003, S007 y S014 sin heartbeat desde 13:03:00Z | client-heartbeats.json |
| Inferimos | Causa probable: artefacto parcial del deploy detenido que deja `live-call-server` en crash loop | correlación temporal (menos de 30 s) |
| Inferimos | `/health 200 proxy=cloudflare` no refleja el origen: señal **engañosa** | contradice el crash loop |
| Inferimos | El 401 del carrier Beta es un incidente **independiente** (empieza antes del deploy; Alpha sigue en 200) | carrier.log |
| Inferimos | La caída de S003, S007 y S014 empieza **antes** del deploy, así que tiene otra causa | heartbeats, server.log |
| Verificar | Qué build está realmente en disco; salud del origen sin pasar por Cloudflare; hora de la instantánea de heartbeats; estado de las 3 llamadas activas; si el parche de las 13:07:10 fue probado | — |

Siguiente paso seguro: (1) verificar el origen sin Cloudflare y el estado del servicio (solo lectura); (2) **rollback a `2026.09.29.4`** (último boot sano, 13:00:02Z; requiere aprobación). **No** desplegar el parche hacia adelante sin un preflight que cargue los módulos.

## Stack

Next.js 16.3 (App Router, Turbopack), React 19, TypeScript estricto, Tailwind v4, Bun 1.3. **Sin dependencias nuevas.** Tests con `bun test`, el runner integrado de Bun.

## Comandos

```
Dev:   bun run dev
Build: bun run build
Lint:  bun run lint
Test:  bun test
```

## Estructura

```
docs/incident-command/     → datos del reto (solo lectura, no se modifican)
lib/incident/types.ts      → contrato compartido API ↔ UI
lib/incident/parse.ts      → parsers puros: logs key=value, JSON, normalización de zonas horarias
lib/incident/analyze.ts    → motor de reglas puro: señales → hallazgos, hipótesis, impacto y acciones
lib/incident/load.ts       → lectura de archivos (solo servidor)
lib/incident/*.test.ts     → tests unitarios (bun test)
app/api/analyze/route.ts   → GET: carga, analiza y devuelve JSON
app/page.tsx               → dashboard (cliente)
```

## Estilo de código

Funciones puras y tipadas; el I/O queda aislado en `load.ts`. Cada regla devuelve evidencia con referencia a su origen (`file:line`), por ejemplo:

```ts
export function detectCrashLoop(events: LogEvent[]): Detection | null {
  const restarts = events.filter((e) => e.source === "server" && /restarting service/.test(e.message));
  const bootAfter = events.some((e) => e.kind === "boot" && e.at > restarts.at(-1)!.at);
  if (restarts.length < 3 || bootAfter) return null;
  return { id: "crash-loop", evidence: restarts.map((e) => e.id) /* … */ };
}
```

## Testing

`bun test` sobre los parsers (zonas horarias, key=value, líneas inválidas) y el motor (la tabla de "Resultado esperado" como aserciones). La UI se verifica con build, lint y capturas headless.

## Límites

- **Siempre:** normalizar los tiempos a UTC; enlazar cada conclusión con su evidencia; correr `bun test`, lint y build antes de dar algo por terminado.
- **Preguntar primero:** agregar dependencias, crear el repo remoto, hacer push o deploy.
- **Nunca:** modificar los archivos de `docs/incident-command/`, inventar datos que no estén en las fuentes, presentar una inferencia como hecho.

## Criterios de éxito

1. `GET /api/analyze` devuelve el análisis de la tabla anterior a partir de los archivos reales, sin datos hardcodeados de las conclusiones.
2. El dashboard muestra:
   - una timeline unificada en UTC con filtros por fuente;
   - un panel **Sabemos / Inferimos / Por verificar**;
   - KPIs de impacto;
   - hipótesis con evidencia enlazada;
   - contradicciones;
   - acciones con aprobación.
3. Las señales engañosas (Cloudflare health, carrier Beta, WARN seat_map, build viejo) aparecen marcadas con su porqué.
4. `bun test`, `bun run lint` (sobre `app/` y `lib/`) y `bun run build` pasan.
5. Un README explica cómo correrlo, las decisiones y las limitaciones.

## Fuera de alcance

Carga de logs por el usuario, LLM, persistencia, autenticación y tiempo real.
