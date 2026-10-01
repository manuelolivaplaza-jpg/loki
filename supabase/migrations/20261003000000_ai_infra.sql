-- =============================================================================
-- Infraestructura de IA: cola de trabajos, cuota por espacio y uso.
-- NUEVA migración: no toca las anteriores.
--
-- 1. ai_jobs: cola de trabajos con evento (resumir, digerir, agente…).
--    Un trigger AFTER INSERT despierta a la Edge `loki-worker` vía pg_net con
--    los settings `loki.worker_url` / `loki.worker_key` (mismo patrón que
--    maybe_push_notification). Sin ellos no hace nada y nunca rompe el insert.
-- 2. Cuota por espacio: ai_space_usage (día), ai_space_usage_detail
--    (por usuario y tipo) y ai_space_limits (editable por admins).
--    La RPC atómica reserve_ai_quota() reserva antes de cada llamada al LLM.
-- 3. rescue_stuck_jobs(): rescata trabajos colgados (pg_cron, sin LLM).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Cola de trabajos
-- -----------------------------------------------------------------------------
create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  type text not null check (type in (
    'chat_summary', 'day_digest', 'transcribe_audio', 'ocr_image',
    'dispatch_agent', 'redact_highlights'
  )),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in (
    'queued', 'running', 'done', 'error', 'cancelled'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  idempotency_key text,
  result jsonb,
  error text,
  run_after timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_jobs is
  'Cola de trabajos de IA por espacio. La ejecuta la Edge loki-worker.';

create unique index if not exists ai_jobs_idempotency_uidx
  on public.ai_jobs (workspace_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists ai_jobs_claim_idx
  on public.ai_jobs (status, run_after)
  where status in ('queued', 'running');

create index if not exists ai_jobs_ws_idx
  on public.ai_jobs (workspace_id, created_at desc);

-- updated_at automático.
drop trigger if exists ai_jobs_touch_updated_at on public.ai_jobs;
create trigger ai_jobs_touch_updated_at
  before update on public.ai_jobs
  for each row execute function public.touch_updated_at();

alter table public.ai_jobs enable row level security;

-- Ver: miembros del espacio (el payload no filtra DMs: los tipos que leen
-- chats reciben solo ids de chats grupales; el worker revalida membresía).
drop policy if exists "ai_jobs: ver los de mi espacio" on public.ai_jobs;
create policy "ai_jobs: ver los de mi espacio"
  on public.ai_jobs for select to authenticated
  using (public.is_member(workspace_id));

-- Crear: miembros, siempre a nombre propio.
drop policy if exists "ai_jobs: pedir en mi espacio" on public.ai_jobs;
create policy "ai_jobs: pedir en mi espacio"
  on public.ai_jobs for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and requested_by is not distinct from auth.uid()
  );

-- Sin update/delete de cliente: el ciclo lo mueve la service role (worker).
-- Reintentar desde la UI pasa por la RPC retry_ai_job().

-- Reintento manual: quien lo pidió o un admin del espacio.
create or replace function public.retry_ai_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_jobs%rowtype;
begin
  select * into v_job from public.ai_jobs where id = p_job_id;
  if v_job.id is null then return false; end if;
  if v_job.requested_by is distinct from auth.uid()
     and not public.is_space_admin(v_job.workspace_id) then
    raise exception 'Solo quien pidió el trabajo o un admin puede reintentarlo'
      using errcode = 'insufficient_privilege';
  end if;
  if v_job.status not in ('error', 'cancelled') then return false; end if;
  update public.ai_jobs
     set status = 'queued', attempts = 0, error = null,
         run_after = null, result = null
   where id = p_job_id;
  return true;
end;
$$;

comment on function public.retry_ai_job(uuid) is
  'Reencola un trabajo fallido (quien lo pidió o admin del espacio).';

-- Despertar al worker tras cada trabajo nuevo (opt-in por settings).
create or replace function public.wake_ai_worker()
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
    v_url := current_setting('loki.worker_url', true);
    v_key := current_setting('loki.worker_key', true);
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
      body := jsonb_build_object('job_id', new.id)
    );
  exception when others then
    null;
  end;
  return null;
end;
$$;

drop trigger if exists wake_ai_worker on public.ai_jobs;
create trigger wake_ai_worker
  after insert on public.ai_jobs
  for each row execute function public.wake_ai_worker();

-- Rescate de trabajos colgados: running hace >10 min o queued con run_after
-- vencido y intentos restantes vuelve a queued (sin LLM, barato). Además
-- despierta al worker por cada trabajo listo (cierra el backoff de reintentos
-- sin depender solo del trigger de insert).
create or replace function public.rescue_stuck_jobs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_url text;
  v_key text;
  v_job uuid;
