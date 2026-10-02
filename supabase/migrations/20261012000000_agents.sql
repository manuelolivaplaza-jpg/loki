-- =============================================================================
-- Agentes personales: registro genérico, permisos, ejecuciones y contrato.
-- NUEVA migración: no toca las anteriores (etapa 2, prompt 12).
--
-- Idea: capa de "conectores de agentes" con UN contrato propio de Loki.
-- Loki manda una tarea al agente; el agente devuelve eventos de progreso y
-- un resultado final. Cada proveedor (generic_webhook, grokbot, hermes, a2a…)
-- tiene un adaptador en las Edge Functions que traduce ese contrato a lo que
-- el proveedor entiende. El prompt 13 conecta esto al chat y a cada proveedor.
--
-- 1. agent_connections: un agente de un dueño (user_id), con proveedor,
--    nombre visible y handle para mencionar, descripción, avatar o emoji,
--    config del proveedor (URL de disparo, etc.), secreto saliente CIFRADO
--    (secret_enc, AES-GCM con AGENT_TOKEN_KEY, mismo enfoque que
--    google-calendar: solo lo leen las Edge con service_role), hash del
--    token entrante (inbound_token_hash: el claro se muestra UNA vez y nunca
--    vuelve), estado y último uso.
--    Los secretos NUNCA son legibles por `authenticated` (REVOKE a nivel de
--    columna): el cliente usa siempre listas explícitas de columnas seguras,
--    nunca `select *` sobre esta tabla. Tampoco el dueño los vuelve a ver.
-- 2. agent_space_grants: en qué espacios está habilitado y con qué permisos
--    (quién puede invocarlo, contexto del chat, publicar, proponer acciones,
--    tope diario). Los admins del espacio pueden desactivar el grant
--    (gobernanza) vía RPC, pero no leer ni cambiar la conexión.
-- 3. agent_runs + agent_run_events: cada ejecución y su historial, en Realtime
--    para ver el progreso en vivo. Estados: queued, dispatched, running,
--    needs_input, done, error, cancelled, expired.
-- 4. Notificación tipo `agent` (+ interruptor en notification_prefs) para
--    avisar "@mi-bot terminó" o "@mi-bot necesita tu respuesta" (el envío lo
--    hace el prompt 13; aquí solo se abre el tipo).
-- 5. Despertar por eventos: el AFTER INSERT en agent_runs despierta a la Edge
--    `agent-dispatch` por pg_net (settings loki.agent_dispatch_url /
--    loki.agent_dispatch_key, mismo patrón que wake_ai_worker; sin ellos no
--    hace nada y nunca rompe el insert). Nada queda escuchando 24/7.
-- 6. Barrido SQL barato con pg_cron (sin LLM): expire_agent_runs() marca
--    `expired` lo pasado de su deadline_at.
--
-- Nombres de campos compatibles con estándares abiertos (revisados contra la
-- documentación vigente; ver docs/AGENTES.md para el mapa exacto):
--   · A2A (Agent2Agent, Linux Foundation): la tarea saliente equivale a un
--     Task (id = taskId, estado = TaskStatus.state, mensajes = Message con
--     parts, resultado = Artifact). Los estados de Loki son el subconjunto
--     que el chat necesita; el adaptador `a2a` del prompt 13 los traduce.
--   · MCP (Model Context Protocol): a futuro Loki expondrá sus acciones como
--     Tools (tools/list + tools/call) para que los agentes lean contexto o
--     propongan acciones; las `proposed_actions` del resultado ya usan ese
--     vocabulario (type + arguments).
--
-- Convenciones heredadas: snake_case, SECURITY DEFINER con search_path fijo,
-- políticas con nombre en español, DROP POLICY IF EXISTS + CREATE POLICY,
-- GRANTs explícitos, y pg_cron/pg_net en bloques DO con EXCEPTION.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Tipo `agent` (+ interruptor por tipo).
-- -----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add check (type in (
  'mention', 'reply', 'reaction', 'task_assigned', 'task_due',
  'event_reminder', 'invite', 'ai_alert', 'list', 'poll', 'memory', 'daily',
  'agent'
));

alter table public.notification_prefs
  add column if not exists agent boolean not null default true;

