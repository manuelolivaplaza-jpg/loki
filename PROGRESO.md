# PROGRESO de Loki (traspaso a Forja nuevo)

Actualizado: 01-10-2026 (hora de Chile, UTC-3).

## Datos básicos
- **Proyecto:** `C:\Users\manue\OneDrive\Desktop\loki` (PC de Manu, Windows + PowerShell).
- **Rama:** `main`, sincronizada con `origin/main` (GitHub `manuelolivaplaza-jpg/loki`). No hacer push sin OK de Manu.
- **Modelo de opencode:** `opencode/space-bunny-free` (siempre con `--auto`; lanzador `.forja\run.ps1 <tarea>`, que deja `.forja\<tarea>.log` terminado en `EXIT n`).
  - Nota: hasta T16 se usó `muse-spark-1.3-contributor-free`, que cortó con "Rate limit exceeded" (t16.log y t16b.log, EXIT 1). Desde T16c se usa space-bunny. No volver a muse-spark salvo que Manu lo pida.
- **Stack:** Next.js 15 (export estático) + TypeScript estricto + Tailwind + shadcn/ui + Capacitor (Android). Supabase local vía CLI dentro de WSL2 Ubuntu con Docker Engine (`scripts/supabase.mjs`).

## Fase actual
Roadmap T1–T36 **completo y commiteado**. Fase actual: integración real y pulido después del roadmap (Google Calendar, push nativo en Android, ajustes de UI). Manu avanza por su cuenta con opencode.

### Lote actual (implementado, SIN commit y SIN verificar)

**Resumen diario "Tu día"** (push de la mañana + vista):
- **Migración NUEVA** `supabase/migrations/20261011000000_daily_digest.sql`:
  desprograma `loki-ai-daily-8am`, notificación tipo `daily` (+ columna en
  `notification_prefs`), tabla `daily_digest_prefs` (hora local 08:00, zona
  America/Santiago, días, espacios, aviso en vacío) con RLS propia,
  `create_daily_digests()` cada 15 min (SQL sin LLM, hora local por
  `AT TIME ZONE`, dedupe por día local, respeta interruptor/silencio/hábiles,
  sin duplicar `create_due_reminders`) y `day_highlights` en `ai_jobs`.
- **Edges**: `push-send` mapea `daily`; `loki-chat` amplía `get_today_summary`
  (atrasadas, listas fijadas, encuestas sin mi voto); `loki-worker` procesa
  `day_highlights` (menciones + recientes, modelo barato con cuota, cacheado
  por día en `ai_summaries` con `chat_key = 'day:…'`, determinista sin clave).
- **App**: `src/lib/data/daily-digest.ts`, `src/hooks/use-daily-digest.ts`,
  `src/components/daily/today-view.tsx` (acciones directas, 1 col móvil / 2
  col escritorio) + `digest-settings-section.tsx`, tarjeta "Tu día" en Inicio
  y vista `/inicio?vista=dia`, compacto en el right-panel, sección en
  Configuración, icono `daily`, clic de la push web abre el link
  (`firebase-messaging-sw.js`).
- **Tests**: `tests/rls/daily_digest.test.mjs` (prefs, tipo daily, agrupado +
  idempotente, hábiles/vacío, `day_highlights`). Se ejecutan en el prompt
  final, no ahora.

**Encuestas en el chat** (decidir sin 40 mensajes) — segunda pasada, completa
lo que había quedado a medias:

- **Ya estaba** (commit `702faf8`, p07): migración
  `20261007000000_polls.sql` (polls/poll_options/poll_votes con RLS, RPCs
  `poll_results`, `cast_poll_vote`, `close_poll`, `poll_option_busy`, tick de
  pg_cron con recordatorio "falta tu voto", notificación tipo `poll`), tipos en
  `src/types/organizer.ts` y `src/types/supabase.ts`, capa de datos
  (`src/lib/data/polls.ts`), helpers puros (`src/lib/polls/poll.ts`), hooks
  (`src/hooks/use-polls.ts`), `poll-card.tsx`, `poll-result-actions.tsx` y
  `tests/rls/polls.test.mjs`.
- **Faltaba y se agregó**: `poll-summary.tsx` (estaba importada y no existía),
  `poll-sheet.tsx` (crear), `poll-settings.tsx` (ajustar), la tarjeta en el
  chat (`MessageBubble` con `meta.kind === "poll"`), los puntos de entrada
  (`+` del composer → "Encuesta", acción rápida "Nueva encuesta"), la
  herramienta `create_poll` de `loki-chat` (con tarjeta de confirmación y
  editor de opciones con fecha), el analizador determinista `create_poll`
  (intento nuevo, copia sincronizada en la Edge + tests), el trabajo
  `poll_summary` en `loki-worker` (resultado con SQL + modelo barato bajo
  demanda, cuota del espacio) con su tipo nuevo en el CHECK de `ai_jobs`, la
  push "falta tu voto" abriendo el chat en la encuesta (`?msg=`), los iconos
  de notificación que faltaban (`list`, `poll`) y sus interruptores en
  Configuración. También se arreglaron errores de typecheck que dejaron las
  sesiones p07/p08 (`UploadProgress` sin `onCancel`, `voice` de `MessageList`,
  `useClosePoll`, casts de `transcriptions.ts`).

**Notas de voz que se convierten en cosas** (transcripción + voz a acción):