begin
  update public.ai_jobs
     set status = 'queued',
         run_after = null,
         started_at = null
   where status = 'running'
     and started_at < now() - interval '10 minutes'
     and attempts < max_attempts;
  get diagnostics v_count = row_count;

  begin
    v_url := current_setting('loki.worker_url', true);
    v_key := current_setting('loki.worker_key', true);
  exception when others then
    return v_count;
  end;
  if v_url is null or v_url = '' or v_key is null or v_key = '' then
    return v_count;
  end if;
  for v_job in
    select id from public.ai_jobs
     where status = 'queued'
       and (run_after is null or run_after <= now())
     order by created_at asc
     limit 10
  loop
    begin
      perform extensions.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || v_key
        ),
        body := jsonb_build_object('job_id', v_job)
      );
    exception when others then
      null;
    end;
  end loop;
  return v_count;
end;
$$;

comment on function public.rescue_stuck_jobs() is
  'Reencola trabajos colgados (pg_cron cada 5 min, sin LLM).';

do $aicron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin rescate de ai_jobs: %', sqlerrm;
    return;
  end;
  begin
    perform cron.unschedule('loki-ai-jobs-rescue');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule(
      'loki-ai-jobs-rescue',
      '*/5 * * * *',
      'select public.rescue_stuck_jobs()'
    );
  exception when others then
    raise notice 'no se pudo programar el rescate de ai_jobs: %', sqlerrm;
  end;
end
$aicron$;

-- Realtime: el cliente ve el estado de su fila sin consultar en bucle.
do $aipub$
begin
  begin
    alter publication supabase_realtime add table public.ai_jobs;
  exception when others then
    raise notice 'no se pudo publicar ai_jobs en realtime: %', sqlerrm;
  end;
end
$aipub$;

-- -----------------------------------------------------------------------------
-- 2. Uso y límites por espacio
-- -----------------------------------------------------------------------------

-- Unidades del día por espacio (1 unidad ≈ 250 caracteres de ida+vuelta).
create table if not exists public.ai_space_usage (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  day date not null default CURRENT_DATE,
  units integer not null default 0 check (units >= 0),
  calls integer not null default 0 check (calls >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, day)
);

comment on table public.ai_space_usage is
  'Consumo diario de IA por espacio. Lo acumula reserve_ai_quota().';

-- Desglose por usuario y tipo de trabajo (para la pantalla de uso).
create table if not exists public.ai_space_usage_detail (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  day date not null default CURRENT_DATE,
  user_id uuid references auth.users (id) on delete cascade,
  job_type text not null default 'chat',
  units integer not null default 0 check (units >= 0),
  calls integer not null default 0 check (calls >= 0),
  primary key (workspace_id, day, user_id, job_type)
);

comment on table public.ai_space_usage_detail is
  'Desglose de consumo por miembro y función. Solo visible para admins.';

