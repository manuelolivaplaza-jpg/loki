# Supabase local de Loki

Infraestructura de base de datos de Loki tras la migración de **Firestore a
Supabase** (Postgres + RLS + Realtime + Storage + Edge Functions). Firebase
queda **solo para el push FCM**, que es otra tarea (T24).

Este directorio contiene:

| Ruta | Qué es |
|---|---|
| `config.toml` | Configuración del stack local (puerto, auth sin confirmación, Google desactivado) |
| `migrations/20260929000000_init.sql` | Esquema base: tablas, índices, triggers, vistas, RLS, buckets y políticas de Storage |
| `migrations/` (resto) | Una migración NUEVA por lote, con fecha posterior a la anterior. Nunca se edita una ya aplicada |
| `functions/loki-chat/` | Loki IA con herramientas (streaming SSE + protocolo `tool_pending`) |
| `functions/loki-worker/` | Trabajadora de `ai_jobs`: resúmenes, digest, transcripción de audio y OCR de imágenes |
| `functions/push-send/` | Envío de FCM (respeta `notification_prefs` y el horario de silencio) |
| `functions/google-calendar/` | Sincronización bidireccional con Google Calendar |
| `functions/_shared/intent.ts` | Analizador determinista de intenciones (copia sincronizada con `src/lib/chat/intent.ts`) |
| `functions/_shared/memory.ts` | Categorías y utilidades de la memoria del espacio (copia sincronizada con `src/lib/memory/memory.ts`) |
| `functions/_shared/transcribe.ts` | Voz a texto: `openai` (`/audio/transcriptions`) o `gemini` (`generateContent` con audio inline) |
| `functions/_shared/vision.ts` | Texto en imágenes: visión del proveedor (`openai` con `image_url`, `anthropic` con imagen base64 o `gemini` inline). `OCR_*` cae a `LLM_*` si no se pone |
| `seed.sql` | Datos iniciales, vacío a propósito |
| `README.md` | Este archivo |

---

## Cómo arrancar

En la PC de Manu **no hay Docker Desktop**: el Docker Engine corre dentro de
**WSL2 Ubuntu** y el CLI de Supabase también. Por eso todos los comandos pasan
por el wrapper `scripts/supabase.mjs`, que detecta si hay `docker` en el PATH
de Windows y, si no, ejecuta el CLI dentro de WSL con la ruta del proyecto
convertida a `/mnt/c/...`.

```bash
npm run sb:start       # arranca el stack (sin studio, imgproxy, vector,
                       # logflare, supavisor ni postgres-meta)
npm run sb:status      # estado y claves
npm run sb:reset       # recrea la base y aplica las migraciones
npm run sb:stop        # para el stack
npm run sb:functions   # sirve las Edge Functions (T23: Loki IA)
```

`sb:start` es idempotente: si ya está corriendo, lo dice y sigue.

### RAM

La WSL de Manu tiene ~3.6 GB asignados y hay otros contenedores corriendo
(open-webui, onecli...). Por eso el wrapper siempre arranca con
`-x studio -x imgproxy -x vector -x logflare -x supavisor -x postgres-meta`.
El CLI acepta exclusiones explícitas, así que si algún día se sube la RAM se
pueden quitar del array `EXCLUDED_SERVICES` en `scripts/supabase.mjs`.

Los contenedores de Manu no se tocan: el CLI solo gestiona los suyos, con
prefijo `supabase_*`.

---

## Puertos

| Servicio | Puerto | Desde Windows |
|---|---|---|
| API (REST, Auth, Realtime, Storage, Functions) | 54321 | `http://127.0.0.1:54321` |
| Postgres | 54322 | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Mailpit (correos de auth) | 54324 | `http://127.0.0.1:54324` |

WSL2 reenvía los puertos de localhost a Windows, así que Next.js corre en
Windows contra `http://127.0.0.1:54321` sin más configuração.

---

## Claves

Las claves del stack local son **las de demo del CLI**: las mismas para todos,
sin valor de seguridad y sin conexión con ningún proyecto real.

```bash
npm run sb:status          # las imprime en pantalla
node scripts/supabase.mjs status -o env   # en formato VAR="valor"
```

