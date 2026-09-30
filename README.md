# Centro de Comando de Incidentes

Herramienta para un ingeniero de guardia. Lee las fuentes de observabilidad de [`docs/incident-command/`](docs/incident-command/), las correlaciona en una sola línea de tiempo en UTC y responde:

- ¿Qué está roto y desde cuándo?
- ¿A cuántos usuarios afecta?
- ¿Cuál es la causa probable y qué evidencia la respalda o la contradice?
- ¿Cuál es el siguiente paso seguro?

Cada afirmación se clasifica como **Sabemos** (observado en una fuente), **Inferimos** (conclusión razonada) o **Por verificar**, y enlaza a la línea de log que la respalda (`server.log:5`).

## Cómo correrlo

```bash
bun install
bun run dev      # http://localhost:3000
bun test         # tests del parser y del motor
bun run build
```

`GET /api/analyze` devuelve el análisis completo en JSON.

## Qué encuentra en los datos del reto

- **Causa probable (80 %):** el deploy `2026.09.29.5` dejó `live-call-server` en un crash loop. Al arrancar no encuentra el export `normalizeCallIndex` en `call-index.js`. El healthcheck detuvo el deploy (HALTED), pero no lo revirtió: siguen 4 reinicios sin ningún `boot`.
- **Trampa de zona horaria:** `deploy.log` está en `-05:00`. Sin normalizar, el deploy parece ocurrir 5 h antes del error; en UTC empieza 28 s antes.
- **Señales engañosas:**
  - `/health 200 proxy=cloudflare` llega desde el proxy, no desde el origen.
  - El `401` del carrier Beta y la caída de S003, S007 y S014 empiezan *antes* del deploy: son incidentes aparte.
  - El `WARN seat_map loaded=20` es informativo.
  - Los 5 seats con build viejo reportan igual que el resto.
- **Impacto (inferido):** 20 de 20 seats de 2 agencias sin heartbeat desde las 13:04:55Z y 3 llamadas activas en riesgo (S002, S005, S011).
- **Siguiente paso seguro:**
  1. Verificar el origen sin proxy (solo lectura).
  2. Rollback a `2026.09.29.4`, el último arranque sano (requiere aprobación).
  3. No desplegar el parche hacia adelante sin un preflight que arranque el servicio.

## Decisiones

- **Motor determinista, sin LLM.** Son reglas explícitas por patrón: crash loop, fallos de autenticación, heartbeats viejos, build skew y health vía proxy. Es reproducible, testeable, no necesita API keys y cada conclusión es auditable.
- **La confianza se calcula, no se inventa.** Es `prior + Σ pesos a favor − Σ pesos en contra`, y la UI muestra el peso de cada evidencia.
- **El análisis usa como "ahora" el último evento observado** (`asOf`), porque los datos son históricos. La interfaz sí es en vivo: el tiempo abierto corre con el reloj real y el análisis se refresca cada 15 s (se puede pausar).
- **Parsers puros y I/O aislado.** [`parse.ts`](lib/incident/parse.ts) y [`analyze.ts`](lib/incident/analyze.ts) no tocan el disco; solo [`load.ts`](lib/incident/load.ts) lee archivos. El contrato API ↔ UI vive en [`types.ts`](lib/incident/types.ts).
- **Sin dependencias nuevas.** Los tests usan `bun test`, el runner integrado de Bun.

La spec y el plan están en [`SPEC.md`](SPEC.md) y [`tasks/plan.md`](tasks/plan.md).

## Limitaciones

- Las reglas son genéricas por patrón, pero se calibraron con un solo dataset. Formatos de log distintos requieren nuevos parsers.
- No se sabe cuándo se tomó la instantánea de heartbeats, así que el impacto de 20/20 es una inferencia. El panel lo marca como pendiente de verificación.
- No hay carga de archivos, tiempo real ni persistencia. Las aprobaciones son estado local.
