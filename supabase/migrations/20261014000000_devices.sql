-- =============================================================================
-- Compañero de escritorio (etapa 3): Mis dispositivos, emparejamiento fuerte,
-- comandos del catálogo cerrado y auditoría inmutable.
-- NUEVA migración: no toca las anteriores.
--
-- Idea: el PC nunca abre puertos ni usa la contraseña del usuario. El dueño
-- genera un código corto de un solo uso (create_device_pair_code); la Edge
-- `device-pair` lo canjea y crea una identidad Auth propia para el dispositivo
-- (usuario `device_<id>@devices.loki.internal` cuya clave ES el secreto largo;
-- en user_devices solo vive su hash SHA-256). El dispositivo entra con
-- signIn normal y obtiene access_tokens de corta duración. Todo lo que ve por
-- Realtime pasa por RLS (my_device_id()): solo sus propios comandos. Revocar
-- pone revoked_at y la RLS bloquea al instante (el JWT expira en ≤1h).
--
-- Comandos (device_commands): catálogo cerrado, parámetros validados en
-- request_device_command, riesgo por acción (info/normal/sensible). Lo
-- sensible queda en pending_confirmation y avisa al teléfono con una
-- notificación tipo `device` SIN datos del PC; confirm_device_command lo
-- libera (vence en 5 min). El PC reclama con device_claim_command (que vuelve
-- a comprobar riesgo + confirmación: doble control) y reporta con
-- device_report_result. Todo por eventos: nada consulta en bucle.
--
-- Convenciones heredadas: snake_case, SECURITY DEFINER con search_path fijo,
-- políticas con nombre en español, DROP POLICY IF EXISTS + CREATE POLICY,
-- GRANTs explícitos, y pg_cron/pg_net en bloques DO con EXCEPTION.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Tipo `device` (+ interruptor por tipo).
-- -----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add check (type in (
  'mention', 'reply', 'reaction', 'task_assigned', 'task_due',
  'event_reminder', 'invite', 'ai_alert', 'list', 'poll', 'memory', 'daily',
  'agent', 'device'
));

alter table public.notification_prefs
  add column if not exists device boolean not null default true;

-- -----------------------------------------------------------------------------
-- 1. Dispositivos del usuario.
-- -----------------------------------------------------------------------------
create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  platform text not null default 'windows'
    check (platform in ('windows', 'linux', 'macos', 'other')),
  app_version text not null default ''
    check (char_length(app_version) <= 32),
  -- SHA-256 hex del secreto largo (el claro solo lo conoce el PC; la clave de
  -- Auth del usuario-dispositivo vive en Auth con bcrypt).
  credential_hash text not null
    check (credential_hash ~ '^[0-9a-f]{64}$'),
  -- Catálogo habilitado en este PC (subconjunto del catálogo cerrado; ver
  -- docs/DISPOSITIVOS.md). `arbitrary_exec` exige además allow_arbitrary.
  allowed_actions text[] not null default
    '{pc_status,open_app,open_url,find_files,send_file,screenshot,lock_screen,volume_set,media_control,run_script}',
  -- Carpetas que find_files/send_file pueden tocar (nombres relativos a la
  -- carpeta base del compañero, p. ej. 'Documentos'). Vacío = ninguna.
  readable_dirs text[] not null default '{}',
  can_send_files boolean not null default true,
  -- Comandos arbitrarios de terminal: apagado salvo habilitación explícita, y
  -- siempre con confirmación en el teléfono.
  allow_arbitrary boolean not null default false,
  -- Alcance: null = chats del dueño (privado Loki IA + DMs; en grupos solo el
  -- dueño ordena). Con lista, solo esos chats/espacios.
  allowed_chat_ids text[],
  allowed_workspace_ids uuid[],
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_devices is
  'PCs vinculados de cada usuario. El secreto solo vive como hash; el PC entra con su propio usuario Auth y tokens cortos.';

create index if not exists user_devices_owner_idx
  on public.user_devices (owner_id, created_at desc);

drop trigger if exists user_devices_touch_updated_at on public.user_devices;
create trigger user_devices_touch_updated_at
  before update on public.user_devices
  for each row execute function public.touch_updated_at();

alter table public.user_devices enable row level security;

drop policy if exists "dispositivos: el dueño ve los suyos"
  on public.user_devices;
create policy "dispositivos: el dueño ve los suyos"
  on public.user_devices for select to authenticated
  using (owner_id is not distinct from auth.uid());