Se copiasan a `.env.local` (que está gitignored):

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY de sb:status>
```

**Nunca al repositorio.** La `service_role` key solo se usa en
`scripts/test-rls.mjs` para sembrar y limpiar datos de prueba; la aplicación
solo usa la `anon` key, porque el aislamiento lo pone la RLS del servidor.

`supabase/.gitignore` (el que genera el CLI) ignora `.temp`, `.branches` y los
`.env` locales del directorio. El `.gitignore` de la raíz añade
`supabase/functions/.env` para los secretos de las Edge Functions de T23.

---

## Auth en local

- Email y contraseña **sin confirmación** (`[auth.email] enable_confirmations = false`),
  así que el registro de T20 puede hacer `signUp` y usar la sesión de inmediato.
- Google queda **cableado pero desactivado** (`[auth.external.google] enabled = false`,
  con `client_id` y `secret` leídos de variables de entorno). Sin secretos
  reales no arranca; la UI muestra "Google no configurado en este entorno".
- `site_url` y las URLs de redirección cubren la web (`localhost:3000`) y el
  empaquetado con Capacitor (`capacitor://localhost`).
- Los límites de auth están subidos a 1000 porque los tests crean usuarios
  reales en cada corrida.

---

## Mapa Firestore → Postgres

Todo vive en el esquema `public`. Los nombres van en `snake_case`; el adaptador
de datos de T21 los traduce a los tipos camelCase que ya usa la UI.

| Firestore | Postgres | Notas |
|---|---|---|
| `users/{uid}` | `profiles` (id = `auth.users.id`) | Lo crea el trigger `on_auth_user_created` |
| `users/{uid}.memberships/{wsId}` | — | Desaparece: los espacios del usuario salen de `workspace_members` |
| `workspaces/{wsId}` | `workspaces` (uuid) | El alta solo existe por la RPC `create_workspace` |
| `workspaces/{wsId}/members/{uid}` | `workspace_members` (PK `workspace_id, user_id`) | |
| `workspaces/{wsId}/chats/{chatId}` | `chats` (PK `workspace_id, id`) | Ids estables: `general`, `posts` |
| `.../chats/{chatId}/messages/{mid}` | `messages` (id uuid) | El id lo pone la base, no el cliente |
| `.../messages/{mid}.reactions` | `message_reactions` (PK `message_id, user_id, emoji`) | El adaptador reconstruye el mapa `{emoji: uid[]}` |
| `.../messages/{mid}.threadCount` | columna `thread_count` + trigger | El cliente no los escribe |
| `.../chats/{chatId}/reads/{uid}` | `chat_reads` (PK `workspace_id, chat_id, user_id`) | |
| `.../chats/{chatId}/typing/{uid}` | — | Pasa a Realtime **Broadcast** (T21) |
| `users/{uid}/aiChats/{id}` | `ai_chats` | |
| `.../aiChats/{id}/messages/{mid}` | `ai_messages` | `type 'ai'` solo service role |
| — (nuevo) | `push_tokens` | Única pieza que sigue en Firebase (T24) |
| `workspaces/{wsId}/chats/posts/messages` | vista `posts` | `security_invoker`, aplica RLS |
| Reacción ❤️ sobre un post | vista `post_likes` | `security_invoker` |
| `storage.rules` | políticas sobre `storage.objects` | Buckets `attachments` y `avatars` |

### Lo que ahora hace la base de datos

En Firestore, el cliente escribía a mano los contadores y el preview del chat.
En Postgres eso lo hacen triggers, y el cliente no puede ni mentirlos:

- **Perfil automático** al registrarse: `display_name` sale de
  `raw_user_meta_data.display_name` o de la parte del email anterior a la `@`.
- **Hilos**: al insertar un mensaje con `thread_parent_id`, el padre suma `+1`
  en `thread_count` y se marca `last_reply_at`. El trigger además valida que el
  padre exista en el mismo chat.
- **Preview del chat**: un mensaje sin `thread_parent_id` de type `user`, `post`
  o `ai` actualiza `chats.last_message` y `chats.updated_at`. Los `system` y las
  respuestas de hilo **no** (misma regla que `updatesChatPreview`).
- **Guardas de UPDATE** (`messages_guard_update`, `chats_guard_update`,
  `workspace_members_guard_update`): un autor solo cambia `text`, `mentions`,
  `edited_at` y `deleted`; un miembro solo su propio `display_name`; nadie
  escribe su propio `last_message`. Bloquean con error `42501`.
