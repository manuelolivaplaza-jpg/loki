-- =============================================================================
-- Tareas recurrentes y turnos rotativos (prompt 6, ejecutado sobre p16).
-- NUEVA migración: no toca las anteriores.
--
-- Idea: una SERIE es una plantilla ("sacar la basura", "pagar la luz") que
-- genera ocurrencias como tareas NORMALES en `tasks`. Así el kanban, Inicio,
-- la búsqueda y los recordatorios que ya existen siguen funcionando sin
-- cambios: la serie no es una tarea aparte, es la fuente de sus tareas.
--
-- 1. `task_series`: plantilla (título/notas/prioridad), regla de recurrencia
--    SIMPLE y acotada (diario, semanal con días, mensual con día del mes o
--    "primer lunes", cada N días o semanas), zona horaria (default
--    America/Santiago), fecha de término opcional, pausa de días, rotación
--    (uuid[] con su orden e índice actual, saltos por vacaciones), activa y
--    quién la creó. `next_occurrence` y `last_occurrence` los calcula la base:
--    un trigger de guarda impide que el cliente los mueva.
-- 2. `tasks`: dos columnas nuevas (`series_id`, `series_occurrence`).
-- 3. `shift_swaps`: solicitud de intercambio de un turno ("¿me cambias el
--    turno?") con estado; solo la resuelven los dos involucrados.
-- 4. Generación por eventos, SQL barato y sin LLM:
--    · al crear la serie, al completarse una ocurrencia y en un barrido de
--      pg_cron (`materialize_series_occurrences`, horizonte de 1 día: nunca
--      se crean cientos de tareas futuras);
--    · fechas calculadas en la zona de la serie, con el horario de verano de
--      Chile bien hecho (todo el cálculo es `date` + `at time zone`: el
--      cambio de horario lo sabe Postgres, no un offset fijo).
-- 5. Recordatorios (`create_shift_reminders`): aviso al responsable el día
--    anterior y a la hora configurada, "te toca hoy" y un recordatorio amable
--    si quedó sin hacer. Idempotentes por `dedupe`, tipo `shift` (que
--    `push-send` ya respeta por preferencia y horario de silencio).
-- 6. Quien sale del espacio sale de la rotación y se avisa a quien creó la
--    serie.
-- 7. El resumen diario (p11) tenía el conteo de turnos en 0 "hasta que
--    lleguen las tablas": aquí se rellena.
--
-- Permisos: cada miembro crea y edita SUS series; un admin, todas. Un
-- intercambio solo lo resuelven los dos involucrados (RLS por membresía +
-- tests en tests/rls/recurring.test.mjs).
--
-- Convenciones heredadas: snake_case, SECURITY DEFINER con search_path fijo,
-- políticas con nombre en español, DROP POLICY IF EXISTS + CREATE POLICY,
-- GRANTs explícitos, y pg_cron en bloques DO con EXCEPTION.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Tipo `shift` (turnos y recurrentes) + interruptor por tipo
-- -----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add check (type in (
  'mention', 'reply', 'reaction', 'task_assigned', 'task_due',
  'event_reminder', 'invite', 'ai_alert', 'list', 'poll', 'memory', 'daily',
  'agent', 'device', 'shift'
));

alter table public.notification_prefs
  add column if not exists shift boolean not null default true;

comment on column public.notification_prefs.shift is
  'Turnos rotativos y tareas recurrentes ("mañana te toca", "se te pasó").';

-- -----------------------------------------------------------------------------
-- 1. Series de tareas
-- -----------------------------------------------------------------------------
create table if not exists public.task_series (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  -- Plantilla de la ocurrencia (lo que se copia a cada tarea).
  title text not null check (char_length(btrim(title)) between 1 and 200),
  notes text not null default '',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  -- Regla de recurrencia acotada (a propósito: nada de RRULE completo).
  recurrence_kind text not null check (
    recurrence_kind in ('daily', 'weekly', 'monthly', 'interval')
  ),
  recurrence_interval integer not null default 1
    check (recurrence_interval between 1 and 60),
  recurrence_unit text not null default 'weeks' check (recurrence_unit in ('days', 'weeks')),
  -- 0 = domingo … 6 = sábado.
  weekdays smallint[] not null default '{}',
  -- Mensual por día del mes (1-31) o por "nº de semana + día" (1-4, y 5 = el
  -- último del mes, p. ej. "el último viernes").
  month_day smallint check (month_day between 1 and 31),
  month_week smallint check (month_week between 1 and 5),
  month_weekday smallint check (month_weekday between 0 and 6),
  start_date date not null,
  -- Hora local de la ocurrencia (con su zona, el horario de verano lo aplica
  -- Postgres al convertir a timestamptz).
  time_of_day time not null default '09:00',
  timezone text not null default 'America/Santiago'
    check (char_length(btrim(timezone)) between 1 and 64),
  -- Hora del aviso (día antes y el mismo día).
  remind_time time not null default '09:00',
  ends_on date,
  -- Rotación: orden de los uids e índice del que toca ahora.
  rotation uuid[] not null default '{}',
  rotation_index integer not null default 0 check (rotation_index >= 0),
  -- Vacaciones: [{user_id, from, to, reason}].
  rotation_skips jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rotation_skips) = 'array'),
  -- Pausas y excepciones de días: [{from, to, reason}].
  pauses jsonb not null default '[]'::jsonb check (jsonb_typeof(pauses) = 'array'),
  -- Los calcula la base (guardados por el trigger `task_series_guard_update`).
  next_occurrence date,
  last_occurrence integer not null default 0 check (last_occurrence >= 0),
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- La recurrencia tiene que estar completa (semáforo de la UI incluida).
  constraint task_series_regla check (
    (recurrence_kind = 'weekly' and coalesce(array_length(weekdays, 1), 0) > 0)
    or (recurrence_kind = 'monthly' and (
      month_day is not null or (month_week is not null and month_weekday is not null)
    ))
    or recurrence_kind in ('daily', 'interval')
  ),
  constraint task_series_fin check (ends_on is null or ends_on >= start_date)
);

comment on table public.task_series is
  'Plantillas de tareas que se repiten. Cada ocurrencia es una fila normal de tasks (series_id + series_occurrence).';

comment on column public.task_series.rotation is
  'Orden de la rotación (uids del espacio). Vacío = sin turnos.';

create index if not exists task_series_ws_idx
  on public.task_series (workspace_id, active);

create index if not exists task_series_next_idx
  on public.task_series (next_occurrence) where active and next_occurrence is not null;

create index if not exists task_series_project_idx
  on public.task_series (project_id);

drop trigger if exists task_series_touch_updated_at on public.task_series;
create trigger task_series_touch_updated_at
  before update on public.task_series
  for each row execute function public.touch_updated_at();

-- Tareas de una serie: kanban, búsqueda y recordatorios siguen igual.
alter table public.tasks
  add column if not exists series_id uuid references public.task_series (id) on delete cascade;

alter table public.tasks
  add column if not exists series_occurrence integer;

comment on column public.tasks.series_id is
  'Serie de la que nació esta ocurrencia (null = tarea normal).';

comment on column public.tasks.series_occurrence is
  'Número de ocurrencia dentro de la serie (1, 2, 3…).';

create index if not exists tasks_series_idx
  on public.tasks (series_id, series_occurrence) where series_id is not null;

create index if not exists tasks_series_due_idx
  on public.tasks (series_id, due_at) where series_id is not null and status <> 'done';

-- -----------------------------------------------------------------------------
-- 2. Solicitudes de intercambio de turno
-- -----------------------------------------------------------------------------
create table if not exists public.shift_swaps (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.task_series (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  from_user_id uuid not null references auth.users (id) on delete cascade,
  to_user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  note text not null default '',
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint shift_swaps_distintos check (from_user_id <> to_user_id)
);

comment on table public.shift_swaps is
  'Intercambios de turno ("¿me cambias el turno?"). Solo los dos involucrados participan.';

create index if not exists shift_swaps_to_idx
  on public.shift_swaps (to_user_id, status, created_at desc);

create index if not exists shift_swaps_from_idx
  on public.shift_swaps (from_user_id, created_at desc);

create index if not exists shift_swaps_series_idx
  on public.shift_swaps (series_id, status);

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------
alter table public.task_series enable row level security;
alter table public.shift_swaps enable row level security;

-- --- series: el espacio las ve; crear cada uno la suya (a nombre propio);
--     editar/borrar, quien la creó o un admin del espacio.
drop policy if exists "series: ver las de mi espacio" on public.task_series;
create policy "series: ver las de mi espacio"
  on public.task_series for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "series: crear las mias" on public.task_series;
create policy "series: crear las mias"
  on public.task_series for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
  );

