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
| `functions/loki-worker/` | Trabajadora de `ai_jobs`: resúmenes, digest y transcripción de audio |
| `functions/push-send/` | Envío de FCM (respeta `notification_prefs` y el horario de silencio) |
| `functions/google-calendar/` | Sincronización bidireccional con Google Calendar |
| `functions/_shared/intent.ts` | Analizador determinista de intenciones (copia sincronizada con `src/lib/chat/intent.ts`) |
| `functions/_shared/transcribe.ts` | Voz a texto: `openai` (`/audio/transcriptions`) o `gemini` (`generateContent` con audio inline) |
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
| `global_search(workspace_id, q)` | Búsqueda de Cmd/Ctrl+K: mensajes, transcripciones, tareas, proyectos, eventos y personas |

---

## Realtime

En la publicación `supabase_realtime`: `messages`, `message_reactions`, `chats`,
`chat_reads` y las tablas que la UI mira en vivo (`ai_jobs`,
`audio_transcriptions`, `projects`, `polls`, …). La RLS se aplica también al
realtime, así que solo llegan eventos de lo que el usuario puede ver.

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
| `loki-worker` | El trigger `wake_ai_worker` (pg_net) o `pg_cron` | Un trabajo de `ai_jobs` por llamada. `GET /health` dice si hay voz a texto configurado |
| `push-send` | El trigger `maybe_push_notification` (pg_net) | FCM, respetando preferencias y horario de silencio |
| `google-calendar` | El cliente, con su JWT | OAuth y sincronización pull/push |

`loki-worker` exige `Authorization: Bearer <WORKER_KEY>` (secreto del servidor,
el mismo valor que `loki.worker_key` en la base): un cliente nunca puede
invocarla para saltarse cuotas.

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