- **Borrado en suave**: `messages` no tiene política de DELETE. Se marca
  `deleted`.

### Helpers y RPC

Funciones `SECURITY DEFINER` con `search_path` fijo (`public, pg_temp`), usadas
desde las políticas:

| Función | Para qué |
|---|---|
| `is_member(workspace_id)` | ¿ Soy del espacio? |
| `is_owner(workspace_id)` | ¿ Soy el owner? |
| `is_space_admin(workspace_id)` | ¿ Soy owner o admin? |
| `can_access_chat(workspace_id, chat_id)` | Grupo y posts los ve el espacio; un dm, solo sus `member_ids` |
| `storage_workspace_id(object_name)` | Primer segmento de una ruta de Storage como uuid (o null) |
| `create_workspace(name, emoji)` | Alta del onboarding: espacio + owner + chats `general` y `posts`, y deja el espacio como actual. Devuelve el uuid |
| `ensure_posts_chat(workspace_id)` | Crea el chat `posts` de un espacio antiguo si falta. Idempotente: `true` si lo creó, `false` si ya estaba |
| `ensure_inbox_project(workspace_id)` | Bandeja del espacio (proyecto `is_system`) para tareas y recordatorios sin proyecto |
| `reserve_ai_quota(workspace_id, user_id, job_type, units)` | Reserva atómica de cuota (espacio + usuario) antes de cada llamada a un modelo o a voz a texto |
| `retry_ai_job(job_id)` | Reencola un trabajo fallido (quien lo pidió o un admin) |
| `retry_transcription(transcription_id)` | Reencola la transcripción de un audio que falló |
| `global_search(workspace_id, q, ...)` | Búsqueda de Cmd/Ctrl+K y `/buscar`: 12 grupos (mensajes, transcripciones, **recuerdos no sensibles**, tareas, proyectos, eventos, personas, listas, ítems, encuestas, ideas y adjuntos con OCR). Filtros opcionales: tipos, chat, autor (`de:`), solo míos, fechas y límite por grupo |
| `search_more(workspace_id, q, grupo, ...)` | "Ver más" paginado de un grupo (misma puerta y filtros) |
| `search_space_memories(workspace_id, query, limit)` | Memoria del espacio con full-text en español (sin IA): respeta visibilidad, caducidad y membresía. La usan la pantalla Memoria y el recall de `loki-chat` |
| `poll_results(poll_id)` | Estado de una encuesta: opciones con votos, ganador o empate, quién falta y qué puede hacer cada uno. En las anónimas no expone los uids (la RLS tampoco los deja ver) |
| `cast_poll_vote(poll_id, option_ids)` | Vota, cambia o retira el voto (lista vacía = retirar). Valida acceso, encuesta abierta y tipo |
| `close_poll(poll_id)` | Cierre a mano (creador, admin o quien diga `closeBy`) |
| `poll_option_busy(poll_id)` | Ocupados por opción en las encuestas de fecha: **solo el número**, nunca el detalle del evento (los importados de Google cuentan igual) |
| `poll_flag(settings, key, default)` / `poll_can_manage` / `poll_can_vote` / `poll_can_suggest` / `poll_electors` | Permisos y ajustes de encuesta que usan las políticas (y que el worker puede reutilizar) |

Además, en la migración de encuestas: `close_due_polls()` cierra lo vencido,
`create_poll_reminders()` manda **un** aviso "falta tu voto" a quien no votó
(dedupe por encuesta y usuario) y `poll_tick()` las dos cosas; es el job de
`pg_cron` de 5 minutos (SQL barato, sin IA). El cierre por tiempo también
ocurre al leer la encuesta, así que la tarjeta nunca sale "abierta" vencida.

### Búsqueda total (`message_attachments`, `workspace_search_settings`)

Migración `20261010000000_search_all.sql`: que Cmd/Ctrl+K y `/buscar`
encuentren todo lo que se guarda en Loki.

- **Índice de adjuntos**: los archivos viven en `messages.attachments`
  (jsonb); el trigger `sync_message_attachments` los indexa en
  `message_attachments` (nombre, tipo, tamaño, ruta, mensaje, chat, espacio
  y texto OCR) al insertar o corregir el mensaje, sin bloquear el envío. La
  RLS hereda la del mensaje (`can_access_chat`): un DM ajeno queda fuera con
  sus archivos, transcripciones y OCR. El cliente no escribe el índice.