- **Migración NUEVA** `supabase/migrations/20261008000000_transcriptions.sql`:
  tabla `audio_transcriptions` (una fila por archivo de audio ya subido, con
  texto, idioma, duración, proveedor y estado), CHECK
  `storage_workspace_id(object_path) = workspace_id`, índice único por
  `(workspace_id, object_path)`, RLS que hereda la visibilidad del mensaje
  (`can_access_chat`, así en un DM solo sus miembros) y deja el dictado suelto
  en privado, encolado por evento (`audio_transcriptions_enqueue` -> `ai_jobs`
  `transcribe_audio` -> `wake_ai_worker` por `pg_net`), `retry_transcription()`
  y `global_search` reemplazada por la misma firma **con un grupo más**
  (`transcriptions`).
- **Edge:** `supabase/functions/_shared/transcribe.ts` (nuevo, sin dependencias
  externas, imports relativos) con `STT_PROVIDER=openai|gemini`, `STT_MODEL`,
  `STT_API_KEY`, `STT_BASE_URL`; `loki-worker` implementa `processTranscribe`
  (verifica membresía y acceso al chat, reserva cuota **antes** de bajar el
  audio, descarga con la service role y guarda el texto) y un `GET /health` que
  dice si hay voz a texto configurada.
- **App:** `src/lib/data/transcriptions.ts`,
  `src/hooks/use-voice-transcription.ts`,
  `src/components/media/transcription-panel.tsx` ("Ver transcripción" bajo
  demanda), `src/components/ai/dictate-sheet.tsx` ("Dictar a Loki"),
  `src/components/chat/dictation-banner.tsx` (texto editable encima del plan) y
  `src/components/chat/voice-convert-sheet.tsx` ("Convertir en…" sobre una nota
  de voz). `VoiceRecorder` gana modo `toggle`, hápticos y corte en segundo plano.
  Búsqueda: nuevo grupo "Notas de voz" en la paleta. Android: `RECORD_AUDIO` +
  `MODIFY_AUDIO_SETTINGS` en el manifest (Capacitor 8 ya reenvía
  `AUDIO_CAPTURE` a la petición en tiempo de ejecución).
- **Tests:** `tests/rls/transcriptions.test.mjs` (RLS, ciclo, reintento y el
  grupo nuevo de `global_search`).
- **Docs:** README, `supabase/README.md` y `src/components/chat/README.md`
  actualizados (la UI de adjuntos YA funcionaba de punta a punta; el README
  decía que no).

## Terminado (hashes)
- T1–T9 (scaffold, tokens Grok, shell, Firebase inicial, auth, onboarding, espacios, navegación): `5b58d0f` … `ab4fc29`.
- T10 `df1a73a` · T11 `09ee46d` (Capacitor) · T12 `6598258` · T13 `5b40ce8` · T14 `6f6307d` · T15 `34d9f21`.
- T16 `263eccf` · T17 `10a8d0b` · T18 `08ea3be` (verificados con E2E y capturas por Loki).
- T19 `8711c5c`: Supabase local, esquema, RLS, triggers y Storage (verificado: sb:reset, RLS 55/55, typecheck, lint, build y cap en 0).
- **T20–T36 en un solo commit `f4eb6c2`** ("T34-T36: Pulido, calidad y lanzamiento", 209 archivos), con Auth (T20, que ya no queda sin commit), chats, IA, FCM, calendario, proyectos, notificaciones, invitaciones, búsqueda, PWA, pulido, CI y docs.
- Después (Manu): `ecd83f9` arreglo del bundle Deno · `466be8b` canal realtime compartido · `4d8b40b`/`772a95f`/`85534fe`/`f54f321` sidebar · `a45cee6` Google Calendar bidireccional · `615ec76` apikey en Edge · `c8d4ba6` realtime auto-recuperable · `836699d`/`1b473ff`/`d1af2f4` invitar y unirse · `51a3ee5`/`0c17c0f`/`9615d6c` GCal · `8037776` chat · `54cd726` rediseño del calendario · `8e9d2fb`/`072d7e0` push · `eaf5c45`/`d12ef59` Android · `21d313e` listas · `702faf8` **p07: encuestas (datos, tipos y RLS; la UI quedó a medias)** · `1bbf109` p08 notas de voz (último).
- Verificado el 01-10 ~05:35 en `d12ef59`: `npm run typecheck` en 0, árbol limpio. Build, lint y test:rls **no** se corrieron en este traspaso (opencode de Manu activo).

## Tarea en curso
- Sin tarea de Forja en curso. Lo último de Manu: Android (barra de estado) y push nativo.
- Hay 2 procesos opencode de Manu activos desde 01-10 04:12 (`opencode` y `opencode serve --service`). **No matarlos.**
- Migraciones: `20260929000000_init` · `20260930000000_organizer` · `…01_ai_tools` · `…02_storage` · `…03_search` · `…04_negatives_fix` · `…05_gcal` · `20261001000000_push_direct` · `20261003000000_ai_infra` · `20261004000000_loki_actions` · `20261005000000_convert_digest` · `20261006000000_lists` · `20261007000000_polls` · `20261008000000_transcriptions`.
- Edge Functions: `loki-chat`, `loki-worker`, `push-send`, `google-calendar` (secretos en `supabase/functions/.env`, gitignored; plantilla `.env.example`, ahora con `STT_*`).

## Próximas 5 tareas (criterio de aceptación)
1. **Regresión completa tras el commit grande `f4eb6c2`:** `npm run sb:reset` aplica las 8 migraciones; `typecheck`, `lint`, `test:unit`, `test:rls`, `build` y `build:capacitor` en 0. Corregir sin romper y hacer commit local.
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
