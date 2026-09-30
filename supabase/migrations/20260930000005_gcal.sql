-- =============================================================================
-- Loki · sincronización bidireccional con Google Calendar.
-- NUEVA migración: no toca las anteriores. Añade el espejo externo en
-- `events` (external_id / external_source) y la tabla `calendar_connections`
-- (una fila por usuario con los tokens OAuth de Google).
--
-- Convenciones heredadas: snake_case, comentarios en español, RLS por fila
-- propia (user_id = auth.uid()), GRANTs explícitos a authenticated.
-- El refresh_token se guarda cifrado por la Edge (AES-GCM + GOOGLE_TOKEN_KEY);
-- aquí solo viaja como text opaco.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Espejo externo en events (id de Google + origen).
-- -----------------------------------------------------------------------------

alter table public.events
  add column if not exists external_id text;

alter table public.events
  add column if not exists external_source text not null default 'loki';

comment on column public.events.external_id is
  'Id del evento en el proveedor externo (Google Calendar). Null = solo Loki.';
comment on column public.events.external_source is
  'Origen del evento: loki (creado aquí) o google (importado de Google).';

-- Búsqueda del espejo: solo las filas vinculadas (parcial, no pesa en Loki puro).
create index if not exists events_external_id_idx
  on public.events (workspace_id, external_id)
  where external_id is not null;

-- -----------------------------------------------------------------------------
-- 2. Conexiones de calendario (una fila por usuario).
-- -----------------------------------------------------------------------------

create table if not exists public.calendar_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider text not null default 'google',
  -- Cifrado AES-GCM por la Edge Function (aquí solo se guarda el texto).
  refresh_token text not null,
  access_token text not null default '',
  expires_at timestamptz,
  google_email text not null default '',
  calendar_id text not null default 'primary',
  sync_enabled boolean not null default true,
  last_pull_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.calendar_connections is
  'Conexión OAuth con Google Calendar por usuario (tokens cifrados por la Edge). Una fila por usuario.';
comment on column public.calendar_connections.refresh_token is
  'Refresh token de Google cifrado con AES-GCM (GOOGLE_TOKEN_KEY). Opaco para la base.';
comment on column public.calendar_connections.access_token is
  'Access token temporal de Google (se refresca solo). No se expone al cliente.';
comment on column public.calendar_connections.last_pull_at is
  'Última importación (pull) desde Google hacia Loki.';

-- updated_at automático (mismo trigger que el resto de tablas).
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'touch_updated_at_calendar_connections'
  ) then
    create trigger touch_updated_at_calendar_connections
      before update on public.calendar_connections
      for each row execute function public.touch_updated_at();
  end if;
end
$$;

alter table public.calendar_connections enable row level security;

-- Solo la fila propia: leer, crear, editar y borrar.
drop policy if exists "gcal: leer la mia" on public.calendar_connections;
create policy "gcal: leer la mia"
  on public.calendar_connections for select to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "gcal: crear la mia" on public.calendar_connections;
create policy "gcal: crear la mia"
  on public.calendar_connections for insert to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "gcal: editar la mia" on public.calendar_connections;
create policy "gcal: editar la mia"
  on public.calendar_connections for update to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

drop policy if exists "gcal: borrar la mia" on public.calendar_connections;
create policy "gcal: borrar la mia"
  on public.calendar_connections for delete to authenticated
  using (user_id is not distinct from auth.uid());

-- -----------------------------------------------------------------------------
-- 3. Privilegios (la puerta es la RLS; la Edge usa service_role por encima).
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on public.calendar_connections to authenticated;
