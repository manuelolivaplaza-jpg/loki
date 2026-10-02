# PROGRESO de Loki (traspaso a Forja nuevo)

Actualizado: 02-10-2026 ~02:45 (hora de Chile, UTC-3), tras la tanda de prompts 7-16.

## Datos básicos
- **Proyecto:** `C:\Users\manue\OneDrive\Desktop\loki` (PC de Manu, Windows + PowerShell).
- **Rama:** `main`. Commits de p07-p15 y este doc son **locales, sin push** (`origin/main` no los tiene). No hacer push sin OK de Manu.
- **Modelo de opencode:** la tanda p10-p16 corrió con `muse-spark-1.3-contributor-free` (`--auto`, log en `.forja\pNN.log` terminado en `EXIT n`; estado en `.forja\pseq-status.txt`). p16 terminó por **"Rate limit exceeded"** (EXIT 1), igual que pasó en T16: muse-spark corta en sesiones largas.
- **Stack:** Next.js 15 (export estático) + TypeScript estricto + Tailwind + shadcn/ui + Capacitor (Android). Supabase local vía CLI dentro de WSL2 Ubuntu con Docker Engine (`scripts/supabase.mjs`).

## Tanda de prompts 6-16 (01-10 18:00 → 02-10 02:40)

| Prompt | Tema | Estado | Commit(s) |
|---|---|---|---|
| 6 | Tareas recurrentes y turnos rotativos | **NO hecho**: no hay commit, rama, stash, migración ni archivos (`recurr*`/`turno*`) de p06. HEAD antes de p07 era `21d313e` (prompt 5, listas). | — |
| 7 | Encuestas y decisiones rápidas en el chat | Hecho | `702faf8` + `86e800b` (completar) |
| 8 | Notas de voz que se vuelven acción | Hecho | `1bbf109` + `f9b9aa2` (completar) |
| 9 | Memoria del espacio | Hecho | `56a9868` + `fb41b23` (completar) |
| 10 | Búsqueda universal | Hecho | `1265b3c` |
| 11 | Resumen diario | Hecho | `1002d3e` |
| 12 | Agentes personales: registro, permisos y contrato | Hecho | `44f837a` |
| 13 | Agentes en el chat: menciones, ejecución por eventos y adaptadores | Hecho | `6b76812` |
| 14 | Control del PC (1/2): emparejamiento, permisos, comandos y auditoría | Hecho | `9e6a698` |
| 15 | Control del PC (2/2): compañero de escritorio para Windows | Hecho | `ff8d7d6` |
| 16 | Verificación y regresión completa | **Incompleto** (EXIT 1, rate limit, 01:02 → 02:40, ~98 min). Arreglos **sin commit** en el árbol. | — |

