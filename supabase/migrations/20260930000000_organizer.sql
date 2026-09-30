-- =============================================================================
-- Loki · organizador (calendario, proyectos, notificaciones, invitaciones).
-- NUEVA migración: no toca la de T19. Tablas, RLS, triggers, pg_cron y
-- realtime para notificaciones.
--
-- Convenciones heredadas: snake_case, helpers SECURITY DEFINER con
-- search_path fijo, políticas comentadas en español, GRANTs explícitos.
-- Todo lo que puede fallar por entorno (pg_cron/pg_net ausentes) va en
-- bloques con EXCEPTION para no romper `sb:reset`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Helper: ¿owner o admin del espacio?
-- -----------------------------------------------------------------------------

create or replace function public.is_space_admin(p_workspace_id uuid)
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
      and m.role in ('owner', 'admin')
  );
$$;

-- -----------------------------------------------------------------------------
-- 1. Tablas (generate_invite_code va antes: es el DEFAULT de invites.code)
-- -----------------------------------------------------------------------------

-- Código de 8 caracteres sin 0/O/1/I (no se confunden al dictarlos).
create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_tries integer := 0;
begin
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    v_tries := v_tries + 1;
    exit when not exists (select 1 from public.invites where code = v_code);
    if v_tries > 20 then
      raise exception 'No se pudo generar un código único' using errcode = 'unique_violation';
    end if;
  end loop;
  return v_code;
end;
$$;

-- Proyectos del espacio.
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '',
  emoji text not null default '📁' check (char_length(btrim(emoji)) between 1 and 16),
  color text not null default '#1d9bf0',
  status text not null default 'active' check (status in ('active', 'archived')),
  due_date date,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.projects is
  'Proyectos del espacio. El progreso sale de la vista project_progress.';

-- Tareas. `position` ordena dentro de cada columna del tablero (mayor = más
-- abajo); las subtareas cuelgan de `parent_task_id`.
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  notes text not null default '',
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  assignee_ids uuid[] not null default '{}',
  due_at timestamptz,
  reminder_at timestamptz,
  position numeric not null default 0,
  parent_task_id uuid references public.tasks (id) on delete cascade,
  completed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tasks is
  'Tareas de proyecto, con subtareas (parent_task_id) y kanban (status/position).';

-- Progreso hechas/total por proyecto (RLS de tasks vía security_invoker).
create or replace view public.project_progress
  with (security_invoker = true) as
select
  t.project_id as project_id,
  count(*)::int as total,
  count(*) filter (where t.status = 'done')::int as done
from public.tasks t
where t.parent_task_id is null
group by t.project_id;

comment on view public.project_progress is
  'Progreso por proyecto (solo tareas raíz). Aplica la RLS de tasks.';