-- -----------------------------------------------------------------------------
-- 1. Conexiones de agentes (un dueño, un proveedor, un handle).
-- -----------------------------------------------------------------------------
create table if not exists public.agent_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  provider text not null
    check (provider in ('generic_webhook', 'grokbot', 'hermes', 'a2a')),
  name text not null check (char_length(name) between 1 and 60),
  -- Handle sin @, en minúsculas (el cliente lo normaliza; aquí se exige).
  -- Único dentro de cada espacio donde esté habilitado (ver
  -- validate_agent_handle): no se pone UNIQUE global a propósito.
  handle text not null
    check (handle ~ '^[a-z0-9][a-z0-9._-]{1,30}$'),
  description text not null default ''
    check (char_length(description) <= 280),
  avatar_emoji text not null default '🤖'
    check (char_length(avatar_emoji) <= 8),
  -- Config del proveedor (URL de disparo, versión del prompt de rutina…).
  -- La URL vive aquí en claro para que el dueño la vea y edite; el SECRETO
  -- (key del webhook) va en secret_enc y nunca vuelve al cliente.
  config jsonb not null default '{}'::jsonb,
  -- Secreto saliente cifrado (AES-GCM con AGENT_TOKEN_KEY). Solo Edge.
  secret_enc text,
  -- SHA-256 hex del token entrante. El claro se muestra UNA vez al generarlo
  -- (Edge agent-connections) y después solo vive este hash. Solo Edge.
  inbound_token_hash text,
  status text not null default 'active'
    check (status in ('active', 'paused', 'error')),
  last_error text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_connections is
  'Agentes personales conectados por cada dueño. Los secretos (secret_enc, inbound_token_hash) solo los leen las Edge con service_role; ni el dueño los vuelve a ver.';

comment on column public.agent_connections.handle is
  'Handle para mencionar (@handle), en minúsculas y sin @. Único dentro de cada espacio donde esté habilitado; no choca con miembros ni con @Loki (ver validate_agent_handle).';

create index if not exists agent_connections_owner_idx
  on public.agent_connections (owner_id, created_at desc);

drop trigger if exists agent_connections_touch_updated_at on public.agent_connections;
create trigger agent_connections_touch_updated_at
  before update on public.agent_connections
  for each row execute function public.touch_updated_at();

alter table public.agent_connections enable row level security;

-- El dueño ve y gestiona lo suyo. Los miembros ven lo básico de los
-- habilitados en sus espacios (política de abajo); los admins gobiernan
-- vía agent_space_grants, sin leer secretos ni reconfigurar.
drop policy if exists "agentes: el dueño ve los suyos"
  on public.agent_connections;
create policy "agentes: el dueño ve los suyos"
  on public.agent_connections for select to authenticated
  using (owner_id is not distinct from auth.uid());

drop policy if exists "agentes: el dueño crea los suyos"
  on public.agent_connections;
create policy "agentes: el dueño crea los suyos"
  on public.agent_connections for insert to authenticated
  with check (owner_id is not distinct from auth.uid());

drop policy if exists "agentes: el dueño edita los suyos"
  on public.agent_connections;
create policy "agentes: el dueño edita los suyos"
  on public.agent_connections for update to authenticated
  using (owner_id is not distinct from auth.uid())
  with check (owner_id is not distinct from auth.uid());

drop policy if exists "agentes: el dueño borra los suyos"
  on public.agent_connections;
create policy "agentes: el dueño borra los suyos"
  on public.agent_connections for delete to authenticated
  using (owner_id is not distinct from auth.uid());

