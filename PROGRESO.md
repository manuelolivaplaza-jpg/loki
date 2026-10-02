# PROGRESO de Loki (traspaso a Forja nuevo)

Actualizado: 02-10-2026 ~03:50 (hora de Chile, UTC-3), tras cerrar p16 con p16c.

## Datos básicos
- **Proyecto:** `C:\Users\manue\OneDrive\Desktop\loki` (PC de Manu, Windows + PowerShell).
- **Rama:** `main`. Commits de p07-p15 y este doc son **locales, sin push** (`origin/main` no los tiene). No hacer push sin OK de Manu.
- **Modelo de opencode:** la tanda p10-p16 corrió con `muse-spark-1.3-contributor-free` (`--auto`, log en `.forja\pNN.log` terminado en `EXIT n`; estado en `.forja\pseq-status.txt`). p16 terminó por **"Rate limit exceeded"** (EXIT 1), igual que pasó en T16: muse-spark corta en sesiones largas. El cierre **p16c** corrió con `opencode/space-bunny-free` (EXIT 0, 03:09 → 03:44, ~35 min).
- **Stack:** Next.js 15 (export estático) + TypeScript estricto + Tailwind + shadcn/ui + Capacitor (Android). Supabase local vía CLI dentro de WSL2 Ubuntu con Docker Engine (`scripts/supabase.mjs`).

## Tanda de prompts 6-16 (01-10 18:00 → 02-10 02:40)

| Prompt | Tema | Estado | Commit(s) |
|---|---|---|---|
| 6 | Tareas recurrentes y turnos rotativos | **Hecho (tanda posterior a p16)**: migración `20261017000000_tareas_recurrentes_turnos.sql`, UI (hoja de tarea, vista Turnos, "Te toca hoy"), Loki (serie/turnos sin modelo) y tests RLS nuevos | local, sin commit |
| 7 | Encuestas y decisiones rápidas en el chat | Hecho | `702faf8` + `86e800b` (completar) |
| 8 | Notas de voz que se vuelven acción | Hecho | `1bbf109` + `f9b9aa2` (completar) |
| 9 | Memoria del espacio | Hecho | `56a9868` + `fb41b23` (completar) |
| 10 | Búsqueda universal | Hecho | `1265b3c` |
| 11 | Resumen diario | Hecho | `1002d3e` |
| 12 | Agentes personales: registro, permisos y contrato | Hecho | `44f837a` |
| 13 | Agentes en el chat: menciones, ejecución por eventos y adaptadores | Hecho | `6b76812` |
| 14 | Control del PC (1/2): emparejamiento, permisos, comandos y auditoría | Hecho | `9e6a698` |
| 15 | Control del PC (2/2): compañero de escritorio para Windows | Hecho | `ff8d7d6` |
| 16 | Verificación y regresión completa | **Hecho**: p16 (EXIT 1, rate limit, 01:02 → 02:40) + p16c (EXIT 0, space-bunny-free, 03:09 → 03:44). Todo en verde. | `c0b3a31` |