-- Eventos del calendario del espacio.
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at >= starts_at),
  all_day boolean not null default false,
  location text not null default '',
  color text not null default '#1d9bf0',
  created_by uuid references auth.users (id) on delete set null,
  attendees uuid[] not null default '{}',
  reminder_minutes integer[] not null default '{}',
  recurrence text check (recurrence is null or recurrence in ('daily', 'weekly', 'monthly')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.events is
  'Eventos del calendario. La recurrencia se expande en el cliente.';

-- Ideas del espacio, convertibles en tarea.
create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  detail text not null default '',
  tag text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  converted_task_id uuid references public.tasks (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ideas is
  'Ideas del espacio. Convertir = crear tarea y apuntar converted_task_id.';

-- Notificaciones por usuario. `dedupe` evita duplicados del job de
-- recordatorios (índice único parcial: solo cuando viene con clave).
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  type text not null check (type in ('mention', 'reply', 'reaction', 'task_assigned', 'task_due', 'event_reminder', 'invite', 'ai_alert')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null default '',
  link text not null default '',
  read_at timestamptz,
  dedupe text,
  created_at timestamptz not null default now()
);

create unique index if not exists notifications_dedupe_uidx
  on public.notifications (user_id, dedupe)
  where dedupe is not null;

comment on table public.notifications is
  'Bandeja por usuario. La crean triggers, el job de recordatorios y la app.';

-- Preferencias de notificación (interruptores por tipo + horario de silencio).
create table if not exists public.notification_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  mention boolean not null default true,
  reply boolean not null default true,
  reaction boolean not null default true,
  task_assigned boolean not null default true,
  task_due boolean not null default true,
  event_reminder boolean not null default true,
  invite boolean not null default true,
  ai_alert boolean not null default true,
  quiet_start time,
  quiet_end time,
  updated_at timestamptz not null default now()
);

comment on table public.notification_prefs is
  'Interruptores por tipo y silencio nocturno. Sin fila = todo activado.';

-- Invitaciones por código (8 caracteres sin 0/O/1/I).
create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default public.generate_invite_code(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  role text not null default 'member' check (role in ('member', 'admin')),
  expires_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  uses integer not null default 0 check (uses >= 0),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.invites is
  'Códigos de invitación por espacio. El alta va por accept_invite(code).';

-- -----------------------------------------------------------------------------
-- 2. updated_at automático
-- -----------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array['projects', 'tasks', 'events', 'ideas', 'notification_prefs'] loop
    if not exists (
      select 1 from pg_trigger
      where tgname = 'touch_updated_at_' || v_table
    ) then
      execute format(
        'create trigger touch_updated_at_%I before update on public.%I ' ||
        'for each row execute function public.touch_updated_at()',
        v_table, v_table
      );
    end if;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.events enable row level security;
alter table public.ideas enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.invites enable row level security;

-- --- projects: el espacio lee; el alta es de miembros; editar/borrar,
--     creador o admin.
drop policy if exists "projects: leer si soy miembro" on public.projects;
create policy "projects: leer si soy miembro"
  on public.projects for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "projects: crear si soy miembro" on public.projects;
create policy "projects: crear si soy miembro"
  on public.projects for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
  );

drop policy if exists "projects: editar creador o admin" on public.projects;
create policy "projects: editar creador o admin"
  on public.projects for update to authenticated
  using (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  )
  with check (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

drop policy if exists "projects: borrar creador o admin" on public.projects;
create policy "projects: borrar creador o admin"
  on public.projects for delete to authenticated
  using (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

-- --- tasks: el espacio lee y edita (kanban y checks son de todos);
--     el alta es de miembros; borrar, creador o admin.
drop policy if exists "tasks: leer si soy miembro" on public.tasks;
create policy "tasks: leer si soy miembro"
  on public.tasks for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "tasks: crear si soy miembro" on public.tasks;
create policy "tasks: crear si soy miembro"
  on public.tasks for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and public.is_member((select p.workspace_id from public.projects p where p.id = project_id))
    and created_by is not distinct from auth.uid()
    and (
      parent_task_id is null
      or exists (
        select 1 from public.tasks t
        where t.id = parent_task_id and t.project_id = project_id
      )
    )
  );

drop policy if exists "tasks: editar si soy miembro" on public.tasks;
create policy "tasks: editar si soy miembro"
  on public.tasks for update to authenticated
  using (public.is_member(workspace_id))
  with check (public.is_member(workspace_id));

drop policy if exists "tasks: borrar creador o admin" on public.tasks;
create policy "tasks: borrar creador o admin"
  on public.tasks for delete to authenticated
  using (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

-- --- events: el espacio lee; crear, miembros; editar/borrar, creador o admin.
drop policy if exists "events: leer si soy miembro" on public.events;
create policy "events: leer si soy miembro"
  on public.events for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "events: crear si soy miembro" on public.events;
create policy "events: crear si soy miembro"
  on public.events for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
    and (
      project_id is null
      or exists (
        select 1 from public.projects p
        where p.id = project_id and p.workspace_id = workspace_id
      )
    )
  );

drop policy if exists "events: editar creador o admin" on public.events;
create policy "events: editar creador o admin"
  on public.events for update to authenticated
  using (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  )
  with check (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

drop policy if exists "events: borrar creador o admin" on public.events;
create policy "events: borrar creador o admin"
  on public.events for delete to authenticated
  using (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

-- --- ideas: igual que events.
drop policy if exists "ideas: leer si soy miembro" on public.ideas;
create policy "ideas: leer si soy miembro"
  on public.ideas for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "ideas: crear si soy miembro" on public.ideas;
create policy "ideas: crear si soy miembro"
  on public.ideas for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
  );

drop policy if exists "ideas: editar creador o admin" on public.ideas;
create policy "ideas: editar creador o admin"
  on public.ideas for update to authenticated
  using (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  )
  with check (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

drop policy if exists "ideas: borrar creador o admin" on public.ideas;
create policy "ideas: borrar creador o admin"
  on public.ideas for delete to authenticated
  using (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

-- --- notifications: cada usuario solo las suyas.
drop policy if exists "notifications: ver solo las mias" on public.notifications;
create policy "notifications: ver solo las mias"
  on public.notifications for select to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "notifications: crear solo las mias" on public.notifications;
create policy "notifications: crear solo las mias"
  on public.notifications for insert to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "notifications: editar solo las mias" on public.notifications;
create policy "notifications: editar solo las mias"
  on public.notifications for update to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

drop policy if exists "notifications: borrar solo las mias" on public.notifications;
create policy "notifications: borrar solo las mias"
  on public.notifications for delete to authenticated
  using (user_id is not distinct from auth.uid());

-- --- notification_prefs: cada usuario solo las suyas.
drop policy if exists "prefs: ver solo las mias" on public.notification_prefs;
create policy "prefs: ver solo las mias"
  on public.notification_prefs for select to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "prefs: guardar solo las mias" on public.notification_prefs;
create policy "prefs: guardar solo las mias"
  on public.notification_prefs for insert to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "prefs: editar solo las mias" on public.notification_prefs;
create policy "prefs: editar solo las mias"
  on public.notification_prefs for update to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

-- --- invites: el espacio las ve; solo admins crean, editan (revocar) y
--     borran. El alta de miembros va por accept_invite(code).
drop policy if exists "invites: leer si soy miembro" on public.invites;
create policy "invites: leer si soy miembro"
  on public.invites for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "invites: crear solo admins" on public.invites;
create policy "invites: crear solo admins"
  on public.invites for insert to authenticated
  with check (public.is_space_admin(workspace_id));

drop policy if exists "invites: editar solo admins" on public.invites;
create policy "invites: editar solo admins"
  on public.invites for update to authenticated
  using (public.is_space_admin(workspace_id))
  with check (public.is_space_admin(workspace_id));

drop policy if exists "invites: borrar solo admins" on public.invites;
create policy "invites: borrar solo admins"
  on public.invites for delete to authenticated
  using (public.is_space_admin(workspace_id));

-- -----------------------------------------------------------------------------
-- 4. accept_invite (generate_invite_code quedó arriba, junto a las tablas)
-- -----------------------------------------------------------------------------

-- Unirse con código: valida, suma la membresía, cuenta el uso y avisa al
-- invitador. Idempotente si ya eras miembro (no consume uso).
create or replace function public.accept_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_invite public.invites%rowtype;
  v_ws_name text;
  v_display text;
  v_joined boolean := false;
begin
  if v_uid is null then
    raise exception 'Hay que iniciar sesión para unirse'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_invite
  from public.invites
  where code = upper(btrim(coalesce(p_code, '')));

  if v_invite.id is null then
    raise exception 'Ese código no existe. Revisa que esté bien escrito.'
      using errcode = 'check_violation';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'Esa invitación fue revocada.'
      using errcode = 'check_violation';
  end if;
  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
    raise exception 'Esa invitación caducó.'
      using errcode = 'check_violation';
  end if;
  if v_invite.max_uses is not null and v_invite.uses >= v_invite.max_uses then
    raise exception 'Esa invitación ya se usó todas las veces.'
      using errcode = 'check_violation';
  end if;

  select name into v_ws_name from public.workspaces where id = v_invite.workspace_id;
  select coalesce(nullif(btrim(display_name), ''), 'Miembro') into v_display
  from public.profiles where id = v_uid;

  insert into public.workspace_members (workspace_id, user_id, role, display_name)
  values (v_invite.workspace_id, v_uid, v_invite.role, coalesce(v_display, 'Miembro'))
  on conflict (workspace_id, user_id) do nothing;

  if found then
    v_joined := true;
    update public.invites set uses = uses + 1 where id = v_invite.id;
  end if;

  update public.profiles
  set current_workspace_id = v_invite.workspace_id, updated_at = now()
  where id = v_uid and current_workspace_id is null;

  -- Aviso al invitador (si no soy yo mismo).
  if v_invite.created_by is not null and v_invite.created_by <> v_uid then
    insert into public.notifications (user_id, workspace_id, type, title, body, link)
    values (
      v_invite.created_by,
      v_invite.workspace_id,
      'invite',
      coalesce(v_display, 'Alguien'),
      'se unió al espacio.',
      '/perfil'
    );
  end if;

  return jsonb_build_object(
    'workspace_id', v_invite.workspace_id,
    'workspace_name', coalesce(v_ws_name, ''),
    'joined', v_joined
  );
end;
$$;

comment on function public.accept_invite(text) is
  'Unirse a un espacio con código de invitación. Devuelve espacio y nombre.';

-- -----------------------------------------------------------------------------
-- 5. Notificaciones automáticas (triggers sobre mensajes, reacciones y tareas)
-- -----------------------------------------------------------------------------

-- Mención: una fila por uid mencionado (sin el autor ni "loki").
create or replace function public.notify_on_mention()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text;
begin
  foreach v_uid in array coalesce(new.mentions, '{}') loop
    if v_uid <> 'loki'
      and v_uid <> coalesce(new.author_id::text, '')
      and v_uid ~ '^[0-9a-fA-F-]{36}$'
    then
      begin
        insert into public.notifications (user_id, workspace_id, type, title, body, link)
        values (
          v_uid::uuid,
          new.workspace_id,
          'mention',
          coalesce(nullif(new.author_name, ''), 'Alguien'),
          'te mencionó: ' || left(coalesce(new.text, ''), 120),
          '/chat/c?id=' || new.chat_id
        );
      exception when others then
        -- Un uid que no es usuario (o borrado) no frena el mensaje.
        null;
      end;
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists notify_on_mention on public.messages;
create trigger notify_on_mention
  after insert on public.messages
  for each row execute function public.notify_on_mention();

-- Respuesta en hilo: avisa al autor del padre (sin avisarse a uno mismo).
create or replace function public.notify_on_thread_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent_author uuid;
begin
  select author_id into v_parent_author
  from public.messages where id = new.thread_parent_id;
  if v_parent_author is not null and v_parent_author <> coalesce(new.author_id, '00000000-0000-0000-0000-000000000000') then
    insert into public.notifications (user_id, workspace_id, type, title, body, link)
    values (
      v_parent_author,
      new.workspace_id,
      'reply',
      coalesce(nullif(new.author_name, ''), 'Alguien'),
      'respondió en tu hilo: ' || left(coalesce(new.text, ''), 120),
      '/chat/c?id=' || new.chat_id
    );
  end if;
  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists notify_on_thread_reply on public.messages;
create trigger notify_on_thread_reply
  after insert on public.messages
  for each row
  when (new.thread_parent_id is not null)
  execute function public.notify_on_thread_reply();

-- Reacción: avisa al autor del mensaje (sin avisarse a uno mismo).
create or replace function public.notify_on_reaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_msg record;
  v_name text;
begin
  select author_id, author_name, workspace_id, chat_id, text
    into v_msg
  from public.messages where id = new.message_id;
  if v_msg.author_id is null or v_msg.author_id = new.user_id then
    return null;
  end if;
  select coalesce(nullif(btrim(display_name), ''), 'Alguien') into v_name
  from public.profiles where id = new.user_id;
  insert into public.notifications (user_id, workspace_id, type, title, body, link)
  values (
    v_msg.author_id,
    v_msg.workspace_id,
    'reaction',
    coalesce(v_name, 'Alguien'),
    'reaccionó ' || new.emoji || ' a tu mensaje.',
    '/chat/c?id=' || v_msg.chat_id
  );
  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists notify_on_reaction on public.message_reactions;
create trigger notify_on_reaction
  after insert on public.message_reactions
  for each row execute function public.notify_on_reaction();

-- Tarea asignada: avisa a los nuevos responsables (sin el que la toca).
create or replace function public.notify_on_task_assigned()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old uuid[];
  v_new uuid[] := coalesce(new.assignee_ids, '{}');
  v_uid uuid;
  v_actor uuid := auth.uid();
begin
  -- En INSERT no hay OLD: todo responsable es nuevo.
  if tg_op = 'INSERT' then
    v_old := '{}';
  else
    v_old := coalesce(old.assignee_ids, '{}');
  end if;
  if tg_op = 'UPDATE' and v_old = v_new then
    return null;
  end if;
  foreach v_uid in array v_new loop
    if (tg_op = 'INSERT' or not (v_uid = any (v_old)))
      and (v_actor is null or v_uid <> v_actor)
    then
      begin
        insert into public.notifications (user_id, workspace_id, type, title, body, link)
        values (
          v_uid,
          new.workspace_id,
          'task_assigned',
          'Te asignaron una tarea',
          left(coalesce(new.title, ''), 120),
          '/proyectos?project=' || new.project_id || '&task=' || new.id
        );
      exception when others then
        null;
      end;
    end if;
  end loop;
  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists notify_on_task_assigned on public.tasks;
create trigger notify_on_task_assigned
  after insert or update on public.tasks
  for each row execute function public.notify_on_task_assigned();

-- Intento de push vía push-send (opt-in): solo si Manu configura
-- `loki.push_url` y `loki.push_key` en la base (ALTER DATABASE ... SET).
-- Sin ellos, o sin pg_net, no hace nada. Nunca rompe el insert.
create or replace function public.maybe_push_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_key text;
begin
  begin
    v_url := current_setting('loki.push_url', true);
    v_key := current_setting('loki.push_key', true);
  exception when others then
    return null;
  end;
  if v_url is null or v_url = '' or v_key is null or v_key = '' then
    return null;
  end if;
  begin
    -- pg_net vive en el esquema `extensions` en el stack de Supabase.
    perform extensions.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object(
        'user_id', new.user_id,
        'title', new.title,
        'body', new.body,
        'link', new.link
      )
    );
  exception when others then
    null;
  end;
  return null;
end;
$$;

drop trigger if exists maybe_push_notification on public.notifications;
create trigger maybe_push_notification
  after insert on public.notifications
  for each row execute function public.maybe_push_notification();

-- -----------------------------------------------------------------------------
-- 6. Recordatorios (pg_cron, texto fijo en español)
--
-- Cada 15 minutos crea `task_due` (vence en 24 h), `task_at` (reminder_at
-- alcanzado) y `event_reminder` (reminder_minutes alcanzado). La clave
-- `dedupe` hace cada aviso idempotente. La redacción es fija a propósito:
-- la base no guarda claves de LLM; la IA redacta solo en los flujos de
-- usuario (Edge Function loki-chat) cuando está configurada.
-- -----------------------------------------------------------------------------

create or replace function public.create_due_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created integer := 0;
  v_task record;
  v_event record;
  v_uid uuid;
  v_r integer;
  v_at timestamptz;
begin
  -- Tareas que vencen en 24 h (una por responsable; sin responsables, al creador).
  for v_task in
    select id, project_id, workspace_id, title, due_at, assignee_ids, created_by
    from public.tasks
    where status <> 'done'
      and due_at is not null
      and due_at <= now() + interval '24 hours'
  loop
    for v_uid in
      select distinct unnest(
        case when coalesce(array_length(v_task.assignee_ids, 1), 0) > 0
          then v_task.assignee_ids
          else array[v_task.created_by]
        end
      )
    loop
      if v_uid is null then continue; end if;
      begin
        insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
        values (
          v_uid,
          v_task.workspace_id,
          'task_due',
          'Tarea por vencer',
          '“' || left(v_task.title, 100) || '” vence pronto.',
          '/proyectos?project=' || v_task.project_id || '&task=' || v_task.id,
          'task-due:' || v_task.id
        )
        on conflict (user_id, dedupe) where dedupe is not null do nothing;
        if found then v_created := v_created + 1; end if;
      exception when others then null; end;
    end loop;
  end loop;

  -- Tareas con reminder_at alcanzado en la última hora.
  for v_task in
    select id, project_id, workspace_id, title, reminder_at, assignee_ids, created_by
    from public.tasks
    where status <> 'done'
      and reminder_at is not null
      and reminder_at <= now()
      and reminder_at >= now() - interval '1 hour'
  loop
    for v_uid in
      select distinct unnest(
        case when coalesce(array_length(v_task.assignee_ids, 1), 0) > 0
          then v_task.assignee_ids
          else array[v_task.created_by]
        end
      )
    loop
      if v_uid is null then continue; end if;
      begin
        insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
        values (
          v_uid,
          v_task.workspace_id,
          'task_due',
          'Recordatorio',
          '“' || left(v_task.title, 100) || '”.',
          '/proyectos?project=' || v_task.project_id || '&task=' || v_task.id,
          'task-rem:' || v_task.id || ':' || to_char(v_task.reminder_at, 'YYYYMMDDHH24MI')
        )
        on conflict (user_id, dedupe) where dedupe is not null do nothing;
        if found then v_created := v_created + 1; end if;
      exception when others then null; end;
    end loop;
  end loop;

  -- Eventos: cada reminder_minutes alcanzado en la última hora.
  for v_event in
    select id, workspace_id, title, starts_at, attendees, reminder_minutes
    from public.events
    where starts_at > now()
      and starts_at <= now() + interval '7 days'
      and coalesce(array_length(reminder_minutes, 1), 0) > 0
  loop
    foreach v_r in array v_event.reminder_minutes loop
      v_at := v_event.starts_at - (v_r || ' minutes')::interval;
      if v_at <= now() and v_at >= now() - interval '1 hour' then
        -- Asistentes, o todo el espacio si no hay.
        for v_uid in
          select distinct unnest(
            case when coalesce(array_length(v_event.attendees, 1), 0) > 0
              then v_event.attendees
              else array(
                select user_id from public.workspace_members
                where workspace_id = v_event.workspace_id
              )
            end
          )
        loop
          if v_uid is null then continue; end if;
          begin
            insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
            values (
              v_uid,
              v_event.workspace_id,
              'event_reminder',
              'Evento próximo',
              '“' || left(v_event.title, 100) || '” empieza pronto.',
              '/calendario',
              'event:' || v_event.id || ':' || v_r
            )
            on conflict (user_id, dedupe) where dedupe is not null do nothing;
            if found then v_created := v_created + 1; end if;
          exception when others then null; end;
        end loop;
      end if;
    end loop;
  end loop;

  return v_created;
end;
$$;

comment on function public.create_due_reminders() is
  'Job de recordatorios (texto fijo en español, idempotente por dedupe).';

-- Alta del job cada 15 min. Si pg_cron no está (o falla), aviso y a otra cosa:
-- la migración no puede depender del entorno.
do $cron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin job de recordatorios: %', sqlerrm;
    return;
  end;
  begin
    -- pg_cron instala sus funciones en el esquema `cron` (fijo del módulo).
    perform cron.unschedule('loki-reminders-15min');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule(
      'loki-reminders-15min',
      '*/15 * * * *',
      'select public.create_due_reminders()'
    );
  exception when others then
    raise notice 'no se pudo programar el job de recordatorios: %', sqlerrm;
  end;
end
$cron$;

-- pg_net es opcional (solo para el push opt-in). Si no está, el trigger lo
-- ignora por EXCEPTION; se intenta dejarla lista sin romper nada.
do $pgnet$
begin
  begin
    create extension if not exists pg_net with schema extensions;
  exception when others then
    raise notice 'pg_net no disponible, sin push desde base: %', sqlerrm;
  end;
end
$pgnet$;

-- -----------------------------------------------------------------------------
-- 7. Realtime: la bandeja y el toast viven de `notifications`.
-- -----------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array['notifications'] loop
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
-- 8. Índices
-- -----------------------------------------------------------------------------

create index if not exists events_ws_time_idx
  on public.events (workspace_id, starts_at);
create index if not exists tasks_project_idx
  on public.tasks (project_id, status, position);
create index if not exists tasks_ws_due_idx
  on public.tasks (workspace_id, due_at) where status <> 'done';
create index if not exists tasks_parent_idx
  on public.tasks (parent_task_id) where parent_task_id is not null;
create index if not exists ideas_ws_idx
  on public.ideas (workspace_id, created_at desc);
create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);
create index if not exists invites_ws_idx
  on public.invites (workspace_id, created_at desc);
create index if not exists invites_code_uidx on public.invites (code);

-- -----------------------------------------------------------------------------
-- 9. Privilegios (mismo criterio que T19: la puerta es la RLS)
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on
  public.projects,
  public.tasks,
  public.events,
  public.ideas,
  public.notifications,
  public.notification_prefs,
  public.invites
  to authenticated;

grant select on
  public.projects,
  public.tasks,
  public.events,
  public.ideas,
  public.notifications,
  public.notification_prefs,
  public.invites
  to anon;

grant select on public.project_progress to authenticated, anon;

revoke execute on function public.accept_invite(text) from anon;
revoke execute on function public.generate_invite_code() from anon;
revoke execute on function public.create_due_reminders() from public;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.generate_invite_code() to authenticated;
grant execute on function public.is_space_admin(uuid) to authenticated;
