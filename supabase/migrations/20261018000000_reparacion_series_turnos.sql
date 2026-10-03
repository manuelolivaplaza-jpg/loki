-- =============================================================================
-- Reparación de tareas recurrentes y turnos (verificación del prompt 6).
-- Migración NUEVA: no toca `20261017000000_tareas_recurrentes_turnos.sql`.
--
-- Qué se arregla (todo era lógica de la migración del prompt 6, que aplicaba
-- pero no generaba ocurrencias, así que las pruebas de RLS fallaban):
--
-- 1. `materialize_series_occurrences` solo creaba tareas cuya fecha cabía en el
--    horizonte (1 día por defecto). Con una serie semanal la primera ocurrencia
--    caía 4-7 días después y NO se creaba nunca: la serie quedaba sin ninguna
--    tarea y el kanban, los turnos y el resumen diario no tenían nada que
--    mostrar. Ahora la serie mantiene SIEMPRE sus próximas ocurrencias a la
--    vista (hasta `series_min_live()`, 2), y además las que entren en el
--    horizonte. El número de ocurrencias vivas por serie sigue acotado (2), así
--    que no se crean cientos de tareas futuras ni queda nada escuchando 24/7: el
--    barrido de pg_cron sigue siendo el único que despierta.
-- 2. El trigger de alta (`task_series_after_insert`) creaba la primera
--    ocurrencia con el máximo por defecto (3): nacían 3 turnos de golpe.
--    Ahora crea exactamente la primera.
-- 3. La rotación arrancaba una persona más adelante: con `rotation_index = 0`
--    (el valor inicial de toda serie) `series_pick_rotation` repartía el primer
--    turno a la SEGUNDA persona de la lista y dejaba el puntero corrido, así que
--    "quien va primero" no era quien le tocaba. Ahora el índice es base 0 sobre
--    la lista.
-- 4. `skip_shift` (vacaciones) fallaba siempre con `record "v_task" has no field
--    "project_id"`: el bucle no seleccionaba esa columna y el aviso del push la
--    usa para el enlace.
-- 5. `delete_task_series(..., 'following')` ("esta y las siguientes") se llevaba
--    también las ocurrencias ya completadas, que son historial. Ahora quedan
--    como tareas normales (igual que las anteriores al corte).
--
-- Convenciones heredadas: snake_case, SECURITY DEFINER con search_path fijo,
-- GRANTs explícitos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Cuántas ocurrencias vivas mantiene una serie (2: la próxima y la que sigue)
-- -----------------------------------------------------------------------------
create or replace function public.series_min_live()
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select 2;
$$;

comment on function public.series_min_live() is
  'Ocurrencias vivas que una serie tiene siempre a la vista (próxima y la siguiente). Acota el futuro.';

-- -----------------------------------------------------------------------------
-- 2. Generación de ocurrencias (misma firma: los triggers y pg_cron no cambian)
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
  v_need integer;
  v_live integer;
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

    -- La serie siempre tiene `series_min_live()` ocurrencias sin hacer a la
    -- vista, aunque caigan fuera del horizonte (si no, el turno se vería
    -- semanas antes de llegar y el usuario no tendría nada que organizar).
    select count(*) into v_live
    from public.tasks t
    where t.series_id = v_series.id and t.status <> 'done';
    v_need := greatest(0, public.series_min_live() - coalesce(v_live, 0));

    v_no := 0;
    v_last_no := v_series.last_occurrence;
    while v_no < greatest(1, coalesce(p_max_per_series, 3))
      and (v_date <= v_limit or v_no < v_need)
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
  'Genera las ocurrencias de las series: mantiene las próximas (series_min_live) y las que entren en el horizonte. Triggers + pg_cron; sin LLM.';

-- Alta de la serie: exactamente la primera ocurrencia (el resto llega con el
-- barrido, con el horizonte o al completar la anterior).
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
  perform public.materialize_series_occurrences(new.id, null, 1, 1);
  return null;
exception when others then
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. La rotación arrancaba una persona más adelante
--
-- `series_pick_rotation` computaba la posición como `p_index - 1 + k`, así
-- que con `rotation_index = 0` (el valor inicial de toda serie) la primera
-- ocurrencia se le asignaba a la SEGUNDA persona de la lista, y el puntero
-- después de un turno quedaba en el sitio equivocado. Ahora el índice es base 0
-- sobre la lista: con 0 le toca a la primera y el puntero queda en la
-- siguiente.
-- -----------------------------------------------------------------------------
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
    v_pos := ((coalesce(p_index, 0) + v_k) % v_n + v_n) % v_n;
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

comment on function public.series_pick_rotation(uuid[], integer, jsonb, uuid, date) is
  'Quién de la rotación toca en esa fecha (índice base 0), saltando vacaciones y quienes ya no están en el espacio.';

-- -----------------------------------------------------------------------------
-- 4. `skip_shift` reventaba con "record v_task has no field project_id"
--
-- El bucle de las ocurrencias affected por las vacaciones seleccionaba
-- `t.id, t.due_at`, pero el aviso usa `v_task.project_id` (el enlace del push va
-- al proyecto de la tarea). Con ayuda de vacaciones la RPC fallaba siempre.
-- Misma función, mismo permiso, mismo aviso: ahora el bucle también trae
-- `project_id`.
-- -----------------------------------------------------------------------------
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
    select t.id, t.due_at, t.project_id
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

-- -----------------------------------------------------------------------------
-- 5. Borrar por alcance: lo ya hecho es historial y se queda
-- -----------------------------------------------------------------------------
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

  -- "Esta y las siguientes": lo anterior al corte y lo ya completado queda como
  -- tarea normal (con su historial) y la serie se va con el resto.
  update public.tasks
     set series_id = null, series_occurrence = null
   where series_id = v_series.id
     and (series_occurrence < v_from or status = 'done');

  delete from public.task_series where id = v_series.id;
  return 1;
end;
$$;

comment on function public.delete_task_series(uuid, uuid, text) is
  'Borra por alcance: "this" (solo la ocurrencia), "following" (deja lo anterior y lo hecho como tareas normales) o "all".';

-- -----------------------------------------------------------------------------
-- 6. Privilegios (el helper nuevo es interno)
-- -----------------------------------------------------------------------------
grant execute on function public.materialize_series_occurrences(uuid, uuid, integer, integer) to authenticated;
grant execute on function public.delete_task_series(uuid, uuid, text) to authenticated;
grant execute on function public.skip_shift(uuid, uuid, date, date, text) to authenticated;

revoke execute on function public.series_min_live() from public;
revoke execute on function public.series_pick_rotation(uuid[], integer, jsonb, uuid, date) from public;