-- El hash del secreto y el alcance no vuelven al cliente en lectura, y el
-- ciclo de vida (crear/revocar) pasa por la Edge device-pair y revoke_device.
revoke all on public.user_devices from anon, authenticated;
grant select (
  id, owner_id, name, platform, app_version,
  allowed_actions, readable_dirs, can_send_files, allow_arbitrary,
  revoked_at, last_seen_at, created_at, updated_at
) on public.user_devices to authenticated;
grant update (
  name, platform, app_version,
  allowed_actions, readable_dirs, can_send_files, allow_arbitrary,
  allowed_chat_ids, allowed_workspace_ids
) on public.user_devices to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Códigos de vinculación (un solo uso, vencen en 5 minutos).
-- -----------------------------------------------------------------------------
create table if not exists public.device_pair_codes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- 6 caracteres sin ambigüedad (sin 0/O/1/I).
  code text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  device_name text not null default ''
    check (char_length(device_name) <= 60),
  expires_at timestamptz not null default now() + interval '5 minutes',
  used_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.device_pair_codes is
  'Códigos cortos de vinculación (un solo uso, 5 min). Los crea create_device_pair_code y los canjea la Edge device-pair.';

create index if not exists device_pair_codes_owner_idx
  on public.device_pair_codes (owner_id, created_at desc);

alter table public.device_pair_codes enable row level security;

drop policy if exists "vinculacion: el dueño ve sus codigos"
  on public.device_pair_codes;
create policy "vinculacion: el dueño ve sus codigos"
  on public.device_pair_codes for select to authenticated
  using (owner_id is not distinct from auth.uid());

drop policy if exists "vinculacion: el dueño borra sus codigos"
  on public.device_pair_codes;
create policy "vinculacion: el dueño borra sus codigos"
  on public.device_pair_codes for delete to authenticated
  using (owner_id is not distinct from auth.uid());

-- Sin escrituras directas: crear pasa por create_device_pair_code y canjear
-- por la service role (Edge device-pair).
revoke all on public.device_pair_codes from anon, authenticated;
grant select, delete on public.device_pair_codes to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Identidad Auth de cada dispositivo (solo service role).
-- -----------------------------------------------------------------------------
create table if not exists public.device_auth_users (
  device_id uuid primary key
    references public.user_devices (id) on delete cascade,
  auth_user_id uuid not null unique
    references auth.users (id) on delete cascade
);

comment on table public.device_auth_users is
  'Qué usuario Auth es cada dispositivo (para my_device_id). Solo la service role; ningún cliente la lee ni escribe.';

alter table public.device_auth_users enable row level security;
-- Sin políticas: ningún cliente lee ni escribe; solo la service role.

-- Helper RLS (va antes que las políticas que lo usan).

-- ¿Qué dispositivo es este JWT? Null = persona (o sin sesión).
create or replace function public.my_device_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.device_id
  from public.device_auth_users m
  where m.auth_user_id is not distinct from auth.uid()
  limit 1;
$$;

comment on function public.my_device_id() is
  'Dispositivo dueño de este JWT (null si es una persona). Base de la RLS de PCs.';

drop policy if exists "dispositivos: el dispositivo ve su ficha"
  on public.user_devices;
create policy "dispositivos: el dispositivo ve su ficha"
  on public.user_devices for select to authenticated
  using (id is not distinct from public.my_device_id());


