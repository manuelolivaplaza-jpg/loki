-- =============================================================================
-- Loki · esquema inicial en Supabase (Postgres) — T19
-- =============================================================================
-- Sustituye a Firestore: auth (Supabase Auth), datos, RLS, Realtime y Storage.
-- Firebase queda SOLO para push FCM (tarea T24).
--
-- Convenciones:
--   · Nombres de tabla y columna en snake_case; el adaptador de datos
--     (src/lib/data/*, T21) traduce a los tipos camelCase que ya usa la UI.
--   · `chats` tiene PK compuesta (workspace_id, id) porque los ids son los
--     mismos que en Firestore: 'general', 'posts' y los dms.
--   · `messages.id` es uuid con default: en Firestore el id lo generaba el
--     cliente y la UI ya lo trata como opaco.
--   · Todo trigger que escribe por dentro es SECURITY DEFINER con
--     `search_path` fijo, para que no dependa del search_path del cliente ni
--     quede atrapado por las propias RLS que protege.
--   · Las políticas van comentadas en español, una a una.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Utilidades
-- -----------------------------------------------------------------------------

-- Color de avatar determinista a partir del uid. Misma paleta que
-- `AVATAR_COLORS` en src/types/models.ts.
create or replace function public.avatar_color_for(p_id uuid)
returns text
language sql
immutable
as $$
  select (array['#00b4d8', '#1d9bf0', '#00ba7c', '#ffad1f', '#f4212e', '#6d5fc0', '#536471'])[
    1 + (abs(hashtextextended(p_id::text, 0)) % 7)
  ];
$$;

-- `updated_at` automático. BEFORE UPDATE: el propio trigger pone el valor, sin
--statements extra, y así no hay recursión entre el guard y el toque.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. Tablas
-- -----------------------------------------------------------------------------

-- Espacios. Se insertan únicamente por la RPC `create_workspace`.
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  emoji text not null default '🏠' check (char_length(btrim(emoji)) between 1 and 16),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workspaces is
  'Espacios de Loki. El alta solo existe vía la RPC create_workspace (RLS).';

-- Perfil 1:1 con auth.users. Lo crea el trigger `on_auth_user_created`.
-- `users/{uid}/memberships` de Firestore desaparece: los espacios del usuario
-- salen de workspace_members (el índice espejo ya no hace falta en Postgres).
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text not null default '' check (char_length(display_name) <= 60),
  avatar_color text not null default '#00b4d8',
  current_workspace_id uuid references public.workspaces (id) on delete set null,
  theme text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Perfil del usuario. Solo lo ve y edita el propio usuario (ver RLS).';

-- Pertenencia a un espacio. PK compuesta: un uid, un rol por espacio.
create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  display_name text not null default 'Miembro' check (char_length(display_name) <= 60),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

comment on table public.workspace_members is
  'Miembros de cada espacio. Reemplaza workspaces/{id}/members/{uid} de Firestore.';

-- Chats. type 'group' y 'posts' los ve todo el espacio; 'dm', solo member_ids.
create table if not exists public.chats (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  type text not null check (type in ('group', 'dm', 'posts')),
  name text not null check (char_length(name) between 1 and 60),
  emoji text,
  member_ids uuid[] not null default '{}',
  created_by uuid references auth.users (id) on delete set null,
  last_message jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
);

comment on table public.chats is
  'Chats del espacio. Ids estables: ''general'' y ''posts'' los crea create_workspace.';

-- Mensajes. Sin delete físico: el borrado es soft con `deleted`.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  chat_id text not null,
  author_id uuid references auth.users (id) on delete set null,
  author_name text not null default '',
  text text not null default '' check (char_length(text) <= 4000),
  type text not null default 'user' check (type in ('user', 'system', 'ai', 'post')),
  mentions text[] not null default '{}',
  reply_to jsonb,
  thread_parent_id uuid references public.messages (id) on delete set null,
  thread_count integer not null default 0 check (thread_count >= 0),
  last_reply_at timestamptz,
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  edited_at timestamptz,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  constraint messages_chat_fk
    foreign key (workspace_id, chat_id)
    references public.chats (workspace_id, id) on delete cascade
);

comment on table public.messages is
  'Mensajes de los chats de espacio. type ''ai'' solo lo escribe la service role.';

-- Reacciones. Reemplaza el mapa `reactions: {emoji: uid[]}` embebido en el
-- mensaje: una fila por (mensaje, usuario, emoji). El "Me gusta" es la
-- reacción ❤️ sobre un mensaje type 'post' (vista post_likes).
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

comment on table public.message_reactions is
  'Reacciones por mensaje. Cada usuario solo manages las suyas.';

-- Marca de leídos. Reemplaza workspaces/{id}/chats/{chat}/reads/{uid}.
create table if not exists public.chat_reads (
  workspace_id uuid not null,
  chat_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (workspace_id, chat_id, user_id),
  constraint chat_reads_chat_fk
    foreign key (workspace_id, chat_id)
    references public.chats (workspace_id, id) on delete cascade
);

comment on table public.chat_reads is
  'Última lectura por usuario y chat. Solo cada usuario ve y escribe la suya.';

-- Chat privado de Loki IA. Reemplaza users/{uid}/aiChats/{id}.
create table if not exists public.ai_chats (
  id uuid primary key default gen_random_uuid(),
  -- El default evita que el cliente tenga que mandar su uid al crear el chat;
  -- la politica de INSERT comprueba igualmente que sea el suyo.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Loki IA' check (char_length(title) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_chats is
  'Chats privados de Loki IA, uno (o varios) por usuario. Solo su dueño los ve.';

-- Mensajes del chat privado de IA. type 'ai' SOLO service role (Edge Function
-- de T23): el cliente nunca puede escribir la respuesta de Loki.
create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.ai_chats (id) on delete cascade,
  type text not null default 'user' check (type in ('user', 'ai')),
  content text not null default '' check (char_length(content) <= 32000),
  created_at timestamptz not null default now()
);

comment on table public.ai_messages is
  'Mensajes de la conversación con Loki IA. El cliente solo inserta type ''user''.';

-- Tokens FCM. Única pieza que sigue living en Firebase (T24).
create table if not exists public.push_tokens (
  -- Mismo criterio que ai_chats: el uid lo pone la base por defecto.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token text not null,
  platform text not null default 'web' check (platform in ('web', 'android', 'ios')),
  updated_at timestamptz not null default now(),
  primary key (user_id, token)
);

comment on table public.push_tokens is
  'Tokens FCM por usuario. Los gestiona solo su dueño.';

-- -----------------------------------------------------------------------------
-- 2. Índices
-- -----------------------------------------------------------------------------

-- Timeline del chat: (workspace_id, chat_id) + created_at desc.
create index if not exists messages_timeline_idx
  on public.messages (workspace_id, chat_id, created_at desc);

-- Timeline sin respuestas de hilo (índice parcial: la UI siempre filtra
-- thread_parent_id is null, tanto en chats como en el feed de posts).
create index if not exists messages_timeline_root_idx
  on public.messages (workspace_id, chat_id, created_at desc)
  where thread_parent_id is null;

-- Respuestas de un hilo, en orden.
create index if not exists messages_thread_idx
  on public.messages (thread_parent_id, created_at);

-- Listado de chats del espacio y de leídos por usuario.
create index if not exists workspace_members_user_idx
  on public.workspace_members (user_id, workspace_id);
create index if not exists chats_workspace_updated_idx
  on public.chats (workspace_id, updated_at desc);
create index if not exists chat_reads_user_idx
  on public.chat_reads (user_id, workspace_id, chat_id);
create index if not exists message_reactions_user_idx
  on public.message_reactions (user_id, created_at desc);
create index if not exists ai_chats_user_idx
  on public.ai_chats (user_id, updated_at desc);
create index if not exists ai_messages_chat_idx
  on public.ai_messages (chat_id, created_at);

-- -----------------------------------------------------------------------------
-- 3. Perfil automático al registrarse
-- -----------------------------------------------------------------------------

-- display_name: el que venga en raw_user_meta_data (signup de T20) o, si no,
-- la parte del email anterior a la @.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_color)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Miembro'
    ),
    public.avatar_color_for(new.id)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 4. Helpers SECURITY DEFINER para las políticas
--    (search_path fijo: no dependen del rol que llama y no esquivan sus RLS)
-- -----------------------------------------------------------------------------

-- ¿El usuario autenticado es miembro del espacio?
create or replace function public.is_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
  );
$$;

-- ¿Es el propietario del espacio?
create or replace function public.is_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

-- ¿Puede el usuario ver ese chat? Equivale a canAccessChatId de firestore.rules:
-- hay que ser miembro y, si el chat es un dm, estar en member_ids.
create or replace function public.can_access_chat(p_workspace_id uuid, p_chat_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_member(p_workspace_id)
    and exists (
      select 1
      from public.chats c
      where c.workspace_id = p_workspace_id
        and c.id = p_chat_id
        and (c.type in ('group', 'posts') or auth.uid() = any (c.member_ids))
    );
$$;

-- Primer segmento de la ruta de Storage como uuid, o null si no es un uuid
-- (evita que un objeto con nombre raro reviente la política con un cast).
create or replace function public.storage_workspace_id(p_object_name text)
returns uuid
language plpgsql
stable
as $$
declare
  v_first text := split_part(p_object_name, '/', 1);
begin
  if v_first ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v_first::uuid;
  end if;
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Triggers de mensajes
-- -----------------------------------------------------------------------------

-- (a) Hilo: el padre de un mensaje con thread_parent_id suma +1 en
--     thread_count y se marca last_reply_at. SECURITY DEFINER porque el
--     cliente no tiene permiso para tocar esas columnas.
create or replace function public.messages_bump_thread()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.messages
     set thread_count = thread_count + 1,
         last_reply_at = now()
   where id = new.thread_parent_id;
  return null;
end;
$$;

-- Validación del hilo: el padre tiene que existir y estar en el MISMO chat.
-- Evita que un miembro con acceso a un dm incremente el contador de un post
-- de otro chat del espacio.
create or replace function public.messages_validate_thread()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.thread_parent_id is not null and not exists (
    select 1
    from public.messages m
    where m.id = new.thread_parent_id
      and m.workspace_id = new.workspace_id
      and m.chat_id = new.chat_id
  ) then
    raise exception 'El mensaje padre del hilo no existe en este chat'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

-- (b) Preview: al insertar un mensaje SIN thread_parent_id y de type
--     user/post/ai, el chat actualiza last_message y updated_at.
--     Los type 'system' y las respuestas de hilo NO tocan el preview (misma
--     regla que `updatesChatPreview` en src/lib/chat/preview.ts).
--     SECURITY DEFINER: la actualización interna del chat no depende de que el
--     autor del mensaje tenga permiso sobre la fila del chat.
create or replace function public.messages_update_chat_preview()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.chats
     set last_message = jsonb_build_object(
           'text', new.text,
           'authorId', new.author_id,
           'authorName', new.author_name,
           'type', new.type,
           'createdAt', new.created_at
         ),
         updated_at = now()
   where workspace_id = new.workspace_id
     and id = new.chat_id;
  return null;
end;
$$;

-- (c) Guard de UPDATE en messages: el autor solo puede tocar
--     text, mentions, edited_at y deleted. thread_count / last_reply_at los
--     cambia el propio trigger de hilo, que se dispara anidado (por eso se
--     comprueba pg_trigger_depth()), y la service role (Edge Functions) tiene
--     vía libre, igual que ya esquivaba las RLS.
create or replace function public.messages_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' or pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.chat_id is distinct from old.chat_id
     or new.author_id is distinct from old.author_id
     or new.author_name is distinct from old.author_name
     or new.type is distinct from old.type
     or new.created_at is distinct from old.created_at
     or new.thread_parent_id is distinct from old.thread_parent_id
     or new.thread_count is distinct from old.thread_count
     or new.last_reply_at is distinct from old.last_reply_at
     or new.reply_to is distinct from old.reply_to
     or new.attachments is distinct from old.attachments
  then
    raise exception
      'En un mensaje solo se pueden modificar text, mentions, edited_at y deleted'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_validate_thread on public.messages;
create trigger messages_validate_thread
  before insert on public.messages
  for each row execute function public.messages_validate_thread();

drop trigger if exists messages_guard_update on public.messages;
create trigger messages_guard_update
  before update on public.messages
  for each row execute function public.messages_guard_update();

drop trigger if exists messages_bump_thread on public.messages;
create trigger messages_bump_thread
  after insert on public.messages
  for each row
  when (new.thread_parent_id is not null)
  execute function public.messages_bump_thread();

drop trigger if exists messages_update_chat_preview on public.messages;
create trigger messages_update_chat_preview
  after insert on public.messages
  for each row
  when (new.thread_parent_id is null and new.type in ('user', 'post', 'ai'))
  execute function public.messages_update_chat_preview();

-- -----------------------------------------------------------------------------
-- 6. Triggers de chats y members
-- -----------------------------------------------------------------------------

-- (d) updated_at automático. Los triggers BEFORE se ejecutan en orden alfabético
--     del nombre, así que el guard ('chats_guard...') va antes que el toque
--     ('chats_touch...').
drop trigger if exists chats_touch_updated_at on public.chats;
create trigger chats_touch_updated_at
  before update on public.chats
  for each row execute function public.touch_updated_at();

drop trigger if exists workspaces_touch_updated_at on public.workspaces;
create trigger workspaces_touch_updated_at
  before update on public.workspaces
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists ai_chats_touch_updated_at on public.ai_chats;
create trigger ai_chats_touch_updated_at
  before update on public.ai_chats
  for each row execute function public.touch_updated_at();

drop trigger if exists push_tokens_touch_updated_at on public.push_tokens;
create trigger push_tokens_touch_updated_at
  before update on public.push_tokens
  for each row execute function public.touch_updated_at();

-- Guard de UPDATE en chats: last_message y updated_at los mantiene el trigger
-- de preview; cambiar type o member_ids (y por tanto añadir gente a un dm) es
-- solo del creador del chat o de un owner del espacio.
create or replace function public.chats_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' or pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.id is distinct from old.id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.last_message is distinct from old.last_message
     or new.updated_at is distinct from old.updated_at
  then
    raise exception
      'En un chat solo se pueden modificar name, emoji, type y member_ids'
      using errcode = 'insufficient_privilege';
  end if;

  if (new.type is distinct from old.type or new.member_ids is distinct from old.member_ids)
     and old.created_by is distinct from auth.uid()
     and not public.is_owner(old.workspace_id)
  then
    raise exception
      'Solo quien creó el chat o el owner del espacio puede cambiar type o member_ids'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists chats_guard_update on public.chats;
create trigger chats_guard_update
  before update on public.chats
  for each row execute function public.chats_guard_update();

-- Cada miembro puede cambiar su propio display_name; el rol, el uid y la
-- pertenencia los mueve el owner.
create or replace function public.workspace_members_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' or pg_trigger_depth() > 1 then
    return new;
  end if;

  if not public.is_owner(old.workspace_id) and (
       new.workspace_id is distinct from old.workspace_id
    or new.user_id is distinct from old.user_id
    or new.role is distinct from old.role
    or new.joined_at is distinct from old.joined_at
  ) then
    raise exception
      'Un miembro solo puede cambiar su propio display_name; el rol lo cambia el owner'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_members_guard_update on public.workspace_members;
create trigger workspace_members_guard_update
  before update on public.workspace_members
  for each row execute function public.workspace_members_guard_update();

-- -----------------------------------------------------------------------------
-- 7. RPC de alta de espacio (equivalente al batch de T8/createWorkspace)
-- -----------------------------------------------------------------------------

-- Crea espacio + miembro owner + chats 'general' y 'posts', y deja el espacio
-- como actual del perfil. Todo en una transacción. SECURITY DEFINER porque el
-- cliente no tiene permiso de INSERT en workspaces ni en workspace_members.
create or replace function public.create_workspace(p_name text, p_emoji text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_emoji text;
  v_display text;
  v_ws uuid;
begin
  if v_uid is null then
    raise exception 'Hay que iniciar sesión para crear un espacio'
      using errcode = 'insufficient_privilege';
  end if;

  v_name := btrim(coalesce(p_name, ''));
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'El nombre del espacio debe tener entre 1 y 40 caracteres'
      using errcode = 'check_violation';
  end if;

  v_emoji := coalesce(nullif(btrim(coalesce(p_emoji, '')), ''), '🏠');

  select coalesce(nullif(btrim(display_name), ''), 'Miembro')
    into v_display
    from public.profiles
   where id = v_uid;

  insert into public.workspaces (name, emoji, created_by)
  values (v_name, v_emoji, v_uid)
  returning id into v_ws;

  insert into public.workspace_members (workspace_id, user_id, role, display_name)
  values (v_ws, v_uid, 'owner', coalesce(v_display, 'Miembro'));

  insert into public.chats (workspace_id, id, type, name, emoji, member_ids, created_by)
  values
    (v_ws, 'general', 'group',    'General',       '💬', '{}'::uuid[], v_uid),
    (v_ws, 'posts',  'posts',    'Publicaciones', '📰', '{}'::uuid[], v_uid);

  update public.profiles
     set current_workspace_id = v_ws,
         updated_at = now()
   where id = v_uid;

  return v_ws;
end;
$$;

comment on function public.create_workspace(text, text) is
  'Alta de espacio del onboarding (T20): espacio + owner + chats general/posts.';

-- Idempotente: la llama T22 cuando un espacio anterior a las publicaciones no
-- tiene el chat 'posts'. Devuelve true si lo acaba de crear, false si ya estaba.
create or replace function public.ensure_posts_chat(p_workspace_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Hay que iniciar sesión'
      using errcode = 'insufficient_privilege';
  end if;

  if not public.is_member(p_workspace_id) then
    raise exception 'No eres miembro de ese espacio'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.chats (workspace_id, id, type, name, emoji, member_ids, created_by)
  values (p_workspace_id, 'posts', 'posts', 'Publicaciones', '📰', '{}'::uuid[], v_uid)
  on conflict (workspace_id, id) do nothing;

  return found;
end;
$$;

comment on function public.ensure_posts_chat(uuid) is
  'Crea el chat ''posts'' de un espacio antiguo si falta. Idempotente.';

-- -----------------------------------------------------------------------------
-- 8. Vistas lógicas
-- -----------------------------------------------------------------------------

-- Publicaciones = mensajes type 'post' del chat 'posts' sin padre de hilo.
-- security_invoker: las RLS de messages y chats se siguen aplicando (sin esto
-- la vista saltaría el aislamiento del espacio).
create or replace view public.posts
  with (security_invoker = true) as
select
  m.id,
  m.workspace_id,
  m.author_id,
  m.author_name,
  m.text,
  m.mentions,
  m.thread_count,
  m.last_reply_at,
  m.attachments,
  m.edited_at,
  m.deleted,
  m.created_at
from public.messages m
join public.chats c
  on c.workspace_id = m.workspace_id
 and c.id = m.chat_id
where m.type = 'post'
  and m.thread_parent_id is null
  and c.type = 'posts';

comment on view public.posts is
  'Feed de publicaciones (mensajes type ''post''). Aplica RLS de messages y chats.';

-- "Me gusta" = reacción ❤️ sobre una publicación.
create or replace view public.post_likes
  with (security_invoker = true) as
select
  r.message_id as post_id,
  r.user_id,
  r.created_at
from public.message_reactions r
join public.messages m on m.id = r.message_id
where r.emoji = '❤️'
  and m.type = 'post';

comment on view public.post_likes is
  'Likes de publicaciones (reacción ❤️). Aplica RLS de message_reactions y messages.';

-- -----------------------------------------------------------------------------
-- 9. Realtime
--    Postgres Changes sobre messages, message_reactions, chats y chat_reads.
--    (Typing y presencia van por Broadcast y Presence en T21.)
-- -----------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array['messages', 'message_reactions', 'chats', 'chat_reads'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 10. Storage
--     attachments: privado, ruta {workspace_id}/{chat_id}/..., solo miembros.
--     avatars: lectura pública, escritura solo en {uid}/.
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, '52428800'), -- 50 MiB
       ('avatars', 'avatars', true, '5242880')             -- 5 MiB
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- attachments · leer: solo quien es miembro del espacio de la primera carpeta.
drop policy if exists "attachments: leer los adjuntos de mi espacio" on storage.objects;
create policy "attachments: leer los adjuntos de mi espacio"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'attachments'
    and public.is_member(public.storage_workspace_id(name))
  );

-- attachments · subir: mismo criterio que leer.
drop policy if exists "attachments: subir adjuntos a mi espacio" on storage.objects;
create policy "attachments: subir adjuntos a mi espacio"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'attachments'
    and public.is_member(public.storage_workspace_id(name))
  );

-- attachments · reemplazar un adjunto propio del espacio.
drop policy if exists "attachments: reemplazar adjuntos de mi espacio" on storage.objects;
create policy "attachments: reemplazar adjuntos de mi espacio"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'attachments'
    and public.is_member(public.storage_workspace_id(name))
  )
  with check (
    bucket_id = 'attachments'
    and public.is_member(public.storage_workspace_id(name))
  );

-- attachments · borrar.
drop policy if exists "attachments: borrar adjuntos de mi espacio" on storage.objects;
create policy "attachments: borrar adjuntos de mi espacio"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'attachments'
    and public.is_member(public.storage_workspace_id(name))
  );

-- avatars · leer: el bucket es público (URLs de avatar en la UI).
drop policy if exists "avatars: lectura publica" on storage.objects;
create policy "avatars: lectura publica"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'avatars');

-- avatars · subir: solo en tu propia carpeta {uid}/.
drop policy if exists "avatars: subir a mi carpeta" on storage.objects;
create policy "avatars: subir a mi carpeta"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- avatars · reemplazar y borrar: también solo en tu carpeta.
drop policy if exists "avatars: reemplazar en mi carpeta" on storage.objects;
create policy "avatars: reemplazar en mi carpeta"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars: borrar de mi carpeta" on storage.objects;
create policy "avatars: borrar de mi carpeta"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- -----------------------------------------------------------------------------
-- 11. RLS
--     Equivalente a firestore.rules. Todas las tablas con RLS activado; la
--     ausencia de política equivale a "denegado".
-- -----------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.workspace_members enable row level security;
alter table public.chats enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.chat_reads enable row level security;
alter table public.ai_chats enable row level security;
alter table public.ai_messages enable row level security;
alter table public.push_tokens enable row level security;

-- --- profiles ---------------------------------------------------------------
-- Leer: solo el propio perfil (equivale a users/{uid} con isSelf(uid)).
drop policy if exists "profiles: leer solo el propio perfil" on public.profiles;
create policy "profiles: leer solo el propio perfil"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- Editar: solo el propio, y sin poder cambiar la clave primaria (el WITH CHECK).
drop policy if exists "profiles: editar solo el propio perfil" on public.profiles;
create policy "profiles: editar solo el propio perfil"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No hay política de INSERT: el perfil lo crea el trigger de auth.users.
-- No hay política de DELETE: el perfil se borra con la cuenta de auth.

-- --- workspaces -------------------------------------------------------------
-- Leer: solo miembros del espacio.
drop policy if exists "workspaces: leer si soy miembro" on public.workspaces;
create policy "workspaces: leer si soy miembro"
  on public.workspaces
  for select
  to authenticated
  using (public.is_member(id));

-- Insertar: no hay política. El alta solo existe por la RPC create_workspace.
-- Editar: solo el owner (y no puede cambiar created_by).
drop policy if exists "workspaces: editar solo el owner" on public.workspaces;
create policy "workspaces: editar solo el owner"
  on public.workspaces
  for update
  to authenticated
  using (public.is_owner(id))
  with check (public.is_owner(id) and created_by is not distinct from auth.uid());

-- Borrar: solo el owner.
drop policy if exists "workspaces: borrar solo el owner" on public.workspaces;
create policy "workspaces: borrar solo el owner"
  on public.workspaces
  for delete
  to authenticated
  using (public.is_owner(id) and created_by is not distinct from auth.uid());

-- --- workspace_members ------------------------------------------------------
-- Leer la lista de miembros: cualquier miembro del espacio.
drop policy if exists "members: leer si soy miembro del espacio" on public.workspace_members;
create policy "members: leer si soy miembro del espacio"
  on public.workspace_members
  for select
  to authenticated
  using (public.is_member(workspace_id));

-- Alta de miembros: solo el owner (el creador se añade a sí mismo en el RPC).
drop policy if exists "members: el owner anade miembros" on public.workspace_members;
create policy "members: el owner anade miembros"
  on public.workspace_members
  for insert
  to authenticated
  with check (public.is_owner(workspace_id));

-- Quitar miembros: solo el owner.
drop policy if exists "members: el owner quita miembros" on public.workspace_members;
create policy "members: el owner quita miembros"
  on public.workspace_members
  for delete
  to authenticated
  using (public.is_owner(workspace_id));

-- Editar: dos políticas permisivas (se ORean).
--   1) el owner puede cambiar el rol de quien quiera;
--   2) cada uno cambia su fila; el trigger workspace_members_guard_update le
--      impide tocar role/user_id/workspace_id si no es owner.
drop policy if exists "members: el owner cambia roles" on public.workspace_members;
create policy "members: el owner cambia roles"
  on public.workspace_members
  for update
  to authenticated
  using (public.is_owner(workspace_id))
  with check (public.is_owner(workspace_id));

drop policy if exists "members: cada uno cambia su display_name" on public.workspace_members;
create policy "members: cada uno cambia su display_name"
  on public.workspace_members
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- chats ------------------------------------------------------------------
-- Leer: grupo y posts los ve todo el espacio; un dm, solo sus member_ids.
drop policy if exists "chats: leer los chats a los que tengo acceso" on public.chats;
create policy "chats: leer los chats a los que tengo acceso"
  on public.chats
  for select
  to authenticated
  using (public.can_access_chat(workspace_id, id));

-- Crear: hay que ser miembro, ser el creador y usar type group/dm/posts.
-- En un dm hay que estar uno mismo en member_ids.
drop policy if exists "chats: crear si soy miembro" on public.chats;
create policy "chats: crear si soy miembro"
  on public.chats
  for insert
  to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
    and type in ('group', 'dm', 'posts')
    and (type <> 'dm' or auth.uid() = any (member_ids))
  );

-- Editar: quien tenga acceso. El trigger chats_guard_update deja cambiar solo
-- name/emoji (y type/member_ids si eres el creador o el owner) y bloquea que el
-- cliente se escriba su propio preview.
drop policy if exists "chats: editar si tengo acceso" on public.chats;
create policy "chats: editar si tengo acceso"
  on public.chats
  for update
  to authenticated
  using (public.can_access_chat(workspace_id, id))
  with check (public.can_access_chat(workspace_id, id));

-- Borrar: el creador del chat o el owner del espacio.
drop policy if exists "chats: borrar el creador o el owner" on public.chats;
create policy "chats: borrar el creador o el owner"
  on public.chats
  for delete
  to authenticated
  using (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_owner(workspace_id))
  );

-- --- messages ---------------------------------------------------------------
-- Leer: los mensajes de los chats a los que tengo acceso.
drop policy if exists "messages: leer los chats a los que tengo acceso" on public.messages;
create policy "messages: leer los chats a los que tengo acceso"
  on public.messages
  for select
  to authenticated
  using (public.can_access_chat(workspace_id, chat_id));

-- Crear: hay que ser el autor, tener acceso al chat y usar type user/system/post.
-- type 'ai' queda fuera a propósito: solo la service role (Edge Function de T23).
drop policy if exists "messages: enviar mensajes como yo" on public.messages;
create policy "messages: enviar mensajes como yo"
  on public.messages
  for insert
  to authenticated
  with check (
    public.can_access_chat(workspace_id, chat_id)
    and author_id is not distinct from auth.uid()
    and type in ('user', 'system', 'post')
  );

-- Editar: solo el autor. El trigger messages_guard_update limita las columnas
-- a text, mentions, edited_at y deleted (borrado en suave).
drop policy if exists "messages: editar solo mis mensajes" on public.messages;
create policy "messages: editar solo mis mensajes"
  on public.messages
  for update
  to authenticated
  using (author_id is not distinct from auth.uid())
  with check (author_id is not distinct from auth.uid());

-- Sin política de DELETE: el borrado es soft (columna `deleted`).

-- --- message_reactions ------------------------------------------------------
-- Leer: reacciones de mensajes que puedo ver.
drop policy if exists "reacciones: leer las de los mensajes que veo" on public.message_reactions;
create policy "reacciones: leer las de los mensajes que veo"
  on public.message_reactions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.messages m
      where m.id = message_id
        and public.can_access_chat(m.workspace_id, m.chat_id)
    )
  );

-- Reaccionar: solo con tu propio user_id (equivale al check de Firestore de que
-- la reacción solo puede añadir o quitar tu uid).
drop policy if exists "reacciones: reaccionar con mi uid" on public.message_reactions;
create policy "reacciones: reaccionar con mi uid"
  on public.message_reactions
  for insert
  to authenticated
  with check (
    user_id is not distinct from auth.uid()
    and exists (
      select 1
      from public.messages m
      where m.id = message_id
        and public.can_access_chat(m.workspace_id, m.chat_id)
    )
  );

-- Quitar: solo la mía.
drop policy if exists "reacciones: quitar solo mi reaccion" on public.message_reactions;
create policy "reacciones: quitar solo mi reaccion"
  on public.message_reactions
  for delete
  to authenticated
  using (user_id is not distinct from auth.uid());

-- --- chat_reads -------------------------------------------------------------
-- Cada uno ve la fila de otro miembro del chat (para el contador de no leídos).
drop policy if exists "lecturas: ver las del chat" on public.chat_reads;
create policy "lecturas: ver las del chat"
  on public.chat_reads
  for select
  to authenticated
  using (public.can_access_chat(workspace_id, chat_id));

-- Escribir: solo mi marca.
drop policy if exists "lecturas: escribir solo mi marca" on public.chat_reads;
create policy "lecturas: escribir solo mi marca"
  on public.chat_reads
  for insert
  to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "lecturas: actualizar solo mi marca" on public.chat_reads;
create policy "lecturas: actualizar solo mi marca"
  on public.chat_reads
  for update
  to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

drop policy if exists "lecturas: borrar solo mi marca" on public.chat_reads;
create policy "lecturas: borrar solo mi marca"
  on public.chat_reads
  for delete
  to authenticated
  using (user_id is not distinct from auth.uid());

-- --- ai_chats ---------------------------------------------------------------
-- Chat privado de Loki IA: solo su dueño.
drop policy if exists "ai_chats: ver solo mis chats" on public.ai_chats;
create policy "ai_chats: ver solo mis chats"
  on public.ai_chats
  for select
  to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "ai_chats: crear mi chat" on public.ai_chats;
create policy "ai_chats: crear mi chat"
  on public.ai_chats
  for insert
  to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "ai_chats: editar mi chat" on public.ai_chats;
create policy "ai_chats: editar mi chat"
  on public.ai_chats
  for update
  to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

drop policy if exists "ai_chats: borrar mi chat" on public.ai_chats;
create policy "ai_chats: borrar mi chat"
  on public.ai_chats
  for delete
  to authenticated
  using (user_id is not distinct from auth.uid());

-- --- ai_messages ------------------------------------------------------------
-- Leer: los mensajes de mi propio chat de IA.
drop policy if exists "ai_messages: leer los de mi chat" on public.ai_messages;
create policy "ai_messages: leer los de mi chat"
  on public.ai_messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.ai_chats c
      where c.id = chat_id
        and c.user_id is not distinct from auth.uid()
    )
  );

-- Escribir: solo la pregunta del usuario (type 'user'). La respuesta de Loki
-- (type 'ai') la guarda la Edge Function con la service role.
drop policy if exists "ai_messages: enviar solo preguntas" on public.ai_messages;
create policy "ai_messages: enviar solo preguntas"
  on public.ai_messages
  for insert
  to authenticated
  with check (
    type = 'user'
    and exists (
      select 1
      from public.ai_chats c
      where c.id = chat_id
        and c.user_id is not distinct from auth.uid()
    )
  );

-- --- push_tokens ------------------------------------------------------------
-- Tokens FCM: cada uno ve y gestiona solo los suyos.
drop policy if exists "push_tokens: ver solo mis tokens" on public.push_tokens;
create policy "push_tokens: ver solo mis tokens"
  on public.push_tokens
  for select
  to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "push_tokens: registrar mi token" on public.push_tokens;
create policy "push_tokens: registrar mi token"
  on public.push_tokens
  for insert
  to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "push_tokens: actualizar mi token" on public.push_tokens;
create policy "push_tokens: actualizar mi token"
  on public.push_tokens
  for update
  to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

drop policy if exists "push_tokens: borrar mi token" on public.push_tokens;
create policy "push_tokens: borrar mi token"
  on public.push_tokens
  for delete
  to authenticated
  using (user_id is not distinct from auth.uid());

-- -----------------------------------------------------------------------------
-- 12. Privilegios
--     Las políticas ya son la puerta; esto solo evita 404/403 confusos por
--     falta de GRANT (auto_expose_new_tables viene activo, pero no confiamos).
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on
  public.workspaces,
  public.profiles,
  public.workspace_members,
  public.chats,
  public.messages,
  public.message_reactions,
  public.chat_reads,
  public.ai_chats,
  public.ai_messages,
  public.push_tokens
  to authenticated;

grant select on
  public.workspaces,
  public.profiles,
  public.workspace_members,
  public.chats,
  public.messages,
  public.message_reactions,
  public.chat_reads,
  public.ai_chats,
  public.ai_messages,
  public.push_tokens
  to anon;

grant select on public.posts, public.post_likes to authenticated, anon;

-- Las RPC solo se ofrecen a usuarios con sesión; anon se queda sin ellas.
revoke execute on function public.create_workspace(text, text) from anon;
revoke execute on function public.ensure_posts_chat(uuid) from anon;
grant execute on function public.create_workspace(text, text) to authenticated;
grant execute on function public.ensure_posts_chat(uuid) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;
grant execute on function public.can_access_chat(uuid, text) to authenticated;