-- Límites por espacio (null = default global; los fija un admin).
create table if not exists public.ai_space_limits (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  daily_units integer check (daily_units is null or daily_units > 0),
  monthly_units integer check (monthly_units is null or monthly_units > 0),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.ai_space_limits is
  'Límites de IA por espacio. null = default (familia 200/día, equipo 1000/día).';

alter table public.ai_space_usage enable row level security;
alter table public.ai_space_usage_detail enable row level security;
alter table public.ai_space_limits enable row level security;

-- Totales: cualquier miembro.
drop policy if exists "ai_space_usage: ver mi espacio" on public.ai_space_usage;
create policy "ai_space_usage: ver mi espacio"
  on public.ai_space_usage for select to authenticated
  using (public.is_member(workspace_id));

-- Desglose por miembro: solo admins (la UI lo oculta al resto).
drop policy if exists "ai_space_usage_detail: ver admins" on public.ai_space_usage_detail;
create policy "ai_space_usage_detail: ver admins"
  on public.ai_space_usage_detail for select to authenticated
  using (public.is_space_admin(workspace_id));

-- Límites: ver miembros, escribir admins.
drop policy if exists "ai_space_limits: ver mi espacio" on public.ai_space_limits;
create policy "ai_space_limits: ver mi espacio"
  on public.ai_space_limits for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "ai_space_limits: editar admins" on public.ai_space_limits;
create policy "ai_space_limits: editar admins"
  on public.ai_space_limits for insert to authenticated
  with check (
    public.is_space_admin(workspace_id)
    and updated_by is not distinct from auth.uid()
  );

drop policy if exists "ai_space_limits: actualizar admins" on public.ai_space_limits;
create policy "ai_space_limits: actualizar admins"
  on public.ai_space_limits for update to authenticated
  using (public.is_space_admin(workspace_id))
  with check (
    public.is_space_admin(workspace_id)
    and updated_by is not distinct from auth.uid()
  );

-- -----------------------------------------------------------------------------
-- 3. Reserva atómica de cuota (usuario + espacio).
--
-- Devuelve {"allowed": bool, "reason": "ok"|"user"|"space_daily"|"space_monthly"}.
-- Orden: primero lee el espacio (sin escribir); si queda, consume la cuota
-- diaria del usuario (bump_ai_usage) y acumula el uso del espacio. Así un
-- espacio sin cuota no gasta la cuota personal.
-- -----------------------------------------------------------------------------
create or replace function public.reserve_ai_quota(
  p_workspace_id uuid,
  p_user_id uuid,
  p_job_type text,
  p_units integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_units integer := greatest(coalesce(p_units, 1), 1);
  v_type text := nullif(btrim(coalesce(p_job_type, 'chat')), '');
  v_daily integer;
  v_monthly integer;
  v_used_day integer := 0;
  v_used_month integer := 0;
  v_user jsonb;
  v_is_family boolean := true;
begin
  if p_workspace_id is null or p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'forbidden');
  end if;
  if v_type is null then v_type := 'chat'; end if;

  -- Defaults por tipo de espacio (familia 200/día, equipo 1000/día;
  -- mes = 30x). La columna kind llega con el lote de espacios; si aún no
  -- existe se asume familia.
  begin
    execute 'select (kind = ''family'') from public.workspaces where id = $1'
      into v_is_family using p_workspace_id;
  exception when undefined_column then
    v_is_family := true;
  end;
  if v_is_family is null then v_is_family := true; end if;

  select daily_units, monthly_units into v_daily, v_monthly
    from public.ai_space_limits
   where workspace_id = p_workspace_id;
  if v_daily is null then v_daily := case when v_is_family then 200 else 1000 end; end if;
  if v_monthly is null then v_monthly := v_daily * 30; end if;

  select coalesce(sum(units), 0) into v_used_day
    from public.ai_space_usage
   where workspace_id = p_workspace_id and day = CURRENT_DATE;
  select coalesce(sum(units), 0) into v_used_month
    from public.ai_space_usage
   where workspace_id = p_workspace_id
     and day >= date_trunc('month', CURRENT_DATE)::date;

  if v_used_day + v_units > v_daily then
    return jsonb_build_object('allowed', false, 'reason', 'space_daily');
  end if;
  if v_used_month + v_units > v_monthly then
    return jsonb_build_object('allowed', false, 'reason', 'space_monthly');
  end if;

  -- Cuota personal (límite existente): si no queda, no se acumula nada.
  v_user := public.bump_ai_usage(p_user_id, 50);
  if coalesce((v_user->>'allowed')::boolean, false) = false then
    return jsonb_build_object('allowed', false, 'reason', 'user');
  end if;

  insert into public.ai_space_usage (workspace_id, day, units, calls)
  values (p_workspace_id, CURRENT_DATE, v_units, 1)
  on conflict (workspace_id, day) do update
    set units = public.ai_space_usage.units + excluded.units,
        calls = public.ai_space_usage.calls + 1,
        updated_at = now();

  insert into public.ai_space_usage_detail
    (workspace_id, day, user_id, job_type, units, calls)
  values (p_workspace_id, CURRENT_DATE, p_user_id, v_type, v_units, 1)
  on conflict (workspace_id, day, user_id, job_type) do update
    set units = public.ai_space_usage_detail.units + excluded.units,
        calls = public.ai_space_usage_detail.calls + 1;

  return jsonb_build_object('allowed', true, 'reason', 'ok');
end;
$$;

comment on function public.reserve_ai_quota(uuid, uuid, text, integer) is
  'Reserva cuota de IA (espacio + usuario). Atómica: sin cuota no acumula.';

-- -----------------------------------------------------------------------------
-- 4. Privilegios
-- -----------------------------------------------------------------------------
grant select, insert on public.ai_jobs to authenticated;

grant select on public.ai_space_usage to authenticated;
grant select on public.ai_space_usage_detail to authenticated;
grant select, insert, update on public.ai_space_limits to authenticated;

grant execute on function public.retry_ai_job(uuid) to authenticated;
grant execute on function public.rescue_stuck_jobs() to authenticated;
grant execute on function public.reserve_ai_quota(uuid, uuid, text, integer) to authenticated;
revoke execute on function public.rescue_stuck_jobs() from public;
