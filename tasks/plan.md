# Plan: Centro de Comando de Incidentes

Presupuesto: aproximadamente 45 minutos de implementación. El orden sigue las dependencias: contrato → parsers → motor → API → UI → verificación.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Vercel no incluye `docs/incident-command/` en la función | `outputFileTracingIncludes` en `next.config.ts` para `/api/analyze` |
| `bun:test` rompe el type-check de `next build` (no hay `@types/bun`) | Excluir `**/*.test.ts` en `tsconfig.json` (evita agregar una dependencia) |
| El motor termina "hardcodeado" a este dataset | Reglas genéricas por patrón (crash loop, auth expirada, heartbeats viejos, build skew, health vía proxy), con umbrales como constantes |
| Se acaba el tiempo | Las tareas 1 a 4 ya dejan una demo funcional; las tareas 5 y 6 se pueden recortar |

## Tareas

- [x] **T1: Contrato y parsers**
  - Acceptance: `parse.ts` convierte los 3 logs y los 2 JSON en `LogEvent[]` con `at` en UTC, `source`, `line` y campos key=value; `deploy.log` con `-05:00` queda en 13:04:50Z.
  - Verify: `bun test lib/incident/parse.test.ts`
  - Files: `lib/incident/types.ts`, `lib/incident/parse.ts`, `lib/incident/parse.test.ts`, `tsconfig.json`

- [x] **T2: Motor de análisis**
  - Acceptance: `analyze(events, seats, heartbeats)` produce:
    - los hallazgos de la spec, clasificados como known, inferred o verify;
    - las hipótesis con confianza calculada a partir de pesos de evidencia explícitos;
    - las señales engañosas con su motivo;
    - las contradicciones, el impacto, las acciones por prioridad y el follow-up.
  - Verify: `bun test lib/incident/analyze.test.ts` (asserts de la tabla "Resultado esperado")
  - Files: `lib/incident/analyze.ts`, `lib/incident/analyze.test.ts`

- [x] **T3: API**
  - Acceptance: `GET /api/analyze` devuelve 200 con el contrato; si falta un archivo, devuelve 500 con un mensaje claro.
  - Verify: `curl localhost:3000/api/analyze | head`
  - Files: `lib/incident/load.ts`, `app/api/analyze/route.ts`, `next.config.ts`

- [x] **T4: Adaptar el dashboard**
  - Acceptance: usa los tipos compartidos. Agrega el panel "Sabemos / Inferimos / Por verificar", los KPIs de impacto en el banner, la referencia `file:line` en cada señal y la duración calculada contra `asOf`.
  - Verify: dev server + capturas headless a 1440×900; sin errores de consola.
  - Files: `app/page.tsx`

- [x] **T5: Verificación y README**
  - Acceptance: `bun test`, lint (`app/`, `lib/`) y build en verde. El README explica cómo correrlo, las decisiones, las limitaciones y los siguientes pasos.
  - Files: `README.md`

- [ ] **T6: Commit** (requiere visto bueno). El push a GitHub y el deploy en Vercel los hace el usuario.

## Después del código (si queda tiempo)

- Borradores de las 4 respuestas escritas, basados en lo construido, para que el usuario las revise y adapte.
- Investigación del reto de screen sharing (iOS, Android y desktop) con fuentes citadas.
