# Supabase local de Loki

Infraestructura de base de datos de Loki tras la migración de **Firestore a
Supabase** (Postgres + RLS + Realtime + Storage + Edge Functions). Firebase
queda **solo para el push FCM**, que es otra tarea (T24).

Este directorio contiene:

| Ruta | Qué es |
|---|---|
| `config.toml` | Configuración del stack local (puerto, auth sin confirmación, Google desactivado) |
| `migrations/20260929000000_init.sql` | Todo el esquema: tablas, índices, triggers, vistas, RLS, buckets y políticas de Storage |
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
| `can_access_chat(workspace_id, chat_id)` | Grupo y posts los ve el espacio; un dm, solo sus `member_ids` |
| `create_workspace(name, emoji)` | Alta del onboarding: espacio + owner + chats `general` y `posts`, y deja el espacio como actual. Devuelve el uuid |
| `ensure_posts_chat(workspace_id)` | Crea el chat `posts` de un espacio antiguo si falta. Idempotente: `true` si lo creó, `false` si ya estaba |

---

## Realtime

En la publicación `supabase_realtime`: `messages`, `message_reactions`, `chats`
y `chat_reads`. La RLS se aplica también al realtime, así que solo llegan
eventos de lo que el usuario puede ver.

Typing y presencia **no** usan tabla: van por Broadcast y Presence en el canal
`chat:{workspace}:{chat}` (T21).

---

## Storage

| Bucket | Público | Ruta | Regla |
|---|---|---|---|
| `attachments` | no | `{workspace_id}/{chat_id}/...` | Lectura y escritura solo para miembros del espacio |
| `avatars` | sí (lectura) | `{uid}/...` | Escritura solo en tu propia carpeta |

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
- **No hay claves reales.** Las de `sb:status` son las de demo del CLI.
- **No hay Edge Functions todavía.** Llega en T23 (`loki-chat`); el scaffold se
  sirve con `npm run sb:functions`.
- Firebase sigue presente en la app (T20 a T23); esta tarea solo añade la
  infraestructura de Supabase al lado.
