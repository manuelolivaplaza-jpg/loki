-- =============================================================================
-- Resumen diario ("Tu día"): push de la mañana con tu día y vista "Tu día".
-- NUEVA migración: no toca las anteriores.
--
-- Reemplaza el resumen fijo `create_ai_daily_digest()` con el pg_cron
-- `loki-ai-daily-8am` a las 12:00 UTC (texto genérico igual para todos, y la
-- hora se corría con el horario de verano de Chile): aquí se desprograma ese
-- job y lo reemplaza `create_daily_digests()` cada 15 min.
--
-- 1. Preferencias por usuario (`daily_digest_prefs`): activado sí/no, hora
--    local (default 08:00), zona horaria (default America/Santiago), días
--    (todos o solo hábiles), qué espacios incluir (NULL/vacío = todos) y si
--    se avisa con un texto breve cuando no hay nada (default: no se manda).
-- 2. Notificación tipo `daily` (+ columna en `notification_prefs`, que
--    `push-send` ya respeta por tipo) con link `/inicio?vista=dia`.
-- 3. `create_daily_digests()`: SQL liviano, sin LLM. Busca a los usuarios
--    cuya hora local ya llegó en los últimos 15 min y que aún no tienen
--    resumen hoy (dedupe por usuario y día LOCAL), arma los datos con
--    consultas (eventos de hoy, tareas por vencer o atrasadas, listas
--    fijadas con pendientes, encuestas abiertas sin tu voto) y crea UNA
--    notificación agrupada por usuario. La hora local sale de
--    `now() AT TIME ZONE tz`, así el horario de verano no corre la hora.
--    Los turnos del prompt de recurrentes aún no existen como tablas: el
--    conteo se deja en 0 con guarda `to_regclass` para no romper cuando
--    lleguen (igual que listas/encuestas si faltaran).
-- 4. `day_highlights` en `ai_jobs`: "lo importante de tus espacios" NO se
--    genera para todos a las 8:00; se pide cuando el usuario abre "Tu día"
--    (modelo barato, cuota del espacio, cacheado por día en `ai_summaries`
--    con `chat_key = 'day:YYYY-MM-DD'`).
--
-- Convenciones heredadas: snake_case, SECURITY DEFINER con search_path fijo,
-- políticas con nombre en español, DROP POLICY IF EXISTS + CREATE POLICY,
-- GRANTs explícitos, y pg_cron en bloque DO con EXCEPTION.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Adiós al resumen fijo: se desprograma su job (la función vieja queda,
--    sin editar su migración, pero ya sin pg_cron que la llame).
-- -----------------------------------------------------------------------------
do $olddaily$
begin
  begin
    perform cron.unschedule('loki-ai-daily-8am');
  exception when others then
    null;
  end;
end
$olddaily$;

-- -----------------------------------------------------------------------------
-- 1. Tipo `daily` (+ interruptor por tipo).
-- -----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add check (type in (
  'mention', 'reply', 'reaction', 'task_assigned', 'task_due',
  'event_reminder', 'invite', 'ai_alert', 'list', 'poll', 'memory', 'daily'
));

alter table public.notification_prefs
  add column if not exists daily boolean not null default true;

comment on column public.notification_prefs.daily is
  'Resumen diario "Tu día" (push de la mañana).';

-- -----------------------------------------------------------------------------
-- 2. Preferencias del resumen diario (una fila por usuario; sin fila = default).
-- -----------------------------------------------------------------------------
create table if not exists public.daily_digest_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  digest_time time not null default time '08:00',
  timezone text not null default 'America/Santiago' check (char_length(btrim(timezone)) between 1 and 64),
  days text not null default 'all' check (days in ('all', 'weekdays')),
  -- NULL o vacío = todos los espacios del usuario; si no, solo esos.
  workspace_ids uuid[] not null default '{}',
  -- Sin nada pendiente: true manda un texto breve; false no manda push.
  send_when_empty boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.daily_digest_prefs is
  'Preferencias del resumen diario: hora local, zona, días y espacios incluidos.';