- **OCR por eventos**: cada imagen con ruta de Storage nace `pending`; si el
  espacio activó el OCR, `enqueue_image_ocr` deja UN trabajo `ocr_image` y
  `wake_ai_worker` despierta a `loki-worker` por `pg_net`. El worker verifica
  membresía y chat, reserva cuota ANTES de bajar la imagen y guarda el texto
  (listo o `skipped` sin config). Sin OCR activado no se encola nada y la
  imagen se encuentra por nombre. Opción por espacio en
  `workspace_search_settings` (solo admins, Configuración → Búsqueda en
  imágenes).
- **Sintaxis**: `de: Sofi` (autor), `en: General` (chat), `solo míos`,
  `hoy`, `ayer`, `esta semana`, `la semana pasada`, `este mes` y
  `el mes pasado`. La entiende el analizador determinista del cliente
  (`parseSearchQuery`); la RPC recibe los filtros ya separados.
- **"Preguntar a Loki"**: botón al final de los resultados (nunca automático)
  que convierte la búsqueda en pregunta con los mejores resultados como
  contexto; Loki responde por su camino normal (cuota del espacio).

### Memoria del espacio (`space_memories`)

Migración `20261009000000_space_memories.sql`: lo que el espacio recuerda y que
Loki usa al responder ("la clave del wifi es…", "Tomás es alérgico al maní").

- **Nada barre el chat**: no hay proceso ni trigger que lea mensajes buscando
  datos. Los recuerdos entran por acción explícita (Loki con confirmación, el
  menú del mensaje o la pantalla Memoria) y Loki los consulta con
  `search_space_memories` (full-text en español, SQL barato, **sin IA**) cuando
  alguien pregunta. Si algún día hay `pgvector`, se puede sumar búsqueda
  semántica al lado, sin cambiar el contrato.
- **RLS**: los miembros leen lo compartido; cada uno guarda a nombre propio
  (`created_by = auth.uid()`); edita o borra quien lo guardó o un admin del
  espacio. `visibility = 'privado'` deja un recuerdo personal dentro del
  espacio (solo su autor).
- **Nada de un DM sin permiso**: el trigger `space_memories_guard_source` fuerza
  `privado` si el recuerdo viene del mensaje de un DM y no viene
  `share_confirmed`; compartirlo es una decisión explícita de quien lo guarda.
- **Sensible ≠ push**: `sensitive = true` (claves, datos de salud) sale oculto
  en la UI, no genera notificación y `global_search` no lo devuelve. El aviso
  de caducidad (`notify_expiring_memories`, job diario de `pg_cron`, SQL
  barato) nunca lleva el texto de un sensible.
- **Notificaciones** tipo `memory` (+ preferencia por tipo): "nuevo recuerdo en
  el espacio" a los demás miembros y "está por caducar" al autor, ambas con
  dedupe. El actor no se avisa a sí mismo.

---

## Realtime

En la publicación `supabase_realtime`: `messages`, `message_reactions`, `chats`,
`chat_reads` y las tablas que la UI mira en vivo (`ai_jobs`,
`audio_transcriptions`, `projects`, `polls`, `space_memories`, …). La RLS se
aplica también al realtime, así que solo llegan eventos de lo que el usuario
puede ver.

Typing y presencia **no** usan tabla: van por Broadcast y Presence en el canal
`chat:{workspace}:{chat}` (T21).

---

## Storage

| Bucket | Público | Ruta | Regla |
|---|---|---|---|
| `attachments` | no | `{workspace_id}/{chat_id}/...` | Lectura y escritura solo para miembros del espacio |
| `chat-media` | no | `{workspace_id}/{uuid}-{nombre}` | Adjuntos de chat y notas de voz; solo miembros del espacio |
| `post-media` | no | `{workspace_id}/{uuid}-{nombre}` | Adjuntos de publicaciones; solo miembros del espacio |
| `avatars` | sí (lectura) | `{uid}/...` | Escritura solo en tu propia carpeta |

El primer segmento de la ruta de `chat-media`/`post-media` es el espacio: es lo
que permite que la Edge `loki-worker` baje el audio con permisos de servidor y
que la tabla `audio_transcriptions` ate cada transcripción a SU espacio (CHECK
`storage_workspace_id(object_path) = workspace_id`).