drop policy if exists "series: editar creador o admin" on public.task_series;
create policy "series: editar creador o admin"
  on public.task_series for update to authenticated
  using (
    public.is_member(workspace_id)
    and (
      created_by is not distinct from auth.uid()
      or public.is_space_admin(workspace_id)
    )
  )
  with check (
    public.is_member(workspace_id)
    and (
      created_by is not distinct from auth.uid()
      or public.is_space_admin(workspace_id)
    )
  );

drop policy if exists "series: borrar creador o admin" on public.task_series;
create policy "series: borrar creador o admin"
  on public.task_series for delete to authenticated
  using (
    public.is_member(workspace_id)
    and (
      created_by is not distinct from auth.uid()
      or public.is_space_admin(workspace_id)
    )
  );

-- --- intercambios: solo participan los dos de cada intercambio (un tercero no
--     ve ni puede resolver lo ajeno).
drop policy if exists "turnos: ver los que me tocan" on public.shift_swaps;
create policy "turnos: ver los que me tocan"
  on public.shift_swaps for select to authenticated
  using (
    public.is_member(workspace_id)
    and (from_user_id = auth.uid() or to_user_id = auth.uid())
  );

drop policy if exists "turnos: pedir mi cambio" on public.shift_swaps;
create policy "turnos: pedir mi cambio"
  on public.shift_swaps for insert to authenticated
  with check (
    from_user_id = auth.uid()
    and public.is_member(workspace_id)
    and to_user_id <> auth.uid()
    and exists (
      select 1 from public.task_series s
      where s.id = series_id and to_user_id = any (s.rotation)
    )
  );

-- Resolver va SIEMPRE por la RPC (`resolve_shift_swap`), que además mueve el
-- turno y avisa: por eso el UPDATE directo está cerrado (si alguien lo intenta
-- desde el cliente, afecta 0 filas).
drop policy if exists "turnos: resolver por la rpc" on public.shift_swaps;
create policy "turnos: resolver por la rpc"
  on public.shift_swaps for update to authenticated
  using (false)
  with check (false);