drop trigger if exists daily_digest_prefs_touch_updated_at on public.daily_digest_prefs;
create trigger daily_digest_prefs_touch_updated_at
  before update on public.daily_digest_prefs
  for each row execute function public.touch_updated_at();

alter table public.daily_digest_prefs enable row level security;

-- Cada usuario solo ve y edita sus propias preferencias.
drop policy if exists "resumen diario: ver solo el mio" on public.daily_digest_prefs;
create policy "resumen diario: ver solo el mio"
  on public.daily_digest_prefs for select to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "resumen diario: guardar solo el mio" on public.daily_digest_prefs;
create policy "resumen diario: guardar solo el mio"
  on public.daily_digest_prefs for insert to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "resumen diario: editar solo el mio" on public.daily_digest_prefs;
create policy "resumen diario: editar solo el mio"
  on public.daily_digest_prefs for update to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

drop policy if exists "resumen diario: borrar solo el mio" on public.daily_digest_prefs;
create policy "resumen diario: borrar solo el mio"
  on public.daily_digest_prefs for delete to authenticated
  using (user_id is not distinct from auth.uid());

-- -----------------------------------------------------------------------------
-- 3. `day_highlights` en la cola: destacados con IA bajo demanda.
-- -----------------------------------------------------------------------------
alter table public.ai_jobs drop constraint if exists ai_jobs_type_check;
alter table public.ai_jobs add check (type in (
  'chat_summary', 'day_digest', 'transcribe_audio', 'ocr_image',
  'dispatch_agent', 'redact_highlights', 'chat_digest', 'poll_summary',
  'day_highlights'
));

-- -----------------------------------------------------------------------------
-- 4. Generación barata por eventos (SQL liviano, sin LLM).
--
-- Cada corrida (pg_cron cada 15 min) atiende a los usuarios cuya hora local
-- cayó dentro de la ventana de los últimos 15 min y que aún no tienen
-- resumen hoy (dedupe `daily:YYYYMMDD` en día LOCAL, no UTC). Idempotente:
-- repetir la corrida no duplica.
--
-- Respeta: interruptor del tipo (`notification_prefs.daily`), horario de
-- silencio (si la hora local cae dentro, ese día no sale: push-send no
-- filtra silencio, así que se filtra aquí) y días hábiles.
--
-- No se duplica con `create_due_reminders`: dedupes y tipos distintos
-- (`daily:` vs `task-due:`/`task-rem:`/`event:`) y el resumen agrupa en un
-- solo texto lo que los recordatorios avisan uno por uno.
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

    -- Zona horaria del usuario (si es inválida, se salta sin romper el job).
    v_tz := v_user.timezone;
    begin
      v_local := now() at time zone v_tz;
    exception when others then
      continue;
    end;
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

    -- Turnos (series recurrentes): aún sin tablas; queda en 0 hasta que
    -- lleguen, sin romper el job.
    v_shifts := 0;

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
      v_parts := v_parts || 'te toca turno';
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

comment on function public.create_daily_digests() is
  'Resumen diario por hora local (SQL barato, sin LLM). Idempotente por usuario y día local.';

-- Una corrida cada 15 min (ventana de 15 min por usuario, hora local intacta
-- en verano porque se calcula con AT TIME ZONE por usuario).
do $dailycron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin resumen diario: %', sqlerrm;
    return;
  end;
  begin
    perform cron.unschedule('loki-daily-digest-15min');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule(
      'loki-daily-digest-15min',
      '*/15 * * * *',
      'select public.create_daily_digests()'
    );
  exception when others then
    raise notice 'no se pudo programar el resumen diario: %', sqlerrm;
  end;
end
$dailycron$;

-- -----------------------------------------------------------------------------
-- 5. Realtime + privilegios (la puerta es la RLS).
-- -----------------------------------------------------------------------------
do $dailypub$
begin
  begin
    alter publication supabase_realtime add table public.daily_digest_prefs;
  exception when others then
    raise notice 'daily_digest_prefs sin realtime: %', sqlerrm;
  end;
end
$dailypub$;

grant select, insert, update, delete on public.daily_digest_prefs to authenticated;
grant select on public.daily_digest_prefs to anon;

revoke execute on function public.create_daily_digests() from anon, authenticated;