- Stash `stash@{0}`: **"p09c parcial (descartado)"** (no aplicar). Rama local `p09c-descartado` apunta a `fb41b23`.
- `.forja\orphan-p10-spacebunny\`: archivos de una sesión space-bunny huérfana de p10 (apartados, no usados).

## Resultado de p16 (verificación) — estado al cortar

| Chequeo | Resultado |
|---|---|
| `npm run sb:reset` | **OK** (tras arreglos): aplican las 22 migraciones, incluida la nueva `20261015000000_reparacion_verificacion.sql`. Antes fallaba en `polls` (helpers `language sql` antes de crear la tabla) y en `agents` (política que usaba `agent_space_grants` antes de crearla); se reordenaron esas migraciones. |
| `npm run typecheck` | **OK** (0) tras arreglar ~40 errores de p12-p15 (`IconSize` con números, `run`/`prefs`/`device` posiblemente null, `Json`, hooks de agentes). |
| `npm run lint` | **OK** (0 errores, 12 warnings preexistentes). |
| `npm run test:unit` | **OK**: mentions 70, preview 8, intent 105 (se corrigieron tests y el intent de "mi PC"). |
| `npm run test:rls` | **FALLA: 169/178** (de 27 fallos bajó a 9). |
| `npm run build` | **No se corrió** (p16 cortó antes). |
| `npm run build:capacitor` | **No se corrió**. |

**Arreglado en p16 (sin commit):** orden de las migraciones `polls`, `agents` y `devices`; migración nueva de reparación (recursión infinita en políticas de agentes, `poll_electors` leído como `e.user_id`, `on conflict` que no casaba con el índice parcial de `ai_jobs` en transcripciones/OCR, palabras con tilde en la memoria, PC revocado que seguía leyendo su ficha y sus comandos); typecheck, lint y tests unitarios; ajustes en tests RLS (`daily_digest`, `memories`, `search`).

**Sigue roto (9 tests RLS, 4 focos):**
1. **Agentes – INSERT de `agent_runs`** (6 tests: pedir ejecución, abrir grant, resultado privado, eventos, cancelar, `message_id`): `insert ... returning` da 42501. Causa confirmada: la función `agent_can_read_run` (SECURITY DEFINER, `stable`) no ve la fila recién insertada al evaluar la política SELECT en el RETURNING. Falta el arreglo (p. ej. política SELECT que no dependa de releer la fila, o no pedir `returning`/`select` en el insert).
2. **Encuestas – tick** "cierra lo vencido y avisa UNA vez a quien no votó".
3. **Búsqueda – DM ajeno/sensible** sale en `global_search`: el parser deja `regalo-secreto.png` como un solo token; revisar los predicados de adjuntos en `20261010000000_search_all.sql` (líneas ~763 y ~1060).
4. **Transcripciones – DM:** el otro miembro del DM no ve la transcripción.

**Restos de diagnóstico de p16 (limpiar):**
- Archivos sueltos sin seguimiento en la raíz: `diag-fn*.sql`, `diag-pol*.sql`, `diag-seq*.sql` (13). No commitear; borrarlos.
- La base **local** quedó con objetos de depuración creados a mano (política `debug_p` en `agent_runs`, tabla `debug_log`, secuencias `seq_dbg_*`, funciones de diagnóstico, `grant select on agent_runs`). Un `npm run sb:reset` la deja limpia. PostgREST local (`supabase_rest_loki`) se reinició una vez.

## Pendientes para Manu (tras esta tanda)
- Decidir cómo terminar p16: relanzar un "p16c" (ojalá con un modelo sin rate limit) para cerrar los 4 focos RLS, correr `build` y `build:capacitor`, y commitear `p16: Verificacion y regresion completa`. Los 22 archivos modificados + la migración nueva siguen sin commit.
- **Prompt 6 (tareas recurrentes y turnos rotativos) nunca se hizo**: decidir si se corre ahora (encima de p16) o se descarta.
- Revisar y aprobar el push de p07-p16 a `origin/main` (todo local por ahora).
- Lo de siempre: clave de IA, Google OAuth, FCM real, prueba en teléfono, RAM de WSL (ver "Pendientes y bloqueos").

## Terminado (hashes)
- T1–T9 (scaffold, tokens Grok, shell, Firebase inicial, auth, onboarding, espacios, navegación): `5b58d0f` … `ab4fc29`.
- T10 `df1a73a` · T11 `09ee46d` (Capacitor) · T12 `6598258` · T13 `5b40ce8` · T14 `6f6307d` · T15 `34d9f21`.
- T16 `263eccf` · T17 `10a8d0b` · T18 `08ea3be` (verificados con E2E y capturas por Loki).
- T19 `8711c5c`: Supabase local, esquema, RLS, triggers y Storage (verificado: sb:reset, RLS 55/55, typecheck, lint, build y cap en 0).
- **T20–T36 en un solo commit `f4eb6c2`** ("T34-T36: Pulido, calidad y lanzamiento", 209 archivos), con Auth (T20, que ya no queda sin commit), chats, IA, FCM, calendario, proyectos, notificaciones, invitaciones, búsqueda, PWA, pulido, CI y docs.
- Después (Manu): `ecd83f9` arreglo del bundle Deno · `466be8b` canal realtime compartido · `4d8b40b`/`772a95f`/`85534fe`/`f54f321` sidebar · `a45cee6` Google Calendar bidireccional · `615ec76` apikey en Edge · `c8d4ba6` realtime auto-recuperable · `836699d`/`1b473ff`/`d1af2f4` invitar y unirse · `51a3ee5`/`0c17c0f`/`9615d6c` GCal · `8037776` chat · `54cd726` rediseño del calendario · `8e9d2fb`/`072d7e0` push · `eaf5c45`/`d12ef59` Android · `21d313e` listas · `702faf8` **p07: encuestas (datos, tipos y RLS; la UI quedó a medias)** · `1bbf109` p08 notas de voz.
- **Prompts 7-15** (tanda Forja 01-10/02-10): `702faf8`/`86e800b` p07 · `1bbf109`/`f9b9aa2` p08 · `56a9868`/`fb41b23` p09 · `1265b3c` p10 · `1002d3e` p11 · `44f837a` p12 · `6b76812` p13 · `9e6a698` p14 · `ff8d7d6` p15 (HEAD de código). p16 sin commit (ver arriba).
- Verificado el 01-10 ~05:35 en `d12ef59`: `npm run typecheck` en 0, árbol limpio. Build, lint y test:rls **no** se corrieron en este traspaso (opencode de Manu activo).

## Tarea en curso
- Sin tarea de Forja en curso. p16 quedó a medias (EXIT 1 por rate limit, 02-10 02:40) con arreglos sin commit en el árbol.
- Hay 2 procesos opencode de Manu activos desde 01-10 04:12 (`opencode` y `opencode serve --service`). **No matarlos.**
- Migraciones: `20260929000000_init` · `20260930000000_organizer` · `…01_ai_tools` · `…02_storage` · `…03_search` · `…04_negatives_fix` · `…05_gcal` · `20261001000000_push_direct` · `20261003000000_ai_infra` · `20261004000000_loki_actions` · `20261005000000_convert_digest` · `20261006000000_lists` · `20261007000000_polls` · `20261008000000_transcriptions` · `20261009000000_space_memories` · `20261010000000_search_all` · `20261011000000_daily_digest` · `20261012000000_agents` · `20261013000000_agents_chat` · `20261014000000_devices` · `20261015000000_reparacion_verificacion` (nueva de p16, sin commit).
- Edge Functions: `loki-chat`, `loki-worker`, `push-send`, `google-calendar`, `agent-callback`, `agent-connections`, `agent-dispatch`, `agent-task`, `device-pair` (secretos en `supabase/functions/.env`, gitignored; plantilla `.env.example`, ahora con `STT_*`).

## Próximas 5 tareas (criterio de aceptación)
1. **Cerrar p16 (regresión completa):** limpiar `diag-*.sql`, `npm run sb:reset` aplica las 22 migraciones; arreglar los 9 tests RLS (agent_runs insert+returning, tick de encuestas, búsqueda en DM, transcripción en DM); `typecheck`, `lint`, `test:unit`, `test:rls`, `build` y `build:capacitor` en 0; commit local `p16: Verificacion y regresion completa`.
2. **Loki IA real** (requiere la clave de Manu): con `LLM_PROVIDER/LLM_MODEL/LLM_API_KEY` en `supabase/functions/.env` y `npm run sb:functions`, `/health` da `configured:true`, Loki IA responde en streaming y queda un mensaje `type ai`; @Loki responde en grupo. Sin clave: "Loki IA sin configurar", sin errores.
3. **Push real en Android:** con `FCM_SERVICE_ACCOUNT` (secreto) y la config web/VAPID en `.env.local` (fuera del repo), un mensaje nuevo llega como notificación al teléfono. Sin config: "Notificaciones no configuradas". `typecheck && build && build:capacitor` en 0.
4. **Adjuntos y voz visibles** (README: "UI de adjuntos deshabilitada, buckets listos"): subir imagen, archivo y nota de voz a Storage con RLS por espacio y verlos en chat y publicaciones; `test:rls` verde y build en 0.
5. **Pequeños pendientes de datos y UI:** columna `kind` (familia/equipo) en `workspaces` con migración NUEVA (hoy va en localStorage, ver `src/lib/data/workspaces.ts`) y mensaje en español para contraseña corta (hoy lo bloquea el `minLength` nativo). Aceptación: `test:rls`, `typecheck` y `build` en 0.
   (Fuentes: `ROADMAP-4-PROMPTS.md`, `ROADMAP-PROMPTS.md` y la sección "Qué falta" de `README.md`; revisar si alguno ya lo resolvió Manu, por ejemplo "unirse con código", que parece hecho en `1b473ff`.)

## Decisiones tomadas
- **Base de datos:** Supabase (Postgres + RLS + Realtime + Storage + Edge Functions). **Firebase solo para FCM** (push). En `src/` no queda ningún import de `firebase/firestore` ni `firebase/auth`.
- **Loki IA real** vía la Edge Function `loki-chat` (proveedor por `LLM_PROVIDER`: openai, anthropic o gemini). **Sin respuestas simuladas**: sin clave se muestra "Loki IA sin configurar".
- **Diseño claro estilo Grok Bot:** fondo `#FFFFFF`, superficies `#F0F0F0`/`#F7F9F9`, texto `#0F1419`/`#536471`, bordes `#EFF3F4`, accent `#00B4D8`, menciones `#1D9BF0`, oscuro true black opcional, Inter, lucide stroke 1.75.
- **No hacer push ni deploy sin OK de Manu.** No usar servicios reales (nada de `supabase link`/`db push`/`login` ni proyectos Firebase reales) sin permiso. Nunca claves en el código ni la service_role en `NEXT_PUBLIC_`.
- Commit local por tarea verificada; nada de `reset --hard` ni force push; no tocar los contenedores ajenos (open-webui, onecli) ni `.wslconfig`.