- Stash `stash@{0}`: **"p09c parcial (descartado)"** (no aplicar). Rama local `p09c-descartado` apunta a `fb41b23`.
- `.forja\orphan-p10-spacebunny\`: archivos de una sesión space-bunny huérfana de p10 (apartados, no usados).

## Prompt 6 · tareas recurrentes y turnos rotativos (hecho sobre p16, sin verificar)

Migración nueva `supabase/migrations/20261017000000_tareas_recurrentes_turnos.sql` (nunca se editó
ninguna anterior):

- `task_series` (plantilla + regla acotada + zona + rotación `uuid[]` con índice, pausas/saltos en
  `jsonb`, `next_occurrence`/`last_occurrence` guardados por trigger) y `tasks.series_id` /
  `tasks.series_occurrence`; `shift_swaps` para "¿me cambias el turno?".
- Las ocurrencias son **tareas normales**: el kanban, Inicio, la búsqueda y `create_due_reminders`
  siguen funcionando sin cambios.
- Generación por eventos y sin LLM: trigger al insertar la serie, trigger al completar una
  ocurrencia y pg_cron (`materialize_series_occurrences`, horizonte de 1 día). Regla de recurrencia en
  `date` + `AT TIME ZONE` (el horario de verano lo aplica Postgres, no un offset fijo).
- Avisos tipo `shift` (`create_shift_reminders`, pg_cron, dedupe): día antes, el día y "se te pasó".
  `push-send` ya mapea el tipo al interruptor `notification_prefs.shift`.
- `create_daily_digests()` se redefinió en esta migración para rellenar el conteo de turnos que p11
  dejó en 0 ("hasta que lleguen las tablas"); el job y su nombre siguen igual.
- Permisos: serie propia o cualquier admin; un intercambio solo lo resuelven los dos
  involucrados; quien sale del espacio sale de la rotación y se avisa al creador. Tests nuevos en
  `tests/rls/recurring.test.mjs`.
- Front: `src/types/recurring.ts`, `src/lib/recurring/recurrence.ts` (espejo de las funciones SQL),
  `src/lib/data/series.ts`, `src/hooks/use-series.ts`, `src/components/series/*` (selector de
  recurrencia con chips, hoja de serie, vista Turnos, hoja de acciones del turno), pestaña "Turnos"
  en `/proyectos`, bloque "Te toca hoy" en Inicio y "Tu día", marcas discretas en el calendario.
- Loki: herramientas `create_series`, `list_series` y `shift_query`; el analizador determinista
  entiende "cada domingo alguien distinto riega las plantas: Sofi, Tomás y yo" y "¿a quién le toca la
  loza?" (sin LLM). `get_today_summary` ya devuelve `turnos_hoy` con datos reales.

Pendiente de esta tanda: la verificación completa (sb:reset, typecheck, lint, test:unit, test:rls,
build, build:capacitor) va en el prompt final, como siempre. La push con botón "Hecho" no se añadió:
el canal Android actual no soporta acciones, así que el toque abre la tarea (deep link).

## Resultado de p16 + p16c (verificación final, 02-10 ~03:45)

| Chequeo | Resultado |
|---|---|
| `npm run sb:reset` | **OK**: aplican las 23 migraciones, incluidas `20261015000000_reparacion_verificacion.sql` (p16) y `20261016000000_reparacion_rls_final.sql` (p16c). Base local sin objetos de depuración. |
| `npm run typecheck` | **OK** (0). |
| `npm run lint` | **OK** (0 errores, 12 warnings preexistentes). |
| `npm run test:unit` | **OK**: mentions 70, preview 8, intent 105. |
| `npm run test:rls` | **OK: 178/178** (antes 169/178). |
| `npm run build` | **OK** (29 páginas estáticas). |
| `npm run build:capacitor` | **OK** (export + `cap sync android`). |

**Arreglado en p16:** orden de las migraciones `polls`, `agents` y `devices` (ojo: p16 editó esas 3 migraciones anteriores para reordenarlas, porque `sb:reset` fallaba); migración de reparación `20261015000000` (recursión en políticas de agentes, `poll_electors`, `on conflict` con índice parcial de `ai_jobs`, tildes en la memoria, PC revocado); typecheck, lint y tests unitarios; ajustes en tests RLS (`daily_digest`, `memories`, `search`).

**Arreglado en p16c** (migración nueva `20261016000000_reparacion_rls_final.sql`):
1. **Agentes – INSERT de `agent_runs`:** la política SELECT ya no relee la fila por id; usa la nueva `agent_run_is_readable(connection_id, workspace_id, chat_id, requested_by)` con las columnas de la fila (misma regla). `agent_can_read_run(id)` queda para los eventos.
2. **Encuestas – tick:** la función estaba bien (idempotente, dedupe `poll:<id>:<uid>`); el test estaba mal (votaba con lista vacía, que retira el voto, y en la encuesta equivocada). Se corrigió el test.
3. **Búsqueda:** nuevo `search_name_text()` (`- _ .` → espacios) para nombres de archivo; `global_search` y `search_more` redefinidas manteniendo el filtro por fuente (`can_access_chat`, `is_member`, recuerdos sensibles fuera del buscador global).
4. **Transcripciones en DM:** nuevo helper `can_read_chat_content(workspace_id, chat_id)` (DM = estar en `member_ids`; grupo = miembro del espacio), usado en la política de `audio_transcriptions` y en la búsqueda.
5. **Extra:** `agent_can_invoke` dejaba al dueño invocar con el grant apagado por un admin; ahora manda la gobernanza del espacio. Test `agents` "el cliente no mueve estados" pasa a `assertDenied` (no hay `GRANT UPDATE` en `agent_runs`).

Restos de diagnóstico: los 13 `diag-*.sql` se borraron (sin commitear) y `sb:reset` dejó la base local limpia.

## Pendientes para Manu (tras esta tanda)
- p16 cerrado (`c0b3a31`). Pendiente: revisión manual en web y Android (puntos 3 y 4 de p16: no los hace opencode) y Edge Functions con `npm run sb:functions`.
- **Prompt 6 (tareas recurrentes y turnos rotativos)**: hecho en la tanda posterior a p16 (ver la
  sección de arriba). Falta su verificación y el commit.
- Revisar y aprobar el push de p07-p16 a `origin/main` (todo local por ahora).
- Lo de siempre: clave de IA, Google OAuth, FCM real, prueba en teléfono, RAM de WSL (ver "Pendientes y bloqueos").

## Terminado (hashes)
- T1–T9 (scaffold, tokens Grok, shell, Firebase inicial, auth, onboarding, espacios, navegación): `5b58d0f` … `ab4fc29`.
- T10 `df1a73a` · T11 `09ee46d` (Capacitor) · T12 `6598258` · T13 `5b40ce8` · T14 `6f6307d` · T15 `34d9f21`.
- T16 `263eccf` · T17 `10a8d0b` · T18 `08ea3be` (verificados con E2E y capturas por Loki).
- T19 `8711c5c`: Supabase local, esquema, RLS, triggers y Storage (verificado: sb:reset, RLS 55/55, typecheck, lint, build y cap en 0).
- **T20–T36 en un solo commit `f4eb6c2`** ("T34-T36: Pulido, calidad y lanzamiento", 209 archivos), con Auth (T20, que ya no queda sin commit), chats, IA, FCM, calendario, proyectos, notificaciones, invitaciones, búsqueda, PWA, pulido, CI y docs.
- Después (Manu): `ecd83f9` arreglo del bundle Deno · `466be8b` canal realtime compartido · `4d8b40b`/`772a95f`/`85534fe`/`f54f321` sidebar · `a45cee6` Google Calendar bidireccional · `615ec76` apikey en Edge · `c8d4ba6` realtime auto-recuperable · `836699d`/`1b473ff`/`d1af2f4` invitar y unirse · `51a3ee5`/`0c17c0f`/`9615d6c` GCal · `8037776` chat · `54cd726` rediseño del calendario · `8e9d2fb`/`072d7e0` push · `eaf5c45`/`d12ef59` Android · `21d313e` listas · `702faf8` **p07: encuestas (datos, tipos y RLS; la UI quedó a medias)** · `1bbf109` p08 notas de voz.
- **Prompts 7-15** (tanda Forja 01-10/02-10): `702faf8`/`86e800b` p07 · `1bbf109`/`f9b9aa2` p08 · `56a9868`/`fb41b23` p09 · `1265b3c` p10 · `1002d3e` p11 · `44f837a` p12 · `6b76812` p13 · `9e6a698` p14 · `ff8d7d6` p15 (HEAD de código). `c0b3a31` p16 (verificación y regresión completa, con p16c).
- Verificado el 01-10 ~05:35 en `d12ef59`: `npm run typecheck` en 0, árbol limpio. Build, lint y test:rls **no** se corrieron en este traspaso (opencode de Manu activo).

## Tarea en curso
- Sin tarea de Forja en curso. p16 cerrado en verde (p16c, EXIT 0, 02-10 03:44) y commiteado en `c0b3a31`.
- Hay 2 procesos opencode de Manu activos desde 01-10 04:12 (`opencode` y `opencode serve --service`). **No matarlos.**
- Migraciones: `20260929000000_init` · `20260930000000_organizer` · `…01_ai_tools` · `…02_storage` · `…03_search` · `…04_negatives_fix` · `…05_gcal` · `20261001000000_push_direct` · `20261003000000_ai_infra` · `20261004000000_loki_actions` · `20261005000000_convert_digest` · `20261006000000_lists` · `20261007000000_polls` · `20261008000000_transcriptions` · `20261009000000_space_memories` · `20261010000000_search_all` · `20261011000000_daily_digest` · `20261012000000_agents` · `20261013000000_agents_chat` · `20261014000000_devices` · `20261015000000_reparacion_verificacion` (p16) · `20261016000000_reparacion_rls_final` (p16c) · `20261017000000_tareas_recurrentes_turnos` (prompt 6).
- Edge Functions: `loki-chat`, `loki-worker`, `push-send`, `google-calendar`, `agent-callback`, `agent-connections`, `agent-dispatch`, `agent-task`, `device-pair` (secretos en `supabase/functions/.env`, gitignored; plantilla `.env.example`, ahora con `STT_*`).

## Próximas 5 tareas (criterio de aceptación)
1. ~~**Cerrar p16 (regresión completa)**~~ **Hecho** en `c0b3a31` (todo en 0, test:rls 178/178). Falta solo la revisión manual en web/Android.
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