drop policy if exists "turnos: borrar el mio" on public.shift_swaps;
create policy "turnos: borrar el mio"
  on public.shift_swaps for delete to authenticated
  using (from_user_id = auth.uid() or to_user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 4. La regla de recurrencia, en `date` (sin LLM y sin horario de verano
--    roto: los Conversores a timestamptz los hace Postgres con la zona).
-- -----------------------------------------------------------------------------

-- Reloj local de una zona (America/Santiago por defecto). Si la zona guardada
-- no existe en el tzdata, cae a Santiago en vez de romper el job.
create or replace function public.series_local_clock(p_timezone text)
returns timestamp
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return now() at time zone coalesce(nullif(btrim(p_timezone), ''), 'America/Santiago');
exception when others then
  return now() at time zone 'America/Santiago';
end;
$$;

comment on function public.series_local_clock(text) is
  'Hora mural de una zona IANA para "ahora" (con horario de verano). Zona inválida = Santiago.';

-- ¿La fecha cae en una pausa o excepción de la serie?
create or replace function public.series_in_pause(p_pauses jsonb, p_date date)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_from date;
  v_to date;
begin
  if p_pauses is null or jsonb_typeof(p_pauses) <> 'array' then
    return false;
  end if;
  for v_item in select value from jsonb_array_elements(p_pauses) loop
    begin
      v_from := nullif(btrim(coalesce(v_item ->> 'from', '')), '')::date;
      v_to := nullif(btrim(coalesce(v_item ->> 'to', '')), '')::date;
    exception when others then
      v_from := null;
      v_to := null;
    end;
    continue when v_from is null;
    if v_to is null then v_to := v_from; end if;
    if p_date >= v_from and p_date <= v_to then
      return true;
    end if;
  end loop;
  return false;
exception when others then
  return false;
end;
$$;

-- ¿Alguien está de vacaciones ese día?
create or replace function public.series_is_skipped(p_skips jsonb, p_user_id uuid, p_date date)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_from date;
  v_to date;
  v_mio boolean;
begin
  if p_skips is null or jsonb_typeof(p_skips) <> 'array' or p_user_id is null then
    return false;
  end if;
  for v_item in select value from jsonb_array_elements(p_skips) loop
    v_mio := lower(btrim(coalesce(v_item ->> 'user_id', ''))) = p_user_id::text;
    if v_mio then
      begin
        v_from := nullif(btrim(coalesce(v_item ->> 'from', '')), '')::date;
        v_to := nullif(btrim(coalesce(v_item ->> 'to', '')), '')::date;
      exception when others then
        v_from := null;
        v_to := null;
      end;
    end if;
    continue when not coalesce(v_mio, false) or v_from is null;
    if v_to is null then v_to := v_from; end if;
    if p_date >= v_from and p_date <= v_to then
      return true;
    end if;
  end loop;
  return false;
exception when others then
  return false;
end;
$$;

-- ¿La fecha cumple la regla de la serie? (día a día: es barato y no tiene
--   casos raros; los meses cortos se ajustan al último día).
create or replace function public.series_date_matches(
  p_kind text,
  p_interval integer,
  p_unit text,
  p_weekdays smallint[],
  p_month_day smallint,
  p_month_week smallint,
  p_month_weekday smallint,
  p_start date,
  p_date date
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_dow integer := extract(dow from p_date)::int;
  v_day integer := extract(day from p_date)::int;
  v_last integer := extract(day from (date_trunc('month', p_date)::date + interval '1 month - 1 day'))::int;
  v_step integer;
  v_nth integer;
  v_wd smallint;
begin
  if p_date is null then return false; end if;

  if p_kind = 'daily' then
    return p_date >= p_start;
  end if;

  if p_kind = 'interval' then
    if p_start is null or p_date < p_start then return false; end if;
    v_step := greatest(1, p_interval) * case when p_unit = 'weeks' then 7 else 1 end;
    return ((p_date - p_start) % v_step) = 0;
  end if;

  if p_kind = 'weekly' then
    if p_start is not null and p_date < p_start then return false; end if;
    foreach v_wd in array coalesce(p_weekdays, '{}'::smallint[]) loop
      if v_wd is not null and v_wd between 0 and 6 and v_wd = v_dow then
        return true;
      end if;
    end loop;
    return false;
  end if;

  if p_kind = 'monthly' then
    if p_start is not null and p_date < p_start then return false; end if;
    if p_month_day is not null then
      -- "El 31": en febrero cae el 28/29 (último día del mes).
      return v_day = least(p_month_day, v_last);
    end if;
    if p_month_week is null or p_month_weekday is null then
      return false;
    end if;
    if v_dow <> p_month_weekday then return false; end if;
    v_nth := ((v_day - 1) / 7) + 1;
    if p_month_week >= 5 then
      -- "El último <día>": la última vez que aparece ese día en el mes.
      return v_day + 7 > v_last;
    end if;
    return v_nth = p_month_week;
  end if;

  return false;
end;
$$;

-- Siguiente fecha que cumple la regla (después de `p_after`, saltando pausas).
-- Con `p_after` nulo arranca en la fecha de inicio (o hoy, si ya pasó).
create or replace function public.series_next_date(
  p_series_id uuid,
  p_after date default null,
  p_limit_days integer default 800
)
returns date
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_series public.task_series%rowtype;
  v_date date;
  v_today date;
  v_step integer;
begin
  select * into v_series from public.task_series where id = p_series_id;
  if v_series.id is null then return null; end if;

  v_today := public.series_local_clock(v_series.timezone)::date;
  if p_after is null then
    v_date := greatest(v_series.start_date, v_today);
  else
    v_date := p_after + 1;
  end if;

  for v_step in 1..greatest(1, coalesce(p_limit_days, 800)) loop
    exit when v_date > v_today + 730;
    exit when v_series.ends_on is not null and v_date > v_series.ends_on;
    if public.series_date_matches(
         v_series.recurrence_kind,
         v_series.recurrence_interval,
         v_series.recurrence_unit,
         v_series.weekdays,
         v_series.month_day,
         v_series.month_week,
         v_series.month_weekday,
         v_series.start_date,
         v_date
       )
      and not public.series_in_pause(v_series.pauses, v_date)
    then
      return v_date;
    end if;
    v_date := v_date + 1;
  end loop;
  return null;
end;
$$;

comment on function public.series_next_date(uuid, date, integer) is
  'Próxima fecha que cumple la regla de la serie, saltando pausas y el término. SQL barato.';

-- Quién de la rotación toca en esa fecha (a partir de rotation_index, saltando
-- vacaciones y miembros que ya no están). Devuelve el uid y el índice que
-- queda para la siguiente.
create or replace function public.series_pick_rotation(
  p_rotation uuid[],
  p_index integer,
  p_skips jsonb,
  p_workspace_id uuid,
  p_date date
)
returns table (user_id uuid, next_index integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer := coalesce(array_length(p_rotation, 1), 0);
  v_k integer;
  v_pos integer;
  v_candidate uuid;
begin
  if v_n = 0 then
    return;
  end if;
  for v_k in 0..(v_n - 1) loop
    v_pos := ((coalesce(p_index, 0) - 1 + v_k) % v_n + v_n) % v_n;
    v_candidate := p_rotation[v_pos + 1];
    if v_candidate is null then
      continue;
    end if;
    if public.series_is_skipped(p_skips, v_candidate, p_date) then
      continue;
    end if;
    if not exists (
      select 1 from public.workspace_members m
      where m.workspace_id = p_workspace_id and m.user_id = v_candidate
    ) then
      continue;
    end if;
    return query select v_candidate, ((v_pos + 1) % v_n);
    return;
  end loop;
  -- Todo el padrón de vacaciones o fuera del espacio: no se asigna nadie y el
  -- índice no se mueve (así no se "quema" la rotación).
  return query select null::uuid, coalesce(p_index, 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Generación de ocurrencias (SQL barato, sin LLM, por eventos)
--
-- Se llama al crear la serie, al completarse una ocurrencia y en el barrido
-- de pg_cron. Horizonte de 1 día: la siguiente existe cuando toca, nunca
-- hundreds de tareas futuras. Con `auth.uid()` (llamada desde la app) exige
-- que quien llama pueda administrar esa serie.
-- -----------------------------------------------------------------------------
create or replace function public.materialize_series_occurrences(
  p_series_id uuid default null,
  p_workspace_id uuid default null,
  p_horizon_days integer default 1,
  p_max_per_series integer default 3
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series record;
  v_today date;
  v_limit date;
  v_date date;
  v_next date;
  v_no integer;
  v_last_no integer;
  v_created integer := 0;
  -- (el siguiente de la rotación se resuelve con series_pick_rotation)
  v_assignee uuid;
  v_next_index integer;
  v_position numeric;
  v_uid uuid := auth.uid();
begin
  perform set_config('loki.series_write', 'on', true);

  for v_series in
    select * from public.task_series s
     where s.active
       and (p_series_id is null or s.id = p_series_id)
       and (p_workspace_id is null or s.workspace_id = p_workspace_id)
       and (
         s.next_occurrence is not null
         or (s.next_occurrence is null and s.last_occurrence = 0)
       )
     order by s.created_at asc
     limit 200
  loop
    -- Permiso: el cron (auth.uid() nulo) pasa; la app, solo el creador o un
    -- admin del espacio.
    if v_uid is not null then
      if not public.is_member(v_series.workspace_id) then
        continue;
      end if;
      if v_series.created_by is distinct from v_uid
         and not public.is_space_admin(v_series.workspace_id)
      then
        continue;
      end if;
    end if;

    v_today := public.series_local_clock(v_series.timezone)::date;
    v_limit := v_today + greatest(0, coalesce(p_horizon_days, 1));

    -- Primera vez: se arranca en la fecha de inicio (o hoy, si ya pasó).
    v_date := v_series.next_occurrence;
    if v_date is null then
      v_date := public.series_next_date(v_series.id, null);
    end if;
    if v_date is null then
      continue;
    end if;

    v_no := 0;
    v_last_no := v_series.last_occurrence;
    while v_date <= v_limit
      and v_no < greatest(1, coalesce(p_max_per_series, 3))
      and (v_series.ends_on is null or v_date <= v_series.ends_on)
    loop
      v_no := v_no + 1;
      v_last_no := v_last_no + 1;
      v_next_index := v_series.rotation_index;

      -- Turno: el siguiente de la rotación que no esté de vacaciones.
      v_assignee := null;
      if coalesce(array_length(v_series.rotation, 1), 0) > 0 then
        select p.user_id, p.next_index into v_assignee, v_next_index
        from public.series_pick_rotation(
               v_series.rotation,
               v_series.rotation_index,
               v_series.rotation_skips,
               v_series.workspace_id,
               v_date
             ) as p(user_id, next_index);
      end if;

      select coalesce(max(t.position), 0) + 1024 into v_position
      from public.tasks t where t.project_id = v_series.project_id;

      insert into public.tasks (
        project_id, workspace_id, title, notes, status, priority,
        assignee_ids, due_at, position, series_id, series_occurrence, created_by
      ) values (
        v_series.project_id,
        v_series.workspace_id,
        v_series.title,
        v_series.notes,
        'todo',
        v_series.priority,
        case when v_assignee is null then '{}'::uuid[] else array[v_assignee] end,
        (v_date::timestamp + v_series.time_of_day) at time zone v_series.timezone,
        v_position,
        v_series.id,
        v_last_no,
        v_series.created_by
      );

      v_created := v_created + 1;
      v_next := public.series_next_date(v_series.id, v_date);

      update public.task_series
         set last_occurrence = v_last_no,
             rotation_index = v_next_index,
             next_occurrence = v_next,
             updated_at = now()
       where id = v_series.id;

      v_series.last_occurrence := v_last_no;
      v_series.rotation_index := v_next_index;
      v_series.next_occurrence := v_next;
      v_date := v_next;
    end loop;
  end loop;

  return v_created;
exception when others then
  -- Un job nunca debe tumbar el barrido: se avisa y se sigue.
  raise warning 'materialize_series_occurrences: %', sqlerrm;
  return v_created;
end;
$$;

comment on function public.materialize_series_occurrences(uuid, uuid, integer, integer) is
  'Genera las ocurrencias que tocan (hoy y mañana, como mucho). Triggers + pg_cron; sin LLM.';

-- -----------------------------------------------------------------------------
-- 6b. Puntero de la serie (lo mantiene la base)
--
-- `next_occurrence` = la próxima fecha por materializar; `last_occurrence` = el
-- número de la última ocurrencia viva. Se recalcula desde las tareas reales
-- (después de editar o borrar por alcance), nunca desde el cliente.
-- -----------------------------------------------------------------------------
create or replace function public.series_sync_pointer(p_series_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series public.task_series%rowtype;
  v_last integer := 0;
  v_after date;
  v_next date;
begin
  select * into v_series from public.task_series where id = p_series_id;
  if v_series.id is null then return; end if;

  select coalesce(max(t.series_occurrence), 0) into v_last
  from public.tasks t where t.series_id = p_series_id;

  select max((t.due_at at time zone v_series.timezone)::date) into v_after
  from public.tasks t where t.series_id = p_series_id;

  if v_after is null then
    -- Sin ocurrencias: se arranca en la fecha de inicio (o hoy, si ya pasó).
    v_next := public.series_next_date(p_series_id, null);
  else
    v_next := public.series_next_date(p_series_id, v_after);
  end if;

  update public.task_series
     set last_occurrence = v_last,
         next_occurrence = v_next,
         updated_at = now()
   where id = p_series_id;
end;
$$;

comment on function public.series_sync_pointer(uuid) is
  'Recalcula next_occurrence/last_occurrence desde las ocurrencias vivas (tras editar o borrar).';

-- Guardas de escritura de la serie: el cliente cambia plantilla, recurrencia y
-- rotación; los punteros (`next_occurrence`, `last_occurrence`) los pone la base.
create or replace function public.task_series_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role'
     or pg_trigger_depth() > 1
     or coalesce(current_setting('loki.series_write', true), '') = 'on'
  then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.project_id is distinct from old.project_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.last_occurrence is distinct from old.last_occurrence
     or new.next_occurrence is distinct from old.next_occurrence
  then
    raise exception
      'En una serie solo se pueden modificar la plantilla, la recurrencia y la rotación'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists task_series_guard_update on public.task_series;
create trigger task_series_guard_update
  before update on public.task_series
  for each row execute function public.task_series_guard_update();

-- Límite por espacio (visible para el usuario en la UI): sin tope, un espacio
-- podría llenar la base de tareas.
create or replace function public.series_space_limit()
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select 50;
$$;

create or replace function public.task_series_limit_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active integer;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  select count(*) into v_active
  from public.task_series
  where workspace_id = new.workspace_id and active;
  if v_active >= public.series_space_limit() then
    raise exception
      'Este espacio llegó a su límite de series activas. Pausa o borra alguna para crear otra.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists task_series_limit_guard on public.task_series;
create trigger task_series_limit_guard
  before insert on public.task_series
  for each row execute function public.task_series_limit_guard();

-- Uso del espacio para la UI (límite visible para el usuario).
create or replace function public.series_usage(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_member(p_workspace_id) then
    raise exception 'No perteneces a ese espacio' using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object(
    'active', (
      select count(*) from public.task_series
      where workspace_id = p_workspace_id and active
    ),
    'limit', public.series_space_limit()
  );
end;
$$;

-- Nueva serie: se arma la primera ocurrencia en el momento (el evento es el
-- insert; nada esperando ni consultando).
create or replace function public.task_series_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.task_series
     set next_occurrence = public.series_next_date(new.id, null)
   where id = new.id and next_occurrence is null;
  perform public.materialize_series_occurrences(new.id);
  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists task_series_after_insert on public.task_series;
create trigger task_series_after_insert
  after insert on public.task_series
  for each row execute function public.task_series_after_insert();

-- Tarea completada: la serie genera la que sigue (el otro gatillo es el
-- barrido, para el caso de que nadie complete nada).
create or replace function public.tasks_after_series_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.series_id is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    return null;
  end if;
  if old.status is distinct from 'done' and new.status = 'done' then
    perform public.materialize_series_occurrences(new.series_id);
  end if;
  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists tasks_after_series_update on public.tasks;
create trigger tasks_after_series_update
  after update on public.tasks
  for each row execute function public.tasks_after_series_update();

-- -----------------------------------------------------------------------------
-- 6c. Recordatorios genéricos: las ocurrencias de una serie no avisan dos veces
--
-- `create_due_reminders()` (organizador) avisaba "Tarea por vencer" a cualquier
-- tarea; con las series, ese aviso se solaparía con el de turno ("Mañana te
-- toca", tipo `shift`). Se define de nuevo igual, pero saltándose las tareas que
-- son ocurrencias de una serie: de esas se encarga `create_shift_reminders`.
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
  -- Tareas que vencen en 24 h (una por responsable; sin responsables, al
  -- creador). Las ocurrencias de series van por su propio camino (`shift`).
  for v_task in
    select id, project_id, workspace_id, title, due_at, assignee_ids, created_by
    from public.tasks
    where status <> 'done'
      and series_id is null
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
      and series_id is null
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
  'Job de recordatorios (texto fijo en español, idempotente por dedupe). Las ocurrencias de series avisan por `shift`.';

-- -----------------------------------------------------------------------------
-- 7. Notificaciones: la asignación de una ocurrencia NO es "te asignaron una
--    tarea" (eso duplicaría el aviso de turno). Redefinición de la función del
--    organizador con la bandera `loki.series_write` (mismo patrón que las
--    encuestas con `loki.poll_write`).
-- -----------------------------------------------------------------------------
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
  -- Ocurrencia de una serie: avisa `create_shift_reminders` ("te toca"), no esto.
  if coalesce(current_setting('loki.series_write', true), '') = 'on' then
    return null;
  end if;

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

-- -----------------------------------------------------------------------------
-- 7b. Turnos: intercambiar, saltar (vacaciones) y reordenar
-- -----------------------------------------------------------------------------

-- "¿Me cambias el turno?" Solo lo piden y resuelven los dos de involvedrados:
-- el INSERT exige ser quien pide y que el otro esté en la rotación.
create or replace function public.request_shift_swap(
  p_task_id uuid,
  p_to_user_id uuid,
  p_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.tasks%rowtype;
  v_series public.task_series%rowtype;
  v_uid uuid := auth.uid();
  v_swap uuid;
  v_from_name text;
begin
  if v_uid is null then
    raise exception 'Hay que iniciar sesión' using errcode = 'insufficient_privilege';
  end if;
  if p_to_user_id is null or p_to_user_id = v_uid then
    raise exception 'Elige a otra persona de la rotación'
      using errcode = 'check_violation';
  end if;

  select * into v_task from public.tasks where id = p_task_id;
  if v_task.id is null or v_task.series_id is null then
    raise exception 'Ese turno ya no existe' using errcode = 'check_violation';
  end if;
  select * into v_series from public.task_series where id = v_task.series_id;
  if not public.is_member(v_series.workspace_id) then
    raise exception 'No perteneces a ese espacio' using errcode = 'insufficient_privilege';
  end if;
  if v_task.status = 'done' then
    raise exception 'Ese turno ya está hecho' using errcode = 'check_violation';
  end if;
  if p_to_user_id <> all (coalesce(v_series.rotation, '{}'::uuid[])) then
    raise exception 'Esa persona no está en la rotación'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.shift_swaps
    where task_id = p_task_id and from_user_id = v_uid and status = 'pending'
  ) then
    raise exception 'Ya pediste ese cambio. Espera la respuesta.'
      using errcode = 'check_violation';
  end if;

  insert into public.shift_swaps (series_id, task_id, workspace_id, from_user_id, to_user_id, note)
  values (v_series.id, v_task.id, v_series.workspace_id, v_uid, p_to_user_id, left(coalesce(p_note, ''), 200))
  returning id into v_swap;

  select coalesce(nullif(btrim(display_name), ''), 'Alguien') into v_from_name
  from public.workspace_members
  where workspace_id = v_series.workspace_id and user_id = v_uid;

  insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
  values (
    p_to_user_id,
    v_series.workspace_id,
    'shift',
    '¿Me cambias el turno?',
    v_from_name || ' te pregunta por «' || left(v_series.title, 60) || '».',
    '/proyectos?project=' || v_task.project_id || '&task=' || v_task.id,
    'swap:' || v_swap
  )
  on conflict (user_id, dedupe) where dedupe is not null do nothing;

  return v_swap;
end;
$$;

comment on function public.request_shift_swap(uuid, uuid, text) is
  'Pide cambiar un turno ("¿me cambias el turno?") al siguiente de la rotación.';

-- Aceptar = este turno pasa al otro y la rotación avanza un puesto (quien
-- venía después se queda con el siguiente). Rechazar solo cierra la petición.
create or replace function public.resolve_shift_swap(p_swap_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_swap public.shift_swaps%rowtype;
  v_series public.task_series%rowtype;
  v_uid uuid := auth.uid();
  v_name text;
begin
  -- El cambio de responsable avisa con el tipo `shift`, no como tarea asignada.
  perform set_config('loki.series_write', 'on', true);

  select * into v_swap from public.shift_swaps where id = p_swap_id;
  if v_swap.id is null then
    raise exception 'Ese intercambio ya no existe' using errcode = 'check_violation';
  end if;
  if v_swap.from_user_id <> v_uid and v_swap.to_user_id <> v_uid then
    raise exception 'Solo los dos del intercambio pueden resolverlo'
      using errcode = 'insufficient_privilege';
  end if;
  if v_swap.status <> 'pending' then
    raise exception 'Ese intercambio ya se resolvió'
      using errcode = 'check_violation';
  end if;

  if not p_accept then
    update public.shift_swaps
       set status = 'declined', resolved_at = now(), resolved_by = v_uid
     where id = v_swap.id;

    select coalesce(nullif(btrim(display_name), ''), 'Alguien') into v_name
    from public.workspace_members
    where workspace_id = v_swap.workspace_id and user_id = v_uid;

    insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
    values (
      v_swap.from_user_id,
      v_swap.workspace_id,
      'shift',
      'Turno sin cambio',
      v_name || ' no puede con ese turno esta vez.',
      '/proyectos?tab=turnos',
      'swap-resolved:' || v_swap.id
    )
    on conflict (user_id, dedupe) where dedupe is not null do nothing;

    return jsonb_build_object('status', 'declined');
  end if;

  update public.shift_swaps
     set status = 'accepted', resolved_at = now(), resolved_by = v_uid
   where id = v_swap.id;

  select * into v_series from public.task_series where id = v_swap.series_id for update;

  update public.tasks
     set assignee_ids = array[v_swap.to_user_id]
   where id = v_swap.task_id;

  update public.task_series
     set rotation_index = case
           when coalesce(array_length(rotation, 1), 0) > 0
             then (rotation_index + 1) % coalesce(array_length(rotation, 1), 1)
           else rotation_index
         end,
         updated_at = now()
   where id = v_swap.series_id;

  select coalesce(nullif(btrim(display_name), ''), 'Alguien') into v_name
  from public.workspace_members
  where workspace_id = v_swap.workspace_id and user_id = v_uid;

  insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
  values (
    v_swap.from_user_id,
    v_swap.workspace_id,
    'shift',
    'Turno cambiado',
    v_name || ' tomó «' || left(v_series.title, 60) || '» y la rotación avanza un puesto.',
    '/proyectos?tab=turnos',
    'swap-resolved:' || v_swap.id
  )
  on conflict (user_id, dedupe) where dedupe is not null do nothing;

  return jsonb_build_object('status', 'accepted');
end;
$$;

-- Vacaciones o lo que sea: ese miembro no sale en ese rango. Las ocurrencias
-- ya creadas en el rango y abiertas se le pasan al siguiente de la rotación.
create or replace function public.skip_shift(
  p_series_id uuid,
  p_user_id uuid,
  p_from date,
  p_to date default null,
  p_reason text default ''
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series public.task_series%rowtype;
  v_uid uuid := auth.uid();
  v_to date := coalesce(p_to, p_from);
  v_skips jsonb;
  v_task record;
  v_pick record;
  v_moved integer := 0;
begin
  select * into v_series from public.task_series where id = p_series_id for update;
  if v_series.id is null then
    raise exception 'Esa serie ya no existe' using errcode = 'check_violation';
  end if;
  if v_uid is not null then
    if v_series.created_by is distinct from v_uid
       and not public.is_space_admin(v_series.workspace_id)
    then
      raise exception 'Solo quien creó la serie o un admin puede cambiar la rotación'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if p_user_id is null or p_from is null then
    raise exception 'Dime a quién y desde cuándo' using errcode = 'check_violation';
  end if;
  if v_to < p_from then
    v_to := p_from;
  end if;

  perform set_config('loki.series_write', 'on', true);

  v_skips := v_series.rotation_skips
    || jsonb_build_array(
         jsonb_build_object(
           'user_id', p_user_id::text,
           'from', p_from::text,
           'to', v_to::text,
           'reason', left(coalesce(p_reason, ''), 120)
         )
       );

  update public.task_series set rotation_skips = v_skips, updated_at = now()
   where id = v_series.id;

  -- Ocurrencias abiertas del rango que tenía asignadas: al siguiente.
  for v_task in
    select t.id, t.due_at
    from public.tasks t
    where t.series_id = v_series.id
      and t.status <> 'done'
      and p_user_id = any (coalesce(t.assignee_ids, '{}'))
      and (t.due_at at time zone v_series.timezone)::date between p_from and v_to
  loop
    select p.user_id, p.next_index into v_pick
    from public.series_pick_rotation(
           v_series.rotation, v_series.rotation_index, v_skips,
           v_series.workspace_id, (v_task.due_at at time zone v_series.timezone)::date
         ) as p(user_id, next_index);
    continue when v_pick.user_id is null;

    update public.tasks
       set assignee_ids = array[v_pick.user_id]
     where id = v_task.id;

    insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
    values (
      v_pick.user_id,
      v_series.workspace_id,
      'shift',
      'Te tocaría un turno',
      '«' || left(v_series.title, 60) || '» te toca y quien lo tenía se ausenta.',
      '/proyectos?project=' || v_task.project_id || '&task=' || v_task.id,
      'skip:' || v_task.id
    )
    on conflict (user_id, dedupe) where dedupe is not null do nothing;

    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end;
$$;

comment on function public.skip_shift(uuid, uuid, date, date, text) is
  'Deja a un miembro fuera de la rotación en un rango de fechas (vacaciones) y pasa sus turnos abiertos al siguiente.';

-- Reordenar el padrón de turnos (mismo conjunto de personas, otro orden).
create or replace function public.reorder_rotation(p_series_id uuid, p_order uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series public.task_series%rowtype;
  v_uid uuid := auth.uid();
  v_n integer;
begin
  select * into v_series from public.task_series where id = p_series_id for update;
  if v_series.id is null then
    raise exception 'Esa serie ya no existe' using errcode = 'check_violation';
  end if;
  if v_uid is not null then
    if v_series.created_by is distinct from v_uid
       and not public.is_space_admin(v_series.workspace_id)
    then
      raise exception 'Solo quien creó la serie o un admin puede cambiar la rotación'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  v_n := coalesce(array_length(p_order, 1), 0);
  if v_n <> coalesce(array_length(v_series.rotation, 1), 0) then
    raise exception 'La rotación debe tener las mismas personas, solo en otro orden'
      using errcode = 'check_violation';
  end if;
  if v_n > 0 then
    if exists (
      select 1 from unnest(p_order) as u(uid)
      where not exists (
        select 1 from unnest(v_series.rotation) as r(uid) where r.uid = u.uid
      )
    ) then
      raise exception 'La rotación debe tener las mismas personas, solo en otro orden'
        using errcode = 'check_violation';
    end if;
  end if;

  update public.task_series
     set rotation = coalesce(p_order, '{}'::uuid[]), rotation_index = 0, updated_at = now()
   where id = v_series.id;

  return coalesce(p_order, '{}'::uuid[]);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Editar y borrar por alcance ("solo esta" / "esta y las siguientes")
-- -----------------------------------------------------------------------------

-- p_scope: 'this' (solo la ocurrencia indicada), 'following' (esta y las
-- siguientes) o 'all' (la serie entera, desde cero).
create or replace function public.edit_task_series(
  p_series_id uuid,
  p_task_id uuid default null,
  p_scope text default 'all',
  p_patch jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series public.task_series%rowtype;
  v_task public.tasks%rowtype;
  v_uid uuid := auth.uid();
  v_from integer := 1;
  v_changed integer := 0;
begin
  select * into v_series from public.task_series where id = p_series_id for update;
  if v_series.id is null then
    raise exception 'Esa serie ya no existe' using errcode = 'check_violation';
  end if;
  if v_uid is not null then
    if v_series.created_by is distinct from v_uid
       and not public.is_space_admin(v_series.workspace_id)
    then
      raise exception 'Solo quien creó la serie o un admin puede editarla'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if p_scope not in ('this', 'following', 'all') then
    raise exception 'Alcance desconocido' using errcode = 'check_violation';
  end if;
  if p_scope = 'this' and p_task_id is null then
    raise exception 'Falta la ocurrencia a editar' using errcode = 'check_violation';
  end if;

  perform set_config('loki.series_write', 'on', true);

  if p_scope = 'this' then
    -- La ocurrencia se independiza: deja de repetirse y no la toca la serie.
    select * into v_task from public.tasks where id = p_task_id for update;
    if v_task.series_id is distinct from v_series.id then
      raise exception 'Esa tarea no es de esta serie' using errcode = 'check_violation';
    end if;
    if v_uid is not null and v_task.created_by is distinct from v_uid
       and not public.is_space_admin(v_series.workspace_id)
    then
      raise exception 'Esa ocurrencia no es tuya' using errcode = 'insufficient_privilege';
    end if;
    update public.tasks
       set series_id = null, series_occurrence = null
     where id = v_task.id;
    return 1;
  end if;

  -- Desde dónde se rehace: "following" arranca en la ocurrencia indicada (o,
  -- si no viene ninguna, en la siguiente a la última). Lo que ya se hizo se
  -- conserva; "all" rehace la serie desde cero.
  v_from := 1;
  if p_scope = 'following' then
    if p_task_id is not null then
      select series_occurrence into v_from from public.tasks where id = p_task_id;
    end if;
    if v_from is null or v_from <= 0 then
      v_from := v_series.last_occurrence + 1;
    end if;
    delete from public.tasks
    where series_id = v_series.id
      and series_occurrence >= v_from;
  else
    delete from public.tasks where series_id = v_series.id;
  end if;

  update public.task_series
     set title = case when p_patch ? 'title' then left(btrim(p_patch ->> 'title'), 200) else title end,
         notes = case when p_patch ? 'notes' then left(coalesce(p_patch ->> 'notes', ''), 2000) else notes end,
         priority = case
           when p_patch ? 'priority' and (p_patch ->> 'priority') in ('low', 'normal', 'high')
             then p_patch ->> 'priority'
           else priority
         end,
         recurrence_kind = case
           when p_patch ? 'recurrence_kind' and (p_patch ->> 'recurrence_kind') in ('daily', 'weekly', 'monthly', 'interval')
             then p_patch ->> 'recurrence_kind'
           else recurrence_kind
         end,
         recurrence_interval = case
           when p_patch ? 'recurrence_interval' and (p_patch ->> 'recurrence_interval') ~ '^\d{1,3}$'
             then greatest(1, least(60, (p_patch ->> 'recurrence_interval')::int))
           else recurrence_interval
         end,
         recurrence_unit = case
           when p_patch ? 'recurrence_unit' and (p_patch ->> 'recurrence_unit') in ('days', 'weeks')
             then p_patch ->> 'recurrence_unit'
           else recurrence_unit
         end,
         weekdays = case
           when jsonb_typeof(p_patch -> 'weekdays') = 'array' then
             (
               select coalesce(array_agg(d.w::smallint), '{}'::smallint[])
               from (
                 select (jsonb_array_elements_text(p_patch -> 'weekdays'))::int as w
               ) as d
               where d.w between 0 and 6
             )
           else weekdays
         end,
         month_day = case
           when p_patch ? 'month_day' and (p_patch ->> 'month_day') ~ '^[0-9]{1,2}$'
             then (p_patch ->> 'month_day')::smallint
           when p_patch ? 'month_day' then null
           else month_day
         end,
         month_week = case
           when p_patch ? 'month_week' and (p_patch ->> 'month_week') ~ '^[0-9]{1,2}$'
             then (p_patch ->> 'month_week')::smallint
           when p_patch ? 'month_week' then null
           else month_week
         end,
         month_weekday = case
           when p_patch ? 'month_weekday' and (p_patch ->> 'month_weekday') ~ '^[0-9]{1,2}$'
             then (p_patch ->> 'month_weekday')::smallint
           when p_patch ? 'month_weekday' then null
           else month_weekday
         end,
         start_date = case
           when p_patch ? 'start_date' and (p_patch ->> 'start_date') ~ '^\d{4}-\d{2}-\d{2}$'
             then (p_patch ->> 'start_date')::date
           else start_date
         end,
         time_of_day = case
           when p_patch ? 'timeOfDay' and (p_patch ->> 'timeOfDay') ~ '^\d{2}:\d{2}'
             then (p_patch ->> 'timeOfDay')::time
           else time_of_day
         end,
         remind_time = case
           when p_patch ? 'remindTime' and (p_patch ->> 'remindTime') ~ '^\d{2}:\d{2}'
             then (p_patch ->> 'remindTime')::time
           else remind_time
         end,
         timezone = case
           when p_patch ? 'timezone' and btrim(coalesce(p_patch ->> 'timezone', '')) <> ''
             then btrim(p_patch ->> 'timezone')
           else timezone
         end,
         ends_on = case
           when p_patch ? 'endsOn' and (p_patch ->> 'endsOn') ~ '^\d{4}-\d{2}-\d{2}$'
             then (p_patch ->> 'endsOn')::date
           when p_patch ? 'endsOn' then null
           else ends_on
         end,
         pauses = case
           when jsonb_typeof(p_patch -> 'pauses') = 'array' then p_patch -> 'pauses'
           else pauses
         end,
         rotation = case
           when jsonb_typeof(p_patch -> 'rotation') = 'array' then
             (
               select coalesce(array_agg(d.u::uuid), '{}'::uuid[])
               from (
                 select jsonb_array_elements_text(p_patch -> 'rotation') as u
               ) as d
               where d.u ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             )
           else rotation
         end,
         active = case when p_patch ? 'active' then coalesce((p_patch ->> 'active')::boolean, active) else active end,
         updated_at = now()
   where id = v_series.id;

  -- El puntero lo recalcula la base desde las ocurrencias que quedaron.
  perform public.series_sync_pointer(v_series.id);
  v_changed := public.materialize_series_occurrences(v_series.id);
  return v_changed;
end;
$$;

comment on function public.edit_task_series(uuid, uuid, text, jsonb) is
  'Edita una serie por alcance: "this" (solo esta ocurrencia, la independiza), "following" o "all". Devuelve cuántas ocurrencias rehizo.';

-- Borrar por alcance, como en un calendario.
create or replace function public.delete_task_series(
  p_series_id uuid,
  p_task_id uuid default null,
  p_scope text default 'all'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series public.task_series%rowtype;
  v_task public.tasks%rowtype;
  v_uid uuid := auth.uid();
  v_from integer := 1;
begin
  select * into v_series from public.task_series where id = p_series_id for update;
  if v_series.id is null then
    return 0;
  end if;
  if v_uid is not null then
    if v_series.created_by is distinct from v_uid
       and not public.is_space_admin(v_series.workspace_id)
    then
      raise exception 'Solo quien creó la serie o un admin puede borrarla'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if p_scope not in ('this', 'following', 'all') then
    raise exception 'Alcance desconocido' using errcode = 'check_violation';
  end if;

  perform set_config('loki.series_write', 'on', true);

  if p_scope = 'this' then
    if p_task_id is null then
      raise exception 'Falta la ocurrencia a borrar' using errcode = 'check_violation';
    end if;
    select * into v_task from public.tasks where id = p_task_id for update;
    if v_task.series_id is distinct from v_series.id then
      raise exception 'Esa tarea no es de esta serie' using errcode = 'check_violation';
    end if;
    if v_uid is not null and v_task.created_by is distinct from v_uid
       and not public.is_space_admin(v_series.workspace_id)
    then
      raise exception 'Esa ocurrencia no es tuya' using errcode = 'insufficient_privilege';
    end if;
    delete from public.tasks where id = v_task.id;
    return 1;
  end if;

  if p_scope = 'all' then
    -- La serie se lleva sus ocurrencias (ON DELETE CASCADE).
    delete from public.task_series where id = v_series.id;
    return 1;
  end if;

  v_from := 1;
  if p_task_id is not null then
    select series_occurrence into v_from from public.tasks where id = p_task_id;
  end if;
  if v_from is null or v_from <= 0 then
    v_from := v_series.last_occurrence + 1;
  end if;

  -- "Esta y las siguientes": lo que ya pasó se independiza (queda como tarea
  -- normal, con su historial) y la serie se va con el resto.
  update public.tasks
     set series_id = null, series_occurrence = null
   where series_id = v_series.id
     and series_occurrence < v_from;

  delete from public.task_series where id = v_series.id;
  return 1;
end;
$$;

comment on function public.delete_task_series(uuid, uuid, text) is
  'Borra por alcance: "this" (solo la ocurrencia), "following" (deja las anteriores como tareas normales) o "all".';

-- -----------------------------------------------------------------------------
-- 9. Recordatorios de turno (pg_cron, SQL barato, idempotentes por dedupe)
--
--   · día anterior a la hora configurada → "mañana te toca"
--   · el mismo día a la hora configurada → "te toca hoy"
--   · al día siguiente si sigue sin hacer → "se te pasó"
-- La hora y el "día" se calculan con la zona de la serie (`AT TIME ZONE`), así
-- que el horario de verano de Chile no corre los avisos. Del push se encarga
-- `push-send`, que respeta `notification_prefs.shift` y el horario de silencio.
-- -----------------------------------------------------------------------------
create or replace function public.create_shift_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task record;
  v_uid uuid;
  v_now timestamp;
  v_today date;
  v_due date;
  v_kind text;
  v_title text;
  v_body text;
  v_dedupe text;
  v_link text;
  v_created integer := 0;
begin
  for v_task in
    select t.id, t.workspace_id, t.project_id, t.title, t.due_at,
           t.assignee_ids, s.title as series_title, s.remind_time,
           s.timezone, s.created_by
      from public.tasks t
      join public.task_series s on s.id = t.series_id
     where t.status <> 'done'
       and s.active
       and t.due_at is not null
       and t.due_at <= now() + interval '2 days'
  loop
    v_uid := null;
    if coalesce(array_length(v_task.assignee_ids, 1), 0) > 0 then
      v_uid := v_task.assignee_ids[1];
    end if;
    if v_uid is null then
      v_uid := v_task.created_by;
    end if;
    continue when v_uid is null;

    v_now := public.series_local_clock(v_task.timezone);
    v_today := v_now::date;
    v_due := (v_task.due_at at time zone v_task.timezone)::date;
    v_link := '/proyectos?project=' || v_task.project_id || '&task=' || v_task.id;

    if v_due = v_today + 1 and v_now >= ((v_due - 1)::timestamp + v_task.remind_time) then
      v_kind := 'shift-eve';
      v_title := 'Mañana te toca';
      v_body := '«' || left(v_task.title, 80) || '». ¿Te sirve o lo cambias?';
    elsif v_due = v_today and v_now >= (v_due::timestamp + v_task.remind_time) then
      v_kind := 'shift-day';
      v_title := 'Te toca hoy';
      v_body := '«' || left(v_task.title, 80) || '».';
    elsif v_due = v_today - 1 then
      v_kind := 'shift-late';
      v_title := 'Se te pasó tu turno';
      v_body := '«' || left(v_task.title, 80) || '» quedó sin hacer ayer.';
    else
      continue;
    end if;

    v_dedupe := v_kind || ':' || v_task.id;
    begin
      insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
      values (v_uid, v_task.workspace_id, 'shift', v_title, v_body, v_link, v_dedupe)
      on conflict (user_id, dedupe) where dedupe is not null do nothing;
      if found then v_created := v_created + 1; end if;
    exception when others then
      null;
    end;
  end loop;

  return v_created;
exception when others then
  return v_created;
end;
$$;

comment on function public.create_shift_reminders() is
  'Avisos de turno (día antes, el día y "se te pasó"). Idempotentes por dedupe; el push lo manda push-send.';

-- -----------------------------------------------------------------------------
-- 10. Quien sale del espacio sale de la rotación (y se avisa al creador)
-- -----------------------------------------------------------------------------
create or replace function public.series_on_member_leave()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series record;
  v_name text;
begin
  for v_series in
    select id, workspace_id, title, rotation, rotation_index, created_by
      from public.task_series
     where workspace_id = old.workspace_id
       and old.user_id = any (coalesce(rotation, '{}'))
  loop
    update public.task_series
       set rotation = (
             select coalesce(array_agg(u), '{}'::uuid[])
             from unnest(v_series.rotation) as u
             where u <> old.user_id
           ),
           rotation_index = 0,
           updated_at = now()
     where id = v_series.id;

    if v_series.created_by is not null and v_series.created_by <> old.user_id then
      select coalesce(nullif(btrim(display_name), ''), 'Alguien') into v_name
      from public.profiles where id = old.user_id;
      begin
        insert into public.notifications (user_id, workspace_id, type, title, body, link, dedupe)
        values (
          v_series.created_by,
          v_series.workspace_id,
          'shift',
          'Turnos actualizados',
          coalesce(v_name, 'Alguien')
            || ' salió del espacio y ya no está en la rotación de «'
            || left(v_series.title, 60) || '».',
          '/proyectos?tab=turnos',
          'leave:' || v_series.id || ':' || old.user_id || ':' || left(coalesce(old.joined_at::text, ''), 24)
        )
        on conflict (user_id, dedupe) where dedupe is not null do nothing;
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

drop trigger if exists series_on_member_leave on public.workspace_members;
create trigger series_on_member_leave
  after delete on public.workspace_members
  for each row execute function public.series_on_member_leave();

-- -----------------------------------------------------------------------------
-- 11. Barrido: pg_cron cada 15 min (generación + recordatorios)
-- -----------------------------------------------------------------------------
do $seriescron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin barrido de series: %', sqlerrm;
    return;
  end;
  begin
    perform cron.unschedule('loki-series-15min');
    perform cron.unschedule('loki-shifts-15min');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule(
      'loki-series-15min',
      '*/15 * * * *',
      'select public.materialize_series_occurrences()'
    );
  exception when others then
    raise notice 'no se pudo programar el barrido de series: %', sqlerrm;
  end;
  begin
    perform cron.schedule(
      'loki-shifts-15min',
      '*/15 * * * *',
      'select public.create_shift_reminders()'
    );
  exception when others then
    raise notice 'no se pudieron programar los avisos de turno: %', sqlerrm;
  end;
end
$seriescron$;

-- -----------------------------------------------------------------------------
-- 12. Resumen diario: p11 dejó el conteo de turnos en 0 "hasta que lleguen las
--     tablas". Se define de nuevo con los turnos reales (misma función, mismo
--     nombre y pg_cron: `loki-daily-digest-15min` sigue llamándola).
-- -----------------------------------------------------------------------------
create or replace function public.create_daily_digests()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created integer := 0;
  v_user record;
  v_tz text;
  v_local timestamp;
  v_today date;
  v_pref_min integer;
  v_local_min integer;
  v_dow integer;
  v_dedupe text;
  v_scopes uuid[];
  v_events integer := 0;
  v_first_title text := '';
  v_first_hhmm text := '';
  v_due_today integer := 0;
  v_overdue integer := 0;
  v_lists integer := 0;
  v_polls integer := 0;
  v_shifts integer := 0;
  v_has_lists boolean;
  v_has_polls boolean;
  v_parts text[] := '{}';
  v_body text;
  v_qstart integer;
  v_qend integer;
  v_now_min integer;
begin
  v_has_lists := to_regclass('public.lists') is not null
    and to_regclass('public.list_items') is not null;
  v_has_polls := to_regclass('public.polls') is not null
    and to_regclass('public.poll_votes') is not null;

  -- Un resumen por miembro (miembros duplicados entre espacios colapsan).
  -- Sin fila en prefs: default (activado, 08:00, America/Santiago, todos los
  -- días, todos los espacios, sin aviso en vacío).
  for v_user in
    select distinct
      m.user_id as user_id,
      coalesce(d.enabled, true) as enabled,
      coalesce(d.digest_time, time '08:00') as digest_time,
      coalesce(nullif(btrim(d.timezone), ''), 'America/Santiago') as timezone,
      coalesce(d.days, 'all') as days,
      coalesce(d.workspace_ids, '{}') as workspace_ids,
      coalesce(d.send_when_empty, false) as send_when_empty,
      coalesce(np.daily, true) as daily_on,
      np.quiet_start as quiet_start,
      np.quiet_end as quiet_end
    from public.workspace_members m
    left join public.daily_digest_prefs d on d.user_id = m.user_id
    left join public.notification_prefs np on np.user_id = m.user_id
  loop
    if v_user.user_id is null then continue; end if;
    if not v_user.enabled or not v_user.daily_on then continue; end if;

    -- Zona horaria del usuario (si es inválida, se salta sin romper el job:
    -- `continue` no puede saltar desde un bloque con manejador de excepción).
    v_tz := v_user.timezone;
    v_local := now() at time zone 'America/Santiago';
    begin
      v_local := now() at time zone v_tz;
    exception when others then
      v_local := null;
    end;
    if v_local is null then continue; end if;
    v_today := v_local::date;
    v_dedupe := 'daily:' || to_char(v_today, 'YYYYMMDD');

    -- Ventana: la hora preferida cayó en los últimos 15 min (hora local).
    v_pref_min := extract(hour from v_user.digest_time)::int * 60
      + extract(minute from v_user.digest_time)::int;
    v_local_min := extract(hour from v_local)::int * 60
      + extract(minute from v_local)::int;
    if v_local_min < v_pref_min or v_local_min >= v_pref_min + 15 then
      continue;
    end if;

    -- Solo hábiles: se salta sábado (6) y domingo (0).
    if v_user.days = 'weekdays' then
      v_dow := extract(dow from v_local)::int;
      if v_dow = 0 or v_dow = 6 then continue; end if;
    end if;

    -- Horario de silencio en hora local: ese día no sale push.
    if v_user.quiet_start is not null and v_user.quiet_end is not null then
      v_qstart := extract(hour from v_user.quiet_start)::int * 60
        + extract(minute from v_user.quiet_start)::int;
      v_qend := extract(hour from v_user.quiet_end)::int * 60
        + extract(minute from v_user.quiet_end)::int;
      if v_qstart <> v_qend then
        v_now_min := v_local_min;
        if (v_qstart < v_qend and v_now_min >= v_qstart and v_now_min < v_qend)
          or (v_qstart > v_qend and (v_now_min >= v_qstart or v_now_min < v_qend))
        then
          continue;
        end if;
      end if;
    end if;

    -- Idempotente por usuario y día local.
    if exists (
      select 1 from public.notifications n
      where n.user_id = v_user.user_id and n.dedupe = v_dedupe
    ) then
      continue;
    end if;

    -- Espacios incluidos (NULL/vacío = todos los del usuario).
    if coalesce(array_length(v_user.workspace_ids, 1), 0) = 0 then
      select array_agg(m2.workspace_id) into v_scopes
      from public.workspace_members m2 where m2.user_id = v_user.user_id;
    else
      select array_agg(m2.workspace_id) into v_scopes
      from public.workspace_members m2
      where m2.user_id = v_user.user_id
        and m2.workspace_id = any (v_user.workspace_ids);
    end if;
    if v_scopes is null or coalesce(array_length(v_scopes, 1), 0) = 0 then
      continue;
    end if;

    -- Eventos de hoy (día local del usuario) en sus espacios.
    select count(*),
      coalesce(max(case when ranked.rn = 1 then ranked.title else '' end), ''),
      coalesce(max(case when ranked.rn = 1 then ranked.hhmm else '' end), '')
    into v_events, v_first_title, v_first_hhmm
    from (
      select e.title as title,
        to_char(e.starts_at at time zone v_tz, 'HH24:MI') as hhmm,
        row_number() over (order by e.starts_at asc) as rn
      from public.events e
      where e.workspace_id = any (v_scopes)
        and (e.starts_at at time zone v_tz)::date = v_today
    ) ranked;
    v_events := coalesce(v_events, 0);

    -- Tareas: vencen hoy o atrasadas (asignadas a mí o creadas por mí).
    select
      count(*) filter (where (t.due_at at time zone v_tz)::date = v_today),
      count(*) filter (where (t.due_at at time zone v_tz)::date < v_today)
    into v_due_today, v_overdue
    from public.tasks t
    where t.workspace_id = any (v_scopes)
      and t.status <> 'done'
      and t.due_at is not null
      and (t.due_at at time zone v_tz)::date <= v_today
      and (v_user.user_id = any (coalesce(t.assignee_ids, '{}'))
        or t.created_by is not distinct from v_user.user_id);
    v_due_today := coalesce(v_due_today, 0);
    v_overdue := coalesce(v_overdue, 0);

    -- Listas fijadas con pendientes.
    v_lists := 0;
    if v_has_lists then
      begin
        select count(*) into v_lists
        from public.lists l
        where l.workspace_id = any (v_scopes)
          and l.pinned and not l.archived
          and exists (
            select 1 from public.list_items li
            where li.list_id = l.id and li.checked = false
          );
      exception when others then
        v_lists := 0;
      end;
    end if;

    -- Encuestas abiertas sin mi voto (elector del chat y sin votar).
    v_polls := 0;
    if v_has_polls then
      begin
        select count(*) into v_polls
        from public.polls p
        where p.workspace_id = any (v_scopes)
          and p.closed_at is null
          and (p.closes_at is null or p.closes_at > now())
          and v_user.user_id in (
            select public.poll_electors(p.workspace_id, p.chat_id)
          )
          and not exists (
            select 1 from public.poll_votes v
            where v.poll_id = p.id and v.user_id = v_user.user_id
          );
      exception when others then
        v_polls := 0;
      end;
    end if;

    -- Turnos y tareas recurrentes que me tocan HOY: soy el responsable del
    -- turno, o soy quien creó la serie y esa ocurrencia sigue sin hacer.
    v_shifts := 0;
    begin
      select count(*) into v_shifts
      from public.tasks t
      where t.workspace_id = any (v_scopes)
        and t.series_id is not null
        and t.status <> 'done'
        and t.due_at is not null
        and (t.due_at at time zone v_tz)::date = v_today
        and (
          v_user.user_id = any (coalesce(t.assignee_ids, '{}'))
          or exists (
            select 1 from public.task_series s
             where s.id = t.series_id
               and s.created_by is not distinct from v_user.user_id
          )
        );
    exception when others then
      v_shifts := 0;
    end;

    -- Sin nada: solo sale si el usuario pidió el texto breve.
    if v_events = 0 and v_due_today = 0 and v_overdue = 0
      and v_lists = 0 and v_polls = 0 and v_shifts = 0
    then
      if not v_user.send_when_empty then continue; end if;
      begin
        insert into public.notifications
          (user_id, workspace_id, type, title, body, link, dedupe)
        values (
          v_user.user_id, null, 'daily', 'Tu día',
          'Sin nada pendiente hoy. Buen día para adelantar algo.',
          '/inicio?vista=dia', v_dedupe
        )
        on conflict (user_id, dedupe) where dedupe is not null do nothing;
        if found then v_created := v_created + 1; end if;
      exception when others then null; end;
      continue;
    end if;

    -- Texto concreto y corto (push expandida: se lee entero).
    v_parts := '{}';
    if v_events > 0 then
      if v_first_title <> '' then
        v_parts := v_parts || (
          v_events::text || case when v_events = 1 then ' evento' else ' eventos' end
          || ' (' || v_first_hhmm || ' ' || left(v_first_title, 30) || ')'
        );
      else
        v_parts := v_parts || (
          v_events::text || case when v_events = 1 then ' evento' else ' eventos' end
        );
      end if;
    end if;
    if v_due_today > 0 then
      v_parts := v_parts || (
        'vencen ' || v_due_today::text
        || case when v_due_today = 1 then ' tarea' else ' tareas' end
      );
    end if;
    if v_overdue > 0 then
      v_parts := v_parts || (
        v_overdue::text
        || case when v_overdue = 1 then ' atrasada' else ' atrasadas' end
      );
    end if;
    if v_shifts > 0 then
      v_parts := v_parts || (
        v_shifts::text
        || case when v_shifts = 1 then ' turno' else ' turnos' end
        || ' (te toca)'
      );
    end if;
    if v_lists > 0 then
      v_parts := v_parts || (
        v_lists::text
        || case when v_lists = 1 then ' lista pendiente' else ' listas pendientes' end
      );
    end if;
    if v_polls > 0 then
      v_parts := v_parts || (
        v_polls::text
        || case when v_polls = 1 then ' encuesta por votar' else ' encuestas por votar' end
      );
    end if;
    v_body := 'Hoy: ' || array_to_string(v_parts, ', ');
    v_body := left(v_body, 160);

    begin
      insert into public.notifications
        (user_id, workspace_id, type, title, body, link, dedupe)
      values (
        v_user.user_id, null, 'daily', 'Tu día', v_body,
        '/inicio?vista=dia', v_dedupe
      )
      on conflict (user_id, dedupe) where dedupe is not null do nothing;
      if found then v_created := v_created + 1; end if;
    exception when others then null; end;
  end loop;
  return v_created;
exception when others then
  return v_created;
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. Realtime + privilegios (la puerta es la RLS)
-- -----------------------------------------------------------------------------
do $seriespub$
begin
  begin
    alter publication supabase_realtime add table public.task_series;
  exception when others then
    raise notice 'task_series sin realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.shift_swaps;
  exception when others then
    raise notice 'shift_swaps sin realtime: %', sqlerrm;
  end;
end
$seriespub$;

grant select, insert, update, delete on public.task_series to authenticated;
grant select, insert, update, delete on public.shift_swaps to authenticated;

grant execute on function public.materialize_series_occurrences(uuid, uuid, integer, integer) to authenticated;
grant execute on function public.edit_task_series(uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.delete_task_series(uuid, uuid, text) to authenticated;
grant execute on function public.request_shift_swap(uuid, uuid, text) to authenticated;
grant execute on function public.resolve_shift_swap(uuid, boolean) to authenticated;
grant execute on function public.skip_shift(uuid, uuid, date, date, text) to authenticated;
grant execute on function public.reorder_rotation(uuid, uuid[]) to authenticated;
grant execute on function public.series_usage(uuid) to authenticated;

-- Los jobs y los helpers internos no se llaman desde el cliente.
revoke execute on function public.series_local_clock(text) from public;
revoke execute on function public.series_in_pause(jsonb, date) from public;
revoke execute on function public.series_is_skipped(jsonb, uuid, date) from public;
revoke execute on function public.series_date_matches(text, integer, text, smallint[], smallint, smallint, smallint, date, date) from public;
revoke execute on function public.series_next_date(uuid, date, integer) from public;
revoke execute on function public.series_pick_rotation(uuid[], integer, jsonb, uuid, date) from public;
revoke execute on function public.series_space_limit() from public;
revoke execute on function public.task_series_guard_update() from public;
revoke execute on function public.task_series_limit_guard() from public;
revoke execute on function public.task_series_after_insert() from public;
revoke execute on function public.tasks_after_series_update() from public;
revoke execute on function public.series_on_member_leave() from public;
revoke execute on function public.create_shift_reminders() from anon, authenticated;
revoke execute on function public.create_daily_digests() from anon, authenticated;