## Pendientes y bloqueos (dependen de Manu)
- **Clave de IA** (`LLM_API_KEY`): sin ella solo funciona el camino "sin configurar".
- **Google OAuth:** el login con Google necesita credenciales en Supabase Auth; sin ellas el botón avisa "Google no está configurado en este entorno". Google Calendar (`a45cee6`) también necesita su client id y secret como secretos.
- **FCM real:** proyecto Firebase solo para push, `FCM_SERVICE_ACCOUNT` y VAPID; README dice que `push-send` no tiene trigger activo (confirmar tras `8e9d2fb`).
- **Capacitor en dispositivo:** `android/` existe; falta probar en un teléfono real (barra de estado, teclado y push).
- **RAM de WSL** (~3,7 GB, open-webui usa ~770 MB): Supabase corre con servicios reducidos; más memoria requiere permiso para tocar `.wslconfig`.
- **Columna del tipo de espacio** (`kind`) en localStorage, sin columna en la base.
- **Aviso de contraseña corta:** lo bloquea el `minLength` nativo y no aparece el mensaje en español.

## Comandos de verificación (existen en package.json)
- `npm run typecheck` (tsc --noEmit) · `npm run lint` (eslint) · `npm run build` (next build) · `npm run build:capacitor`
- `npm run test:unit` (mentions + preview) · `npm run test:rls` (necesita Supabase local arriba)
- `npm run dev` (puerto 3000; apagarlo antes de `build`, porque comparten `.next`)
- `npm run sb:start` · `npm run sb:stop` · `npm run sb:status` · `npm run sb:reset` · `npm run sb:functions`
- Extras: `npm run check-env`, `npm run icons`.

## Archivos de apoyo
- `.forja/`: `run.ps1` (lanza opencode), `verify.ps1` (typecheck, lint y build), `e2e.ps1` (E2E en 4 variantes en el puerto 3100), `plan-supabase.md`, `fase3.md`, `tNN.prompt.txt` y `tNN.log` (historial por tarea), `tNN-test.js` (E2E con Playwright y msedge), `screens/`, `ROADMAP-PROMPTS.largo.md` (roadmap original largo).
- Roadmaps en la raíz: `ROADMAP-PROMPTS.md` (16 prompts cortos, T21–T36) y `ROADMAP-4-PROMPTS.md` (4 prompts por bloques). Ambos ya se ejecutaron.