-- -----------------------------------------------------------------------------
-- 4. Comandos al PC (catálogo cerrado).
-- -----------------------------------------------------------------------------
create table if not exists public.device_commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null
    references public.user_devices (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Null = chat privado Loki IA (modo personal). Si no, chat del espacio.
  workspace_id uuid references public.workspaces (id) on delete cascade,
  chat_id text not null default ''
    check (char_length(chat_id) <= 64),
  message_id uuid references public.messages (id) on delete set null,
  requested_by uuid references auth.users (id) on delete set null,
  action text not null check (action in (
    'pc_status', 'open_app', 'open_url', 'find_files', 'send_file',
    'screenshot', 'lock_screen', 'volume_set', 'media_control',
    'run_script', 'arbitrary_exec'
  )),
  params jsonb not null default '{}'::jsonb,
  risk text not null check (risk in ('info', 'normal', 'sensible')),
  status text not null default 'queued' check (status in (
    'pending_confirmation', 'queued', 'delivered', 'running',
    'done', 'error', 'rejected', 'expired'
  )),
  -- Resultado corto en la fila (máx 8000); lo grande va a Storage.
  result_text text not null default ''
    check (char_length(result_text) <= 8000),
  -- Ruta en el bucket `device-results` (`{owner}/{device}/…`).
  result_path text check (result_path is null or char_length(result_path) <= 500),
  result_mime text not null default ''
    check (char_length(result_mime) <= 127),
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  delivered_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- Los no entregados expiran (barrido barato, sin LLM).
  expires_at timestamptz not null default now() + interval '10 minutes',
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.device_commands is
  'Órdenes al PC del catálogo cerrado. El dueño pide/confirma por RPC; el dispositivo solo reclama y reporta por RPC (doble control de riesgo).';

create index if not exists device_commands_device_idx
  on public.device_commands (device_id, created_at desc);
create index if not exists device_commands_owner_idx
  on public.device_commands (owner_id, created_at desc);
create index if not exists device_commands_status_idx
  on public.device_commands (device_id, status, created_at desc)
  where status in ('pending_confirmation', 'queued', 'delivered', 'running');

drop trigger if exists device_commands_touch_updated_at on public.device_commands;
create trigger device_commands_touch_updated_at
  before update on public.device_commands
  for each row execute function public.touch_updated_at();

alter table public.device_commands enable row level security;

drop policy if exists "comandos: el dueño ve los suyos"
  on public.device_commands;
create policy "comandos: el dueño ve los suyos"
  on public.device_commands for select to authenticated
  using (owner_id is not distinct from auth.uid());

drop policy if exists "comandos: el dispositivo ve los suyos"
  on public.device_commands;
create policy "comandos: el dispositivo ve los suyos"
  on public.device_commands for select to authenticated
  using (device_id is not distinct from public.my_device_id());

-- Sin escrituras directas: todo el ciclo pasa por RPC (que validan catálogo,
-- riesgo, confirmación y ritmo).
revoke all on public.device_commands from anon, authenticated;
grant select on public.device_commands to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Auditoría inmutable (solo inserción + lectura del dueño).
-- -----------------------------------------------------------------------------
create table if not exists public.device_audit_log (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null
    references public.user_devices (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  command_id uuid references public.device_commands (id) on delete set null,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null
    check (action in (
      'paired', 'revoked', 'requested', 'confirmed', 'rejected',
      'claimed', 'delivered', 'done', 'error', 'expired', 'settings'
    )),
  detail text not null default ''
    check (char_length(detail) <= 1000),
  created_at timestamptz not null default now()
);

comment on table public.device_audit_log is
  'Quién ordenó qué a su PC, cuándo, desde dónde y con qué resultado. Solo inserción: sin update ni delete.';

create index if not exists device_audit_log_device_idx
  on public.device_audit_log (device_id, created_at desc);

alter table public.device_audit_log enable row level security;

drop policy if exists "auditoria: el dueño ve la suya"
  on public.device_audit_log;
create policy "auditoria: el dueño ve la suya"
  on public.device_audit_log for select to authenticated
  using (owner_id is not distinct from auth.uid());

-- Sin insert/update/delete de cliente: escriben las RPC y la Edge.
revoke all on public.device_audit_log from anon, authenticated;
grant select on public.device_audit_log to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Helpers SECURITY DEFINER (search_path fijo).
-- -----------------------------------------------------------------------------


-- Dueño de un dispositivo (para RLS sin recursión).
create or replace function public.device_owner_id(p_device_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.owner_id
  from public.user_devices d
  where d.id = p_device_id;
$$;

comment on function public.device_owner_id(uuid) is
  'Dueño de un dispositivo (interno de RLS).';

-- ¿Activo? Existe y no revocado. Un revocado deja de ver todo al instante.
create or replace function public.device_is_active(p_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_devices d
    where d.id = p_device_id
      and d.revoked_at is null
  );
$$;

comment on function public.device_is_active(uuid) is
  '¿El dispositivo existe y no está revocado? Revocar bloquea al instante.';

-- ¿Puedo ordenar a este PC desde este chat? Solo el dueño, solo su PC activo,
-- solo desde chats permitidos (por defecto: privado Loki IA + DMs del dueño;
-- en grupos, nadie más que el dueño, que ya se exige aquí).
create or replace function public.can_order_device(
  p_device_id uuid, p_workspace_id uuid, p_chat_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_device public.user_devices%rowtype;
begin
  select * into v_device
  from public.user_devices d
  where d.id = p_device_id;
  if v_device.id is null then return false; end if;
  if v_device.revoked_at is not null then return false; end if;
  if v_device.owner_id is distinct from auth.uid() then return false; end if;
  -- Los dispositivos nunca ordenan a otros PCs.
  if public.my_device_id() is not null then return false; end if;
  -- Alcance configurado por dispositivo.
  if v_device.allowed_chat_ids is not null
     and not (coalesce(p_chat_id, '') = any (v_device.allowed_chat_ids)) then
    return false;
  end if;
  if v_device.allowed_workspace_ids is not null and p_workspace_id is not null
     and not (p_workspace_id = any (v_device.allowed_workspace_ids)) then
    return false;
  end if;
  -- Modo personal (privado Loki IA): siempre permitido al dueño.
  if p_workspace_id is null then return true; end if;
  -- En el espacio: solo desde chats a los que accedo.
  return public.can_access_chat(p_workspace_id, coalesce(p_chat_id, ''));
end;
$$;

comment on function public.can_order_device(uuid, uuid, text) is
  '¿Puede el usuario actual ordenar a este PC desde este chat? Solo el dueño, PC activo y chat permitido.';

-- Ritmo: máx 10 comandos por minuto por dispositivo (anti-bucle del PC y de Loki).
create or replace function public.device_command_rate_ok(p_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*) < 10
  from public.device_commands c
  where c.device_id = p_device_id
    and c.created_at > now() - interval '1 minute';
$$;

comment on function public.device_command_rate_ok(uuid) is
  'Ritmo: menos de 10 comandos por minuto por dispositivo.';

-- Riesgo del catálogo (una sola fuente en la base; la UI y la Edge lo espejan).
create or replace function public.device_action_risk(p_action text)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select case p_action
    when 'pc_status' then 'info'
    when 'send_file' then 'sensible'
    when 'run_script' then 'sensible'
    when 'arbitrary_exec' then 'sensible'
    else 'normal'
  end;
$$;

comment on function public.device_action_risk(text) is
  'Nivel de riesgo de cada acción del catálogo (info/normal/sensible).';

-- -----------------------------------------------------------------------------
-- 7. RPC del dueño.
-- -----------------------------------------------------------------------------

-- Código corto de vinculación (un solo uso, 5 min). Invalida los anteriores.
create or replace function public.create_device_pair_code(p_name text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_i integer;
  v_j integer;
begin
  if public.my_device_id() is not null then
    raise exception 'Los dispositivos no pueden vincular otros PCs'
      using errcode = 'insufficient_privilege';
  end if;
  if auth.uid() is null then
    raise exception 'Hay que iniciar sesión'
      using errcode = 'insufficient_privilege';
  end if;
  -- Un solo código vivo por usuario: los anteriores se invalidan.
  delete from public.device_pair_codes
  where owner_id is not distinct from auth.uid();
  -- Genera hasta chocar poco (reintentos ante colisión del unique).
  for v_i in 1..5 loop
    v_code := '';
    for v_j in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    begin
      insert into public.device_pair_codes (owner_id, code, device_name)
      values (
        auth.uid(), v_code,
        left(btrim(coalesce(p_name, '')), 60)
      );
      return v_code;
    exception when unique_violation then
      null;
    end;
  end loop;
  raise exception 'No se pudo generar el código. Inténtalo de nuevo.'
    using errcode = 'unique_violation';
end;
$$;

comment on function public.create_device_pair_code(text) is
  'Código corto de un solo uso (5 min) para vincular un PC. Invalida los anteriores.';

-- Revocar: invalida la credencial al instante (la RLS deja de verlo todo).
create or replace function public.revoke_device(p_device_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.device_owner_id(p_device_id) is distinct from auth.uid() then
    raise exception 'Ese PC no es tuyo'
      using errcode = 'insufficient_privilege';
  end if;
  update public.user_devices
     set revoked_at = now()
   where id = p_device_id
     and revoked_at is null;
  if not found then return false; end if;
  insert into public.device_audit_log (device_id, owner_id, actor_id, action, detail)
  values (p_device_id, auth.uid(), auth.uid(), 'revoked', 'Credencial revocada por el dueño.');
  return true;
end;
$$;

comment on function public.revoke_device(uuid) is
  'Revoca un PC (invalida su credencial al instante; el compañero vuelve a la pantalla de vinculación).';

-- Pedir un comando al PC (el dueño, desde un chat permitido).
create or replace function public.request_device_command(
  p_device_id uuid,
  p_action text,
  p_params jsonb,
  p_workspace_id uuid,
  p_chat_id text,
  p_message_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device public.user_devices%rowtype;
  v_risk text;
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
  v_cmd_id uuid;
  v_status text;
  v_text text;
begin
  if auth.uid() is null then
    raise exception 'Hay que iniciar sesión'
      using errcode = 'insufficient_privilege';
  end if;
  if public.my_device_id() is not null then
    raise exception 'Los dispositivos no pueden pedir comandos'
      using errcode = 'insufficient_privilege';
  end if;
  select * into v_device
  from public.user_devices d
  where d.id = p_device_id;
  if v_device.id is null or v_device.owner_id is distinct from auth.uid() then
    raise exception 'Ese PC no es tuyo'
      using errcode = 'insufficient_privilege';
  end if;
  if v_device.revoked_at is not null then
    raise exception 'Ese PC está revocado'
      using errcode = 'insufficient_privilege';
  end if;
  -- Catálogo cerrado + habilitado en este PC.
  if p_action is null or not (
    p_action in ('pc_status', 'open_app', 'open_url', 'find_files', 'send_file',
      'screenshot', 'lock_screen', 'volume_set', 'media_control',
      'run_script', 'arbitrary_exec')
  ) then
    raise exception 'Esa acción no existe en el catálogo'
      using errcode = 'check_violation';
  end if;
  if not (p_action = any (v_device.allowed_actions)) then
    raise exception 'Esa acción está apagada en este PC'
      using errcode = 'insufficient_privilege';
  end if;
  if p_action = 'arbitrary_exec' and not v_device.allow_arbitrary then
    raise exception 'Los comandos arbitrarios están apagados en este PC'
      using errcode = 'insufficient_privilege';
  end if;
  -- Parámetros validados (tope de tamaño + forma por acción).
  v_text := coalesce(v_params ->> 'text', '');
  if char_length(v_text) > 2000 or jsonb_typeof(v_params) <> 'object' then
    raise exception 'Parámetros inválidos'
      using errcode = 'check_violation';
  end if;
  if p_action in ('open_app', 'run_script') and (v_text = '' or char_length(v_text) > 120) then
    raise exception 'Falta qué abrir o qué script correr'
      using errcode = 'check_violation';
  end if;
  if p_action = 'open_url'
     and (v_text = '' or char_length(v_text) > 2000
       or v_text !~* '^https://[^ ]+$') then
    raise exception 'Solo URLs https válidas'
      using errcode = 'check_violation';
  end if;
  if p_action = 'find_files' and (v_text = '' or char_length(v_text) > 120) then
    raise exception 'Falta qué buscar'
      using errcode = 'check_violation';
  end if;
  if p_action = 'send_file' and (v_text = '' or char_length(v_text) > 500) then
    raise exception 'Falta el archivo a mandar'
      using errcode = 'check_violation';
  end if;
  if p_action in ('find_files', 'send_file') then
    declare
      v_dir text := coalesce(v_params ->> 'dir', '');
    begin
      if v_dir <> '' and not (v_dir = any (v_device.readable_dirs)) then
        raise exception 'Esa carpeta no está permitida en este PC'
          using errcode = 'insufficient_privilege';
      end if;
      if v_text ~ '\.\.' then
        raise exception 'Esa ruta no está permitida'
          using errcode = 'check_violation';
      end if;
    end;
  end if;
  if p_action = 'send_file' and not v_device.can_send_files then
    raise exception 'Este PC no puede mandar archivos al chat'
      using errcode = 'insufficient_privilege';
  end if;
  if p_action = 'arbitrary_exec' and (v_text = '' or char_length(v_text) > 2000) then
    raise exception 'Falta el comando a ejecutar'
      using errcode = 'check_violation';
  end if;
  -- Ritmo + alcance del chat.
  if not public.device_command_rate_ok(p_device_id) then
    raise exception 'Demasiados pedidos seguidos. Espera un minuto.'
      using errcode = 'check_violation';
  end if;
  if not public.can_order_device(p_device_id, p_workspace_id, coalesce(p_chat_id, '')) then
    raise exception 'Desde este chat no se puede ordenar a ese PC'
      using errcode = 'insufficient_privilege';
  end if;
  v_risk := public.device_action_risk(p_action);
  v_status := case when v_risk = 'sensible' then 'pending_confirmation' else 'queued' end;
  insert into public.device_commands
    (device_id, owner_id, workspace_id, chat_id, message_id,
     requested_by, action, params, risk, status)
  values (
    p_device_id, auth.uid(), p_workspace_id, coalesce(p_chat_id, ''), p_message_id,
    auth.uid(), p_action, v_params, v_risk, v_status
  )
  returning id into v_cmd_id;
  insert into public.device_audit_log (device_id, owner_id, command_id, actor_id, action, detail)
  values (
    p_device_id, auth.uid(), v_cmd_id, auth.uid(), 'requested',
    left(p_action || ' desde ' || case when p_workspace_id is null then 'Loki IA' else 'chat ' || coalesce(p_chat_id, '') end, 200)
  );
  -- Lo sensible avisa al teléfono SIN datos del PC (solo "necesita tu aprobación").
  if v_status = 'pending_confirmation' then
    begin
      insert into public.notifications (user_id, workspace_id, type, title, body, link)
      values (
        auth.uid(), p_workspace_id, 'device',
        'Tu PC necesita tu aprobación',
        'Abre Loki para revisar la orden.',
        '/dispositivos/aprobar?cmd=' || v_cmd_id::text
      );
    exception when others then
      null;
    end;
  end if;
  return jsonb_build_object('id', v_cmd_id, 'status', v_status, 'risk', v_risk);
end;
$$;

comment on function public.request_device_command(uuid, text, jsonb, uuid, text, uuid) is
  'Pide un comando del catálogo al PC (el dueño, desde un chat permitido). Lo sensible queda en pending_confirmation y avisa al teléfono.';

-- Aprobar o rechazar en el teléfono (o en la web con re-autenticación).
create or replace function public.confirm_device_command(p_command_id uuid, p_ok boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cmd public.device_commands%rowtype;
begin
  if public.my_device_id() is not null then
    raise exception 'Los dispositivos no confirman órdenes'
      using errcode = 'insufficient_privilege';
  end if;
  select * into v_cmd
  from public.device_commands c
  where c.id = p_command_id;
  if v_cmd.id is null then return false; end if;
  if v_cmd.owner_id is distinct from auth.uid() then
    raise exception 'Ese comando no es tuyo'
      using errcode = 'insufficient_privilege';
  end if;
  if v_cmd.status <> 'pending_confirmation' then return false; end if;
  -- Las confirmaciones vencen en 5 minutos.
  if v_cmd.created_at <= now() - interval '5 minutes' then
    update public.device_commands
       set status = 'expired'
     where id = p_command_id
       and status = 'pending_confirmation';
    insert into public.device_audit_log (device_id, owner_id, command_id, actor_id, action, detail)
    values (v_cmd.device_id, auth.uid(), p_command_id, auth.uid(), 'expired', 'La confirmación venció (5 min).');
    return false;
  end if;
  if p_ok then
    update public.device_commands
       set status = 'queued',
           confirmed_by = auth.uid(),
           confirmed_at = now()
     where id = p_command_id
       and status = 'pending_confirmation';
  else
    update public.device_commands
       set status = 'rejected',
           confirmed_by = auth.uid(),
           confirmed_at = now()
     where id = p_command_id
       and status = 'pending_confirmation';
  end if;
  insert into public.device_audit_log (device_id, owner_id, command_id, actor_id, action, detail)
  values (
    v_cmd.device_id, auth.uid(), p_command_id, auth.uid(),
    case when p_ok then 'confirmed' else 'rejected' end,
    case when p_ok then 'Aprobado por el dueño.' else 'Rechazado por el dueño.' end
  );
  return found;
end;
$$;

comment on function public.confirm_device_command(uuid, boolean) is
  'Aprueba o rechaza un comando sensible (el dueño, dentro de 5 min).';

-- Ajustes por dispositivo (el dueño).
create or replace function public.update_device_settings(
  p_device_id uuid,
  p_name text default null,
  p_allowed_actions text[] default null,
  p_readable_dirs text[] default null,
  p_can_send_files boolean default null,
  p_allow_arbitrary boolean default null,
  p_allowed_chat_ids text[] default null,
  p_clear_chat_scope boolean default false,
  p_allowed_workspace_ids uuid[] default null,
  p_clear_workspace_scope boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clean text[];
begin
  if public.device_owner_id(p_device_id) is distinct from auth.uid() then
    raise exception 'Ese PC no es tuyo'
      using errcode = 'insufficient_privilege';
  end if;
  if p_allowed_actions is not null then
    select array_agg(x) into v_clean
    from unnest(p_allowed_actions) as x
    where x in ('pc_status', 'open_app', 'open_url', 'find_files', 'send_file',
      'screenshot', 'lock_screen', 'volume_set', 'media_control',
      'run_script', 'arbitrary_exec');
    if v_clean is null then v_clean := '{}'; end if;
  end if;
  update public.user_devices
     set name = case when p_name is null then name else left(btrim(p_name), 60) end,
         allowed_actions = coalesce(v_clean, allowed_actions),
         readable_dirs = case when p_readable_dirs is null then readable_dirs
           else coalesce(
             (select array_agg(left(btrim(x), 200)) from unnest(p_readable_dirs) as x),
             '{}'
           ) end,
         can_send_files = coalesce(p_can_send_files, can_send_files),
         allow_arbitrary = coalesce(p_allow_arbitrary, allow_arbitrary),
         allowed_chat_ids = case
           when p_clear_chat_scope then null
           when p_allowed_chat_ids is null then allowed_chat_ids
           else p_allowed_chat_ids end,
         allowed_workspace_ids = case
           when p_clear_workspace_scope then null
           when p_allowed_workspace_ids is null then allowed_workspace_ids
           else p_allowed_workspace_ids end
   where id = p_device_id;
  insert into public.device_audit_log (device_id, owner_id, actor_id, action, detail)
  values (p_device_id, auth.uid(), auth.uid(), 'settings', 'Permisos del PC actualizados.');
  return true;
end;
$$;

comment on function public.update_device_settings(uuid, text, text[], text[], boolean, boolean, text[], boolean, uuid[], boolean) is
  'Permisos por dispositivo (el dueño): acciones, carpetas, envío de archivos y alcance de chats.';

-- -----------------------------------------------------------------------------
-- 8. RPC del dispositivo (con su propio JWT).
-- -----------------------------------------------------------------------------

-- Latido: actualiza último contacto, versión y sistema.
create or replace function public.device_heartbeat(
  p_device_id uuid, p_app_version text default null, p_platform text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.my_device_id() is distinct from p_device_id then
    raise exception 'Credencial inválida para este PC'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.device_is_active(p_device_id) then
    raise exception 'PC revocado. Vuelve a vincularlo.'
      using errcode = 'insufficient_privilege';
  end if;
  update public.user_devices
     set last_seen_at = now(),
         app_version = case when p_app_version is null then app_version
           else left(btrim(p_app_version), 32) end,
         platform = case when p_platform is null then platform
           else case when p_platform in ('windows', 'linux', 'macos', 'other')
             then p_platform else platform end end
   where id = p_device_id;
  return true;
end;
$$;

comment on function public.device_heartbeat(uuid, text, text) is
  'Latido del compañero (último contacto, versión y sistema). Detecta revocación.';

-- Reclamar para ejecutar (doble control: el PC vuelve a comprobar riesgo y
-- confirmación contra la base, no confía solo en lo que vio la app).
create or replace function public.device_claim_command(p_command_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cmd public.device_commands%rowtype;
  v_device public.user_devices%rowtype;
begin
  if public.my_device_id() is null then
    raise exception 'Solo el compañero de escritorio reclama comandos'
      using errcode = 'insufficient_privilege';
  end if;
  select * into v_cmd
  from public.device_commands c
  where c.id = p_command_id;
  if v_cmd.id is null then
    raise exception 'Comando inexistente'
      using errcode = 'check_violation';
  end if;
  if v_cmd.device_id is distinct from public.my_device_id() then
    raise exception 'Ese comando no es para este PC'
      using errcode = 'insufficient_privilege';
  end if;
  select * into v_device
  from public.user_devices d
  where d.id = v_cmd.device_id;
  if v_device.revoked_at is not null then
    raise exception 'PC revocado. Vuelve a vincularlo.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_cmd.status not in ('queued', 'delivered') then
    raise exception 'El comando ya no está pendiente'
      using errcode = 'check_violation';
  end if;
  if v_cmd.expires_at <= now() then
    update public.device_commands
       set status = 'expired'
     where id = p_command_id
       and status in ('queued', 'delivered');
    return jsonb_build_object('ok', false, 'code', 'expired');
  end if;
  -- Doble control: lo sensible exige confirmación registrada en la base y la
  -- acción sigue habilitada en el PC (por si se apagó entre el pedido y ahora).
  if v_cmd.risk = 'sensible' and v_cmd.confirmed_at is null then
    raise exception 'Falta la confirmación del dueño'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_cmd.action = any (v_device.allowed_actions)) then
    raise exception 'Esa acción está apagada en este PC'
      using errcode = 'insufficient_privilege';
  end if;
  if v_cmd.action = 'arbitrary_exec' and not v_device.allow_arbitrary then
    raise exception 'Los comandos arbitrarios están apagados en este PC'
      using errcode = 'insufficient_privilege';
  end if;
  update public.device_commands
     set status = 'running',
         started_at = coalesce(started_at, now())
   where id = p_command_id
     and status in ('queued', 'delivered');
  insert into public.device_audit_log
    (device_id, owner_id, command_id, action, detail)
  values (v_cmd.device_id, v_cmd.owner_id, p_command_id, 'claimed', 'El PC tomó el comando.');
  return jsonb_build_object(
    'ok', true, 'action', v_cmd.action, 'params', v_cmd.params, 'risk', v_cmd.risk
  );
end;
$$;

comment on function public.device_claim_command(uuid) is
  'El PC reclama un comando (revalida riesgo, confirmación y permisos: doble control) y recibe qué ejecutar.';

-- Reportar el resultado (texto corto o archivo en Storage).
create or replace function public.device_report_result(
  p_command_id uuid, p_ok boolean, p_result_text text default '',
  p_result_path text default null, p_result_mime text default ''
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cmd public.device_commands%rowtype;
begin
  if public.my_device_id() is null then
    raise exception 'Solo el compañero de escritorio reporta resultados'
      using errcode = 'insufficient_privilege';
  end if;
  select * into v_cmd
  from public.device_commands c
  where c.id = p_command_id;
  if v_cmd.id is null then return false; end if;
  if v_cmd.device_id is distinct from public.my_device_id() then
    raise exception 'Ese comando no es para este PC'
      using errcode = 'insufficient_privilege';
  end if;
  if v_cmd.status not in ('running', 'delivered', 'queued') then return false; end if;
  update public.device_commands
     set status = case when p_ok then 'done' else 'error' end,
         result_text = left(coalesce(p_result_text, ''), 8000),
         result_path = case when p_result_path is null then result_path
           else left(p_result_path, 500) end,
         result_mime = left(coalesce(p_result_mime, ''), 127),
         error = case when p_ok then null
           else left(coalesce(nullif(btrim(coalesce(p_result_text, '')), ''), 'Falló en el PC.'), 500) end,
         finished_at = now()
   where id = p_command_id;
  insert into public.device_audit_log
    (device_id, owner_id, command_id, action, detail)
  values (
    v_cmd.device_id, v_cmd.owner_id, p_command_id,
    case when p_ok then 'done' else 'error' end,
    left(coalesce(p_result_text, ''), 200)
  );
  return true;
end;
$$;

comment on function public.device_report_result(uuid, boolean, text, text, text) is
  'El PC reporta done/error con texto corto o archivo en Storage (lo grande nunca va al mensaje).';

-- Barrido barato (pg_cron cada minuto, sin LLM): expiran los no entregados.
create or replace function public.expire_device_commands()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  with viejos as (
    select id
    from public.device_commands
    where status in ('pending_confirmation', 'queued', 'delivered')
      and expires_at <= now()
    order by expires_at asc
    limit 100
    for update skip locked
  )
  update public.device_commands c
     set status = 'expired'
    from viejos
   where c.id = viejos.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.expire_device_commands() is
  'Marca expired los comandos no entregados (pg_cron cada minuto, SQL barato, sin LLM).';

-- -----------------------------------------------------------------------------
-- 9. Storage `device-results` (capturas y archivos del PC al chat).
-- Ruta `{owner_id}/{device_id}/…`: el dueño lee, el PC sube lo suyo.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('device-results', 'device-results', false)
on conflict (id) do nothing;

drop policy if exists "device-results: leer lo mio" on storage.objects;
create policy "device-results: leer lo mio"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'device-results'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "device-results: el PC sube lo suyo" on storage.objects;
create policy "device-results: el PC sube lo suyo"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'device-results'
    and public.my_device_id() is not null
    and split_part(name, '/', 1) = public.device_owner_id(public.my_device_id())::text
    and split_part(name, '/', 2) = public.my_device_id()::text
  );

drop policy if exists "device-results: el dueño borra lo suyo" on storage.objects;
create policy "device-results: el dueño borra lo suyo"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'device-results'
    and split_part(name, '/', 1) = auth.uid()::text
  );

-- -----------------------------------------------------------------------------
-- 10. Realtime (el PC recibe y la app ve el estado en vivo) + pg_cron.
-- -----------------------------------------------------------------------------
do $devicepub$
begin
  begin
    alter publication supabase_realtime add table public.user_devices;
  exception when others then
    raise notice 'no se pudo publicar user_devices en realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.device_commands;
  exception when others then
    raise notice 'no se pudo publicar device_commands en realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.device_audit_log;
  exception when others then
    raise notice 'no se pudo publicar device_audit_log en realtime: %', sqlerrm;
  end;
end
$devicepub$;

do $devicecron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin expiración de comandos: %', sqlerrm;
    return;
  end;
  begin
    perform cron.unschedule('loki-devices-expire');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule(
      'loki-devices-expire',
      '* * * * *',
      'select public.expire_device_commands()'
    );
  exception when others then
    raise notice 'no se pudo programar la expiración de comandos: %', sqlerrm;
  end;
end
$devicecron$;

grant execute on function public.my_device_id() to authenticated;
grant execute on function public.device_owner_id(uuid) to authenticated;
grant execute on function public.device_is_active(uuid) to authenticated;
grant execute on function public.can_order_device(uuid, uuid, text) to authenticated;
grant execute on function public.device_command_rate_ok(uuid) to authenticated;
grant execute on function public.device_action_risk(text) to authenticated;
grant execute on function public.create_device_pair_code(text) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.request_device_command(uuid, text, jsonb, uuid, text, uuid) to authenticated;
grant execute on function public.confirm_device_command(uuid, boolean) to authenticated;
grant execute on function public.update_device_settings(uuid, text, text[], text[], boolean, boolean, text[], boolean, uuid[], boolean) to authenticated;
grant execute on function public.device_heartbeat(uuid, text, text) to authenticated;
grant execute on function public.device_claim_command(uuid) to authenticated;
grant execute on function public.device_report_result(uuid, boolean, text, text, text) to authenticated;
-- expire_device_commands es interna (pg_cron): nadie la llama directo.
revoke execute on function public.expire_device_commands() from public;
revoke execute on function public.expire_device_commands() from anon;
revoke execute on function public.expire_device_commands() from authenticated;