-- Secretos: ni el dueño los vuelve a leer. Sin estos REVOKE a nivel de
-- columna, un `select` los expondría. El cliente usa siempre listas
-- explícitas de columnas seguras (ver src/lib/data/agents.ts), nunca `*`.
revoke all on public.agent_connections from anon, authenticated;
grant select (
  id, owner_id, provider, name, handle, description, avatar_emoji, config,
  status, last_error, last_used_at, created_at, updated_at
) on public.agent_connections to authenticated;
grant insert (
  owner_id, provider, name, handle, description, avatar_emoji, config, status
) on public.agent_connections to authenticated;
grant update (
  provider, name, handle, description, avatar_emoji, config, status
) on public.agent_connections to authenticated;
grant delete on public.agent_connections to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Habilitación por espacio con permisos (grants).
-- -----------------------------------------------------------------------------
create table if not exists public.agent_space_grants (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.agent_connections (id) on delete cascade,
  workspace_id uuid not null
    references public.workspaces (id) on delete cascade,
  -- Interruptor del dueño + gobernanza del admin (ver
  -- set_agent_grant_admin_disabled). Basta uno apagado para no invocar.
  enabled boolean not null default true,
  admin_disabled boolean not null default false,
  -- Quién puede invocar: solo el dueño, miembros del espacio o una lista.
  allowed_callers text not null default 'owner_only'
    check (allowed_callers in ('owner_only', 'space_members', 'listed')),
  allowed_user_ids uuid[] not null default '{}',
  -- Contexto del chat que el agente puede recibir (ya recortado por la Edge).
  allow_context boolean not null default true,
  context_messages integer not null default 10
    check (context_messages between 0 and 50),
  -- DMs: nunca entran al contexto salvo invocación dentro de ese DM y permiso.
  allow_dm_context boolean not null default false,
  -- Si publica en el chat (visible para todos) o el resultado es privado.
  allow_publish boolean not null default true,
  -- Si puede proponer acciones (crear tareas o eventos, vía tarjeta).
  allow_propose_actions boolean not null default true,
  -- Tope diario de ejecuciones de esta conexión en este espacio.
  daily_limit integer not null default 20
    check (daily_limit between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_space_grants_once
    unique (connection_id, workspace_id)
);

comment on table public.agent_space_grants is
  'En qué espacios está habilitado cada agente y con qué permisos. Los admins del espacio pueden desactivar (admin_disabled) sin ver la conexión.';

create index if not exists agent_space_grants_conn_idx
  on public.agent_space_grants (connection_id);
create index if not exists agent_space_grants_ws_idx
  on public.agent_space_grants (workspace_id);

drop trigger if exists agent_space_grants_touch_updated_at on public.agent_space_grants;
create trigger agent_space_grants_touch_updated_at
  before update on public.agent_space_grants
  for each row execute function public.touch_updated_at();

alter table public.agent_space_grants enable row level security;

-- Habilitados en mis espacios: los miembros ven lo básico (nombre, handle,
-- dueño) para la vista "Agentes en este espacio". Los secretos siguen
-- ocultos por el REVOKE a nivel de columna, que manda sobre esta política.
drop policy if exists "agentes: habilitados en mis espacios"
  on public.agent_connections;
create policy "agentes: habilitados en mis espacios"
  on public.agent_connections for select to authenticated
  using (
    exists (
      select 1
      from public.agent_space_grants g
      where g.connection_id = agent_connections.id
        and g.enabled
        and not g.admin_disabled
        and public.is_member(g.workspace_id)
    )
  );

-- El dueño gestiona sus grants; los miembros del espacio los leen (vista
-- "Agentes en este espacio": de quién es cada uno y quién puede usarlo).
drop policy if exists "concesiones: el dueño gestiona las suyas"
  on public.agent_space_grants;
create policy "concesiones: el dueño gestiona las suyas"
  on public.agent_space_grants for all to authenticated
  using (
    exists (
      select 1 from public.agent_connections c
      where c.id = agent_space_grants.connection_id
        and c.owner_id is not distinct from auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.agent_connections c
      where c.id = agent_space_grants.connection_id
        and c.owner_id is not distinct from auth.uid()
    )
  );

drop policy if exists "concesiones: los miembros ven las de su espacio"
  on public.agent_space_grants;
create policy "concesiones: los miembros ven las de su espacio"
  on public.agent_space_grants for select to authenticated
  using (public.is_member(workspace_id));

grant select, insert, update, delete on public.agent_space_grants to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Ejecuciones y su historial de eventos.
-- -----------------------------------------------------------------------------
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.agent_connections (id) on delete cascade,
  workspace_id uuid not null
    references public.workspaces (id) on delete cascade,
  chat_id text not null check (char_length(chat_id) between 1 and 64),
  requested_by uuid references auth.users (id) on delete set null,
  -- task: mención en el chat (prompt 13). ping: "Probar conexión".
  kind text not null default 'task' check (kind in ('task', 'ping')),
  instruction text not null default ''
    check (char_length(instruction) <= 4000),
  status text not null default 'queued'
    check (status in (
      'queued', 'dispatched', 'running', 'needs_input',
      'done', 'error', 'cancelled', 'expired'
    )),
  -- SHA-256 hex del token de la ejecución (el claro viaja solo al agente y
  -- vive hasta token_expires_at; se invalida al terminar). Solo Edge.
  run_token_hash text,
  token_expires_at timestamptz,
  deadline_at timestamptz,
  -- Contexto ya recortado por permisos que se entregó al agente.
  context jsonb not null default '[]'::jsonb,
  result jsonb,
  error text,
  cancel_requested_at timestamptz,
  -- Dedupe: una mención (o un reintento del botón Probar) no despierta dos
  -- veces. NULL = sin dedupe (los ping llevan clave propia).
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

comment on table public.agent_runs is
  'Cada invocación a un agente (@handle en el chat o Probar conexión), con quién la pidió para auditoría. Los estados los mueve solo la service role (Edges); el cliente solo pide cancelar vía RPC.';

create index if not exists agent_runs_conn_idx
  on public.agent_runs (connection_id, created_at desc);
create index if not exists agent_runs_ws_status_idx
  on public.agent_runs (workspace_id, status, created_at desc);
create index if not exists agent_runs_requested_idx
  on public.agent_runs (requested_by, created_at desc);

drop trigger if exists agent_runs_touch_updated_at on public.agent_runs;
create trigger agent_runs_touch_updated_at
  before update on public.agent_runs
  for each row execute function public.touch_updated_at();

alter table public.agent_runs enable row level security;

-- Helpers RLS (van antes que las políticas que los usan; el resto sigue en la sección 4).

-- Dueño de una conexión (para RLS sin recursión).
create or replace function public.agent_connection_owner(p_connection_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.owner_id
  from public.agent_connections c
  where c.id = p_connection_id;
$$;

comment on function public.agent_connection_owner(uuid) is
  'Dueño de una conexión de agente (interno de RLS).';

-- ¿Puedo invocar este agente en este espacio? El dueño siempre; los demás
-- según el grant habilitado (y sin bloqueo de admin).
create or replace function public.agent_can_invoke(
  p_connection_id uuid, p_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.agent_connections c
    where c.id = p_connection_id
      and c.status = 'active'
      and c.owner_id is not distinct from auth.uid()
  ) or exists (
    select 1
    from public.agent_connections c
    join public.agent_space_grants g
      on g.connection_id = c.id
     and g.workspace_id = p_workspace_id
    where c.id = p_connection_id
      and c.status = 'active'
      and g.enabled
      and not g.admin_disabled
      and public.is_member(p_workspace_id)
      and (
        g.allowed_callers = 'space_members'
        or (g.allowed_callers = 'listed' and auth.uid() = any (g.allowed_user_ids))
        or (
          g.allowed_callers = 'owner_only'
          and c.owner_id is not distinct from auth.uid()
        )
      )
  );
$$;

comment on function public.agent_can_invoke(uuid, uuid) is
  '¿Puede el usuario actual invocar este agente en este espacio? Dueño siempre; el resto según el grant (habilitado, sin bloqueo de admin y llamador permitido).';

-- ¿Puedo leer esta ejecución? Quien la pidió, el dueño del agente, o un
-- miembro del chat cuando el resultado es público (grant con publish y acceso
-- al chat; en DMs ajenos can_access_chat ya deja fuera).
create or replace function public.agent_can_read_run(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.agent_runs r
    join public.agent_connections c on c.id = r.connection_id
    left join public.agent_space_grants g
      on g.connection_id = r.connection_id
     and g.workspace_id = r.workspace_id
    where r.id = p_run_id
      and (
        r.requested_by is not distinct from auth.uid()
        or c.owner_id is not distinct from auth.uid()
        or (
          coalesce(g.allow_publish, true)
          and public.can_access_chat(r.workspace_id, r.chat_id)
        )
      )
  );
$$;

comment on function public.agent_can_read_run(uuid) is
  'Visibilidad de una ejecución: quien la pidió, el dueño del agente, o miembros del chat si el grant permite publicar.';


-- Lee: quien la pidió, el dueño del agente, o un miembro del chat cuando el
-- grant permite publicar (el resultado es público). Los resultados privados
-- (allow_publish = false) solo los ven quien invocó y el dueño.
drop policy if exists "ejecuciones: leer las que me tocan"
  on public.agent_runs;
create policy "ejecuciones: leer las que me tocan"
  on public.agent_runs for select to authenticated
  using (public.agent_can_read_run(id));

-- Pide: miembro con permiso de invocación, siempre a nombre propio.
-- La Edge agent-dispatch revalida grant, cuota y estado antes de despertar.
drop policy if exists "ejecuciones: pedir en mi espacio"
  on public.agent_runs;
create policy "ejecuciones: pedir en mi espacio"
  on public.agent_runs for insert to authenticated
  with check (
    requested_by is not distinct from auth.uid()
    and public.agent_can_invoke(connection_id, workspace_id)
  );

-- Ni update ni delete de cliente: el ciclo lo mueven las Edges y la
-- cancelación pasa por request_agent_run_cancel().
revoke all on public.agent_runs from anon, authenticated;
grant select (
  id, connection_id, workspace_id, chat_id, requested_by, kind, instruction,
  status, token_expires_at, deadline_at, context, result, error,
  cancel_requested_at, idempotency_key, created_at, updated_at, finished_at
) on public.agent_runs to authenticated;
grant insert (
  connection_id, workspace_id, chat_id, requested_by, kind, instruction,
  idempotency_key
) on public.agent_runs to authenticated;

create table if not exists public.agent_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null
    references public.agent_runs (id) on delete cascade,
  seq integer not null check (seq >= 0),
  type text not null
    check (type in (
      'ack', 'progress', 'needs_input', 'result', 'error',
      'cancelled', 'expired', 'dispatch_failed'
    )),
  text text not null default ''
    check (char_length(text) <= 2000),
  percent integer check (percent is null or (percent between 0 and 100)),
  -- Id del evento que pone el agente: un repetido se responde duplicado sin
  -- duplicar (NULL = evento del servidor, sin dedupe).
  client_event_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_run_events_seq_once unique (run_id, seq),
  constraint agent_run_events_client_once unique (run_id, client_event_id)
);

comment on table public.agent_run_events is
  'Historial de cada ejecución (progreso en vivo por Realtime). Lo escribe solo la service role desde agent-callback / agent-dispatch.';

create index if not exists agent_run_events_run_idx
  on public.agent_run_events (run_id, seq asc);

alter table public.agent_run_events enable row level security;

-- Se ven con la misma regla que su ejecución.
drop policy if exists "eventos: leer con su ejecución"
  on public.agent_run_events;
create policy "eventos: leer con su ejecución"
  on public.agent_run_events for select to authenticated
  using (public.agent_can_read_run(run_id));

-- Sin escrituras de cliente: solo la service role (callback del agente).
revoke all on public.agent_run_events from anon, authenticated;
grant select on public.agent_run_events to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Helpers SECURITY DEFINER (search_path fijo).
-- -----------------------------------------------------------------------------

-- Dueño de una conexión (para RLS sin recursión).
create or replace function public.agent_connection_owner(p_connection_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.owner_id
  from public.agent_connections c
  where c.id = p_connection_id;
$$;

comment on function public.agent_connection_owner(uuid) is
  'Dueño de una conexión de agente (interno de RLS).';

-- ¿Puedo invocar este agente en este espacio? El dueño siempre; los demás
-- según el grant habilitado (y sin bloqueo de admin).
create or replace function public.agent_can_invoke(
  p_connection_id uuid, p_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.agent_connections c
    where c.id = p_connection_id
      and c.status = 'active'
      and c.owner_id is not distinct from auth.uid()
  ) or exists (
    select 1
    from public.agent_connections c
    join public.agent_space_grants g
      on g.connection_id = c.id
     and g.workspace_id = p_workspace_id
    where c.id = p_connection_id
      and c.status = 'active'
      and g.enabled
      and not g.admin_disabled
      and public.is_member(p_workspace_id)
      and (
        g.allowed_callers = 'space_members'
        or (g.allowed_callers = 'listed' and auth.uid() = any (g.allowed_user_ids))
        or (
          g.allowed_callers = 'owner_only'
          and c.owner_id is not distinct from auth.uid()
        )
      )
  );
$$;

comment on function public.agent_can_invoke(uuid, uuid) is
  '¿Puede el usuario actual invocar este agente en este espacio? Dueño siempre; el resto según el grant (habilitado, sin bloqueo de admin y llamador permitido).';

-- ¿Puedo leer esta ejecución? Quien la pidió, el dueño del agente, o un
-- miembro del chat cuando el resultado es público (grant con publish y acceso
-- al chat; en DMs ajenos can_access_chat ya deja fuera).
create or replace function public.agent_can_read_run(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.agent_runs r
    join public.agent_connections c on c.id = r.connection_id
    left join public.agent_space_grants g
      on g.connection_id = r.connection_id
     and g.workspace_id = r.workspace_id
    where r.id = p_run_id
      and (
        r.requested_by is not distinct from auth.uid()
        or c.owner_id is not distinct from auth.uid()
        or (
          coalesce(g.allow_publish, true)
          and public.can_access_chat(r.workspace_id, r.chat_id)
        )
      )
  );
$$;

comment on function public.agent_can_read_run(uuid) is
  'Visibilidad de una ejecución: quien la pidió, el dueño del agente, o miembros del chat si el grant permite publicar.';

-- Valida un handle para un espacio: formato, no reservado (@Loki y cía.),
-- sin chocar con miembros (nombre visible) ni con otros agentes habilitados
-- en ese espacio. El dueño lo llama antes de guardar (la Edge también).
create or replace function public.validate_agent_handle(
  p_workspace_id uuid, p_handle text, p_ignore_connection_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_handle text := lower(trim(both '@' from trim(coalesce(p_handle, ''))));
begin
  if v_handle !~ '^[a-z0-9][a-z0-9._-]{1,30}$' then
    return false;
  end if;
  -- Reservados: Loki y variantes.
  if v_handle in ('loki', 'loki-ia', 'lokia', 'admin', 'sistema', 'system') then
    return false;
  end if;
  -- Miembros del espacio (nombre visible normalizado, con o sin espacios).
  if exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and (
        lower(regexp_replace(m.display_name, '\s+', '', 'g')) = replace(v_handle, '_', '')
        or lower(m.display_name) = v_handle
      )
  ) then
    return false;
  end if;
  -- Otros agentes habilitados en el mismo espacio.
  if exists (
    select 1
    from public.agent_connections c
    join public.agent_space_grants g
      on g.connection_id = c.id
     and g.workspace_id = p_workspace_id
    where lower(c.handle) = v_handle
      and g.enabled
      and not g.admin_disabled
      and (p_ignore_connection_id is null or c.id <> p_ignore_connection_id)
  ) then
    return false;
  end if;
  return true;
end;
$$;

comment on function public.validate_agent_handle(uuid, text, uuid) is
  '¿Handle disponible en este espacio? Revisa formato, reservados (@Loki), miembros y otros agentes habilitados.';

-- Cancelar: quien la pidió o el dueño del agente. Marca el pedido; la Edge
-- (o el agente en su próximo callback, que recibe 409) cierra el estado.
create or replace function public.request_agent_run_cancel(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.agent_runs%rowtype;
  v_owner uuid;
begin
  select * into v_row
  from public.agent_runs
  where id = p_run_id;
  if v_row.id is null then return false; end if;
  if v_row.status in ('done', 'error', 'cancelled', 'expired') then
    return false;
  end if;
  select c.owner_id into v_owner
  from public.agent_connections c
  where c.id = v_row.connection_id;
  if v_row.requested_by is distinct from auth.uid()
     and v_owner is distinct from auth.uid() then
    raise exception 'Solo quien pidió la ejecución o el dueño del agente puede cancelarla'
      using errcode = 'insufficient_privilege';
  end if;
  update public.agent_runs
     set cancel_requested_at = now(),
         status = 'cancelled',
         finished_at = coalesce(finished_at, now())
   where id = p_run_id
     and status not in ('done', 'error', 'cancelled', 'expired');
  return found;
end;
$$;

comment on function public.request_agent_run_cancel(uuid) is
  'Pide cancelar una ejecución viva (quien la pidió o el dueño del agente).';

-- Gobernanza: un admin del espacio desactiva (o reactiva) el grant de un
-- agente en SU espacio, sin ver ni tocar la conexión.
create or replace function public.set_agent_grant_admin_disabled(
  p_grant_id uuid, p_disabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_grant public.agent_space_grants%rowtype;
begin
  select * into v_grant
  from public.agent_space_grants
  where id = p_grant_id;
  if v_grant.id is null then return false; end if;
  if not public.is_space_admin(v_grant.workspace_id) then
    raise exception 'Solo un admin del espacio puede desactivar agentes'
      using errcode = 'insufficient_privilege';
  end if;
  update public.agent_space_grants
     set admin_disabled = p_disabled
   where id = p_grant_id;
  return true;
end;
$$;

comment on function public.set_agent_grant_admin_disabled(uuid, boolean) is
  'Gobernanza del espacio: un admin desactiva o reactiva un agente en su espacio (sin ver secretos ni reconfigurarlo).';

-- Barrido barato (pg_cron, sin LLM): marca `expired` lo que pasó su
-- deadline y deja un evento visible en el chat.
create or replace function public.expire_agent_runs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_run record;
  v_seq integer;
begin
  for v_run in
    select id from public.agent_runs
     where status in ('queued', 'dispatched', 'running', 'needs_input')
       and deadline_at is not null
       and deadline_at <= now()
    order by deadline_at asc
    limit 50
  loop
    update public.agent_runs
       set status = 'expired',
           error = 'Sin respuesta a tiempo.',
           finished_at = coalesce(finished_at, now())
     where id = v_run.id
       and status in ('queued', 'dispatched', 'running', 'needs_input');
    if found then
      select coalesce(max(seq), -1) + 1 into v_seq
      from public.agent_run_events
      where run_id = v_run.id;
      begin
        insert into public.agent_run_events (run_id, seq, type, text)
        values (v_run.id, v_seq, 'expired', 'Sin respuesta a tiempo.');
      exception when others then
        null;
      end;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function public.expire_agent_runs() is
  'Marca expired las ejecuciones pasadas de su deadline (pg_cron cada 5 min, SQL barato, sin LLM).';

-- Despertar a agent-dispatch tras cada ejecución encolada (opt-in por
-- settings, mismo patrón que wake_ai_worker; sin settings no hace nada y
-- nunca rompe el insert).
create or replace function public.notify_agent_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_key text;
begin
  if new.status <> 'queued' then
    return null;
  end if;
  begin
    v_url := current_setting('loki.agent_dispatch_url', true);
    v_key := current_setting('loki.agent_dispatch_key', true);
  exception when others then
    return null;
  end;
  if v_url is null or v_url = '' or v_key is null or v_key = '' then
    return null;
  end if;
  begin
    perform extensions.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object('run_id', new.id)
    );
  exception when others then
    null;
  end;
  return null;
end;
$$;

drop trigger if exists notify_agent_dispatch on public.agent_runs;
create trigger notify_agent_dispatch
  after insert on public.agent_runs
  for each row execute function public.notify_agent_dispatch();

-- -----------------------------------------------------------------------------
-- 5. Realtime (progreso en vivo sin consultar en bucle) + pg_cron.
-- -----------------------------------------------------------------------------
do $agentpub$
begin
  begin
    alter publication supabase_realtime add table public.agent_connections;
  exception when others then
    raise notice 'no se pudo publicar agent_connections en realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.agent_space_grants;
  exception when others then
    raise notice 'no se pudo publicar agent_space_grants en realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.agent_runs;
  exception when others then
    raise notice 'no se pudo publicar agent_runs en realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.agent_run_events;
  exception when others then
    raise notice 'no se pudo publicar agent_run_events en realtime: %', sqlerrm;
  end;
end
$agentpub$;

do $agentcron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin expiración de agentes: %', sqlerrm;
    return;
  end;
  begin
    perform cron.unschedule('loki-agent-expire');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule(
      'loki-agent-expire',
      '*/5 * * * *',
      'select public.expire_agent_runs()'
    );
  exception when others then
    raise notice 'no se pudo programar la expiración de agentes: %', sqlerrm;
  end;
end
$agentcron$;

grant execute on function public.agent_connection_owner(uuid) to authenticated;
grant execute on function public.agent_can_invoke(uuid, uuid) to authenticated;
grant execute on function public.agent_can_read_run(uuid) to authenticated;
grant execute on function public.validate_agent_handle(uuid, text, uuid) to authenticated;
grant execute on function public.request_agent_run_cancel(uuid) to authenticated;
grant execute on function public.set_agent_grant_admin_disabled(uuid, boolean) to authenticated;
-- expire_agent_runs es interna (pg_cron): nadie la llama directo.
revoke execute on function public.expire_agent_runs() from public;
revoke execute on function public.expire_agent_runs() from anon;
revoke execute on function public.expire_agent_runs() from authenticated;
-- notify_agent_dispatch es interna (trigger): nadie la llama directo.
revoke execute on function public.notify_agent_dispatch() from public;
revoke execute on function public.notify_agent_dispatch() from anon;
revoke execute on function public.notify_agent_dispatch() from authenticated;