### Edge Functions (Deno, sin dependencias externas)

Ninguna importa paquetes: solo `fetch`, `FormData` y `Deno.env`. El código
compartido va en `functions/_shared/` con imports **relativos** (`../_shared/x.ts`),
que es lo que arregló el commit `ecd83f9` ("arreglo del bundle Deno").

| Función | Quién la llama | Para qué |
|---|---|---|
| `loki-chat` | El cliente, con su JWT | Chat con streaming SSE, herramientas y confirmación de escrituras |
| `loki-worker` | El trigger `wake_ai_worker` (pg_net) o `pg_cron` | Un trabajo de `ai_jobs` por llamada. `GET /health` dice si hay voz a texto y si hay modelo configurados |
| `push-send` | El trigger `maybe_push_notification` (pg_net) | FCM, respetando preferencias y horario de silencio |
| `google-calendar` | El cliente, con su JWT | OAuth y sincronización pull/push |

`loki-worker` exige `Authorization: Bearer <WORKER_KEY>` (secreto del servidor,
el mismo valor que `loki.worker_key` en la base): un cliente nunca puede
invocarla para saltarse cuotas.

Tipos de `ai_jobs`: `chat_summary`, `day_digest`, `redact_highlights`,
`transcribe_audio`, `chat_digest`, `poll_summary` (el resumen del resultado de
una encuesta, **bajo demanda**: el worker arma el resultado con SQL y solo llama
al modelo barato si hay clave y cuota, reservando antes) y `day_highlights`
("lo importante de tus espacios" para la vista "Tu día": se pide al abrir,
modelo barato, cuota del espacio, cacheado por día en `ai_summaries` con
`chat_key = 'day:YYYY-MM-DD'`).

El resumen diario (`20261011000000_daily_digest.sql`) reemplaza el fijo
`create_ai_daily_digest()` con el pg_cron `loki-ai-daily-8am` (desprogramado
aquí, sin editar su migración): `daily_digest_prefs` por usuario (hora local,
zona, días, espacios, aviso en vacío), notificación tipo `daily` con link
`/inicio?vista=dia`, y `create_daily_digests()` cada 15 min (SQL barato, sin
LLM, idempotente por usuario y día local, hora intacta en verano por
`AT TIME ZONE`). Respeta el interruptor `daily`, el horario de silencio y los
días hábiles, y no se duplica con `create_due_reminders` (dedupes y tipos
distintos).

---

## Tests

```bash
npm run sb:start     # el stack tiene que estar arriba
npm run test:rls
```

`scripts/test-rls.mjs` lee las claves de `supabase status -o env` (vía el
wrapper) y lanza `node --test --test-concurrency=1` con los archivos de
`tests/rls/` **de forma explícita**: en Windows `node --test tests/` no
descubre los `.mjs`.

Los tests usan **usuarios reales** creados con `auth.signUp` (correos únicos por
corrida, y se purgan al empezar y al terminar). La `service_role` solo se usa
para sembrar lo que el cliente no podría crear —por ejemplo un mensaje
`type 'ai'`— y para limpiar. El aislamiento se comprueba siempre con el cliente
del usuario.

Detalle importante al portar las reglas de Firestore: en RLS una lectura
denegada **no da error**, PostgREST devuelve la lista vacía; y un `UPDATE` o
`DELETE` sobre filas que la política no deja ver afecta a **0 filas**, tampoco
da error. Solo un `INSERT` (o un `UPDATE` que viola el `WITH CHECK`) devuelve
`42501`. Los helpers `assertDenied`, `assertNoRows` y `assertNoRowsAffected` de
`tests/rls/_helpers.mjs` distinction esos tres casos.

---

## Qué NO hay aquí

- **No hay proyecto Supabase real.** Nada de `supabase login`, `supabase link` ni
  `supabase db push`. Todo es local.
- **No hay claves reales.** Las de `sb:status` son las de demo del CLI, y los
  secretos de las Edge Functions viven en `supabase/functions/.env`
  (gitignored, con plantilla `.env.example`). Sin `LLM_API_KEY` la UI muestra
  "Loki IA sin configurar"; sin `STT_API_KEY`, "Transcripción sin configurar".
- Firebase sigue presente **solo** para el push FCM. Ni Firestore, ni Auth, ni
  Storage quedan en `src/`.
