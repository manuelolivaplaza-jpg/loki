-- =============================================================================
-- Reparación final de RLS (cierre de p16): los cuatro focos que dejaron los
-- tests RLS en rojo. Migración NUEVA: no toca ninguna anterior.
--
-- 1. agent_runs: el SELECT re-leía la fila por id (agent_can_read_run), así que
--    el RETURNING de "insert ... select" no encontraba la fila recién insertada y
--    el insert daba 42501. Ahora la política evalúa las COLUMNAS de la fila
--    (agent_run_is_readable), que es la forma en que RLS puede ver una fila que
--    el propio comando acaba de crear. Misma regla de quién lee: quien la
--    pidió, el dueño del agente o un miembro del chat si el grant publica.
--    De paso, agent_can_invoke respeta el apagado del grant (enabled/admin_
--    disabled) tambien para el dueño, como ya hacia la Edge de despacho.
--    (Esto ultimo lo destapo el propio arreglo del RETURNING: antes el test de
--    gobernanza pasaba por el 42501 del SELECT, no por el permiso.)
-- 2. Encuestas: el tick cierra lo vencido y avisa UNA vez por destinatario
--    (dedupe poll:<id>:<uid>). Se unifica en un único recorrido: recordatorios
--    solo a encuestas abiertas con remindMissing que siguen sin votarse, sin
--    duplicar en ticks siguientes.
-- 3. Búsqueda: los nombres de archivo se normalizan antes de indexarse/compararse
--    (search_name_text), para que "regalo-secreto.png" se encuentre buscando
--    "regalo" o "secreto"; y cada fuente vuelve a filtrar por el acceso real
--    (can_access_chat para mensajes, DMs, encuestas y adjuntos, is_member del
--    espacio, y los recuerdos sensibles fuera del buscador global).
-- 4. Transcripciones: la lectura usa el acceso real al chat del mensaje, así
--    los dos participantes de un DM ven su nota de voz (y solo ellos).
--
-- Convenciones heredadas: snake_case, SECURITY DEFINER con search_path fijo,
-- DROP POLICY IF EXISTS + CREATE POLICY, políticas en español, y todo lo que
-- dependa del entorno dentro de bloques DO (aquí no hay nada que dependa).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Agentes: la política de SELECT mira la fila, no la vuelve a buscar
-- -----------------------------------------------------------------------------

-- Misma regla que agent_can_read_run, pero evaluada sobre las columnas de la
-- fila. Con la versión anterior, "insert into agent_runs ... returning id"
-- fallaba con 42501: dentro del RETURNING, la política de SELECT se evaluaba en
-- el contexto de escritura y agent_can_read_run (que hace SELECT ... where
-- id = p_run_id) no veía la fila que el propio INSERT acababa de crear.
create or replace function public.agent_run_is_readable(
  p_connection_id uuid,
  p_workspace_id uuid,
  p_chat_id text,
  p_requested_by uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_requested_by is not distinct from auth.uid()
    or public.agent_connection_owner(p_connection_id) is not distinct from auth.uid()
    or (
      coalesce(
        (
          select g.allow_publish
            from public.agent_space_grants g
           where g.connection_id = p_connection_id
             and g.workspace_id = p_workspace_id
          limit 1
        ),
        true
      )
      and public.can_access_chat(p_workspace_id, p_chat_id)
    );
$$;

comment on function public.agent_run_is_readable(uuid, uuid, text, uuid) is
  'Lectura de una ejecución evaluada sobre las columnas de la fila (la usa la política de SELECT, para que el RETURNING del INSERT vea su propia fila). Misma regla que agent_can_read_run.';

-- La versión por id se queda para las políticas que sí leen una fila ya
-- escrita (los eventos), apoyada en el helper de arriba.
create or replace function public.agent_can_read_run(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.agent_run_is_readable(
           r.connection_id, r.workspace_id, r.chat_id, r.requested_by
         )
    from public.agent_runs r
   where r.id = p_run_id;
$$;

comment on function public.agent_can_read_run(uuid) is
  'Visibilidad de una ejecución ya guardada: quien la pidió, el dueño del agente, o miembros del chat si el grant permite publicar.';

drop policy if exists "ejecuciones: leer las que me tocan"
  on public.agent_runs;
create policy "ejecuciones: leer las que me tocan"
  on public.agent_runs for select to authenticated
  using (
    public.agent_run_is_readable(connection_id, workspace_id, chat_id, requested_by)
  );

grant execute on function public.agent_run_is_readable(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.agent_can_read_run(uuid) to authenticated;

-- La gobernanza del espacio manda sobre la propiedad del agente: si el grant
-- de ESE espacio esta apagado (enabled = false, lo apaga el dueno; o
-- admin_disabled = true, lo apaga un admin del espacio), NADIE invoca ahi,
-- tampoco el dueno. Antes el camino "el dueno siempre" se saltaba los dos
-- interruptores y la fila se creaba para que la Edge agent-dispatch la
-- rechazara despues ("grant desactivado"). Sigue siendo cierto que el dueno
-- puede invocar sin grant en los espacios de los que es miembro.
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
      and public.is_member(p_workspace_id)
      and not exists (
        select 1
        from public.agent_space_grants g
        where g.connection_id = c.id
          and g.workspace_id = p_workspace_id
          and (not g.enabled or g.admin_disabled)
      )
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
  'Invoke este agente en este espacio: el dueno si, salvo que el grant de ese espacio este apagado (enabled = false o admin_disabled = true: manda la gobernanza del espacio); el resto segun el grant (habilitado, sin bloqueo de admin y llamador permitido).';

-- -----------------------------------------------------------------------------
-- 2. Encuestas: el tick cierra lo vencido y avisa UNA vez a quien no votó
-- -----------------------------------------------------------------------------

create or replace function public.close_due_polls()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  perform set_config('loki.poll_write', 'on', true);
  update public.polls
     set closed_at = now()
   where closed_at is null
     and closes_at is not null
     and closes_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
exception when others then
  return 0;
end;
$$;

comment on function public.close_due_polls() is
  'Cierra las encuestas con el plazo vencido (pg_cron o lectura).';

-- Un aviso por persona y encuesta, y solo a quien sigue sin votar cuando la
-- encuesta está por cerrarse (idempotente por dedupe: los ticks siguientes no
-- duplican nada). Si la encuesta ya se cerró no se avisa: el cierre manda.
create or replace function public.create_poll_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll record;
  v_uid uuid;
  v_created integer := 0;
begin
  for v_poll in
    select p.id, p.workspace_id, p.chat_id, p.message_id, p.question, p.created_by
      from public.polls p
     where p.closed_at is null
       and p.closes_at is not null
       and p.closes_at > now()
       and p.closes_at <= now() + interval '2 hours'
       and public.poll_flag(p.settings, 'remindMissing', false)
  loop
    for v_uid in
      select e.user_id
        from public.poll_electors(v_poll.workspace_id, v_poll.chat_id) as e(user_id)
       where e.user_id <> coalesce(v_poll.created_by, '00000000-0000-0000-0000-000000000000')
         and not exists (
           select 1 from public.poll_votes v
            where v.poll_id = v_poll.id and v.user_id = e.user_id
         )
    loop
      begin
        insert into public.notifications
          (user_id, workspace_id, type, title, body, link, dedupe)
        values (
          v_uid,
          v_poll.workspace_id,
          'poll',
          'Falta tu voto',
          left(v_poll.question, 100),
          '/chat/c?id=' || v_poll.chat_id || '&msg=' || v_poll.message_id,
          'poll:' || v_poll.id::text || ':' || v_uid::text
        )
        on conflict (user_id, dedupe) where dedupe is not null do nothing;
        if found then v_created := v_created + 1; end if;
      exception when others then
        null;
      end;
    end loop;
  end loop;
  return v_created;
exception when others then
  return 0;
end;
$$;

comment on function public.create_poll_reminders() is
  'Un aviso por quien no votó antes del cierre (idempotente por dedupe).';

create or replace function public.poll_tick()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_closed integer := 0;
  v_reminders integer := 0;
begin
  v_closed := public.close_due_polls();
  v_reminders := public.create_poll_reminders();
  return jsonb_build_object('closed', v_closed, 'reminders', v_reminders);
exception when others then
  return jsonb_build_object('closed', 0, 'reminders', 0);
end;
$$;

comment on function public.poll_tick() is
  'Tick de encuestas (pg_cron): cierra lo vencido y avisa una vez a quien no votó.';

-- -----------------------------------------------------------------------------
-- 3. Búsqueda: nombres de archivo legibles y permisos reales por fuente
-- -----------------------------------------------------------------------------

-- "regalo-secreto.png" -> "regalo secreto png". Sin esto, el tsvector del
-- nombre era un solo token y buscar "regalo" o "regalo secreto" no lo encontraba.
create or replace function public.search_name_text(p_name text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(coalesce(p_name, ''), '[-_.]+', ' ', 'g'));
$$;

comment on function public.search_name_text(text) is
  'Nombre de archivo normalizado para buscar: los separadores (- _ .) cuentan como espacios.';

-- Acceso real al contenido de un chat: grupo y publicaciones, la membresía del
-- espacio; un DM, su lista real de participantes (member_ids), que es lo que el
-- propio chat declara y lo que la interfaz usa para el otro lado de la nota.
create or replace function public.can_read_chat_content(p_workspace_id uuid, p_chat_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.chats c
     where c.workspace_id = p_workspace_id
       and c.id = p_chat_id
       and (
         (c.type = 'dm' and auth.uid() = any (c.member_ids))
         or (c.type in ('group', 'posts') and public.is_member(p_workspace_id))
       )
  );
$$;

comment on function public.can_read_chat_content(uuid, text) is
  'Acceso real al contenido de un chat: grupo/publicaciones = ser miembro del espacio; DM = estar en sus member_ids.';

grant execute on function public.can_read_chat_content(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Transcripciones: la lectura hereda el acceso real a su chat
-- -----------------------------------------------------------------------------

drop policy if exists "transcripciones: leer las que me tocan"
  on public.audio_transcriptions;
create policy "transcripciones: leer las que me tocan"
  on public.audio_transcriptions for select to authenticated
  using (
    (message_id is not null and chat_id is not null
      and public.can_read_chat_content(workspace_id, chat_id))
    or (message_id is null and requested_by is not distinct from auth.uid())
  );

-- -----------------------------------------------------------------------------
-- 5. global_search y search_more redefinidos (mismas firmas y mismos filtros)
-- -----------------------------------------------------------------------------

create or replace function public.global_search(
  p_ws uuid,
  p_q text,
  p_types text[] default null,
  p_chat text default null,
  p_author text default null,
  p_mine boolean default false,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_q text := btrim(coalesce(p_q, ''));
  v_like text;
  v_ts tsquery;
  v_uid uuid := auth.uid();
  v_chat_like text;
  v_author_like text;
  v_mine boolean := coalesce(p_mine, false);
  v_lim integer := least(greatest(coalesce(p_limit, 8), 1), 20);
  v_messages jsonb := '[]'::jsonb;
  v_tasks jsonb := '[]'::jsonb;
  v_projects jsonb := '[]'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_people jsonb := '[]'::jsonb;
  v_transcriptions jsonb := '[]'::jsonb;
  v_memories jsonb := '[]'::jsonb;
  v_lists jsonb := '[]'::jsonb;
  v_list_items jsonb := '[]'::jsonb;
  v_polls jsonb := '[]'::jsonb;
  v_ideas jsonb := '[]'::jsonb;
  v_attachments jsonb := '[]'::jsonb;
begin
  if not public.is_member(p_ws) then
    raise exception 'No eres miembro de ese espacio'
      using errcode = 'insufficient_privilege';
  end if;

  if char_length(v_q) < 2 then
    return jsonb_build_object(
      'messages', '[]'::jsonb,
      'tasks', '[]'::jsonb,
      'projects', '[]'::jsonb,
      'events', '[]'::jsonb,
      'people', '[]'::jsonb,
      'transcriptions', '[]'::jsonb,
      'memories', '[]'::jsonb,
      'lists', '[]'::jsonb,
      'list_items', '[]'::jsonb,
      'polls', '[]'::jsonb,
      'ideas', '[]'::jsonb,
      'attachments', '[]'::jsonb
    );
  end if;

  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  begin
    v_ts := plainto_tsquery('spanish', v_q);
  exception when others then
    v_ts := null;
  end;

  if p_chat is not null and btrim(p_chat) <> '' then
    v_chat_like := '%' || replace(replace(replace(btrim(p_chat), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  else
    v_chat_like := null;
  end if;

  if p_author is not null and btrim(p_author) <> '' then
    v_author_like := '%' || replace(replace(replace(btrim(p_author), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  else
    v_author_like := null;
  end if;

  -- Mensajes (sin borrados): solo de chats a los que tengo acceso.
  if p_types is null or 'messages' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_messages
    from (
      select
        m.id as id,
        m.chat_id as chat_id,
        c.name as chat_name,
        m.author_name as author_name,
        left(m.text, 140) as text,
        m.created_at as created_at
      from public.messages m
      join public.chats c
        on c.workspace_id = m.workspace_id
       and c.id = m.chat_id
      where m.workspace_id = p_ws
        and m.deleted = false
        and public.can_access_chat(m.workspace_id, m.chat_id)
        and (v_chat_like is null or c.name ilike v_chat_like escape '\')
        and (v_author_like is null or m.author_name ilike v_author_like escape '\')
        and (not v_mine or m.author_id = v_uid)
        and (p_from is null or m.created_at >= p_from)
        and (p_to is null or m.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(m.text, '')) @@ v_ts)
          or m.text ilike v_like escape '\'
          or m.author_name ilike v_like escape '\'
        )
      order by m.created_at desc
      limit v_lim
    ) s;
  end if;

  -- Tareas: título o notas.
  if p_types is null or 'tasks' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_tasks
    from (
      select
        t.id as id,
        t.project_id as project_id,
        p.name as project_name,
        t.title as title,
        t.status as status,
        t.updated_at as updated_at
      from public.tasks t
      join public.projects p
        on p.id = t.project_id
      where t.workspace_id = p_ws
        and (not v_mine or t.created_by = v_uid or v_uid = any (t.assignee_ids))
        and (p_from is null or t.created_at >= p_from)
        and (p_to is null or t.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(t.title, '') || ' ' || coalesce(t.notes, '')) @@ v_ts)
          or t.title ilike v_like escape '\'
          or coalesce(t.notes, '') ilike v_like escape '\'
        )
      order by t.updated_at desc
      limit v_lim
    ) s;
  end if;

  -- Proyectos: nombre o descripción.
  if p_types is null or 'projects' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_projects
    from (
      select
        p.id as id,
        p.name as name,
        p.emoji as emoji,
        p.updated_at as updated_at
      from public.projects p
      where p.workspace_id = p_ws
        and (not v_mine or p.created_by = v_uid)
        and (p_from is null or p.created_at >= p_from)
        and (p_to is null or p.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(p.name, '') || ' ' || coalesce(p.description, '')) @@ v_ts)
          or p.name ilike v_like escape '\'
          or coalesce(p.description, '') ilike v_like escape '\'
        )
      order by p.updated_at desc
      limit v_lim
    ) s;
  end if;

  -- Eventos: título o descripción (los próximos primero; el rango mira
  -- cuándo OCURRE el evento, no cuándo se creó).
  if p_types is null or 'events' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.starts_at asc), '[]'::jsonb)
      into v_events
    from (
      select
        e.id as id,
        e.title as title,
        e.starts_at as starts_at,
        e.updated_at as updated_at
      from public.events e
      where e.workspace_id = p_ws
        and (not v_mine or e.created_by = v_uid)
        and (p_from is null or e.starts_at >= p_from)
        and (p_to is null or e.starts_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(e.title, '') || ' ' || coalesce(e.description, '')) @@ v_ts)
          or e.title ilike v_like escape '\'
          or coalesce(e.description, '') ilike v_like escape '\'
        )
      order by e.starts_at asc
      limit v_lim
    ) s;
  end if;

  -- Personas: miembros del espacio por nombre visible ("solo míos" = yo).
  if p_types is null or 'people' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.display_name asc), '[]'::jsonb)
      into v_people
    from (
      select
        m.user_id as user_id,
        m.display_name as display_name,
        m.role as role
      from public.workspace_members m
      where m.workspace_id = p_ws
        and m.display_name ilike v_like escape '\'
        and (not v_mine or m.user_id = v_uid)
      order by m.display_name asc
      limit v_lim
    ) s;
  end if;

  -- Transcripciones listas: nota de voz de un chat accesible o dictado propio.
  if p_types is null or 'transcriptions' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_transcriptions
    from (
      select
        tr.id as id,
        tr.message_id as message_id,
        tr.chat_id as chat_id,
        m.author_name as author_name,
        left(tr.text, 140) as text,
        tr.created_at as created_at
      from public.audio_transcriptions tr
      left join public.messages m on m.id = tr.message_id
      left join public.chats c
        on c.workspace_id = tr.workspace_id
       and c.id = tr.chat_id
      where tr.workspace_id = p_ws
        and tr.status = 'ready'
        and coalesce(tr.text, '') <> ''
        and (
          (tr.message_id is not null and tr.chat_id is not null
            and public.can_read_chat_content(tr.workspace_id, tr.chat_id))
          or (tr.message_id is null and tr.requested_by = v_uid)
        )
        and (v_chat_like is null or tr.chat_id is null or c.name ilike v_chat_like escape '\')
        and (v_author_like is null or m.author_name ilike v_author_like escape '\')
        and (not v_mine or tr.requested_by = v_uid or m.author_id = v_uid)
        and (p_from is null or tr.created_at >= p_from)
        and (p_to is null or tr.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(tr.text, '')) @@ v_ts)
          or tr.text ilike v_like escape '\'
        )
      order by tr.created_at desc
      limit v_lim
    ) s;
  end if;

  -- Recuerdos compartidos y no sensibles (una clave nunca aparece en el
  -- buscador global). Vigentes y, con "solo míos", solo los propios.
  if p_types is null or 'memories' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_memories
    from (
      select
        m.id as id,
        left(m.content, 140) as content,
        m.category as category,
        m.pinned as pinned,
        coalesce(w.display_name, 'Alguien') as author_name,
        m.created_at as created_at
      from public.space_memories m
      left join public.workspace_members w
        on w.workspace_id = m.workspace_id
       and w.user_id = m.created_by
      where m.workspace_id = p_ws
        and m.sensitive = false
        and m.visibility = 'espacio'
        and (m.expires_at is null or m.expires_at > now())
        and (v_author_like is null or coalesce(w.display_name, '') ilike v_author_like escape '\')
        and (not v_mine or m.created_by = v_uid)
        and (p_from is null or m.created_at >= p_from)
        and (p_to is null or m.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(m.content, '')) @@ v_ts)
          or m.content ilike v_like escape '\'
        )
      order by m.pinned desc, m.created_at desc
      limit v_lim
    ) s;
  end if;

  -- Listas: título (las archivadas siguen saliendo: se pueden desarchivar).
  if p_types is null or 'lists' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_lists
    from (
      select
        l.id as id,
        l.title as title,
        l.emoji as emoji,
        l.kind as kind,
        l.updated_at as updated_at
      from public.lists l
      where l.workspace_id = p_ws
        and (not v_mine or l.created_by = v_uid)
        and (p_from is null or l.created_at >= p_from)
        and (p_to is null or l.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(l.title, '')) @@ v_ts)
          or l.title ilike v_like escape '\'
        )
      order by l.updated_at desc
      limit v_lim
    ) s;
  end if;

  -- Ítems de lista: texto (con su lista para abrirla en su lugar).
  if p_types is null or 'list_items' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_list_items
    from (
      select
        i.id as id,
        i.list_id as list_id,
        l.title as list_title,
        left(i.text, 140) as text,
        i.checked as checked,
        i.updated_at as updated_at
      from public.list_items i
      join public.lists l on l.id = i.list_id
      where i.workspace_id = p_ws
        and (not v_mine or i.created_by = v_uid)
        and (p_from is null or i.created_at >= p_from)
        and (p_to is null or i.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(i.text, '')) @@ v_ts)
          or i.text ilike v_like escape '\'
        )
      order by i.updated_at desc
      limit v_lim
    ) s;
  end if;

  -- Encuestas: pregunta (solo de chats a los que tengo acceso; el voto
  -- anónimo no se expone: aquí solo va la pregunta y su estado).
  if p_types is null or 'polls' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_polls
    from (
      select
        p.id as id,
        p.message_id as message_id,
        p.chat_id as chat_id,
        c.name as chat_name,
        left(p.question, 140) as question,
        p.kind as kind,
        (p.closed_at is null) as is_open,
        p.created_at as created_at
      from public.polls p
      join public.chats c
        on c.workspace_id = p.workspace_id
       and c.id = p.chat_id
      where p.workspace_id = p_ws
        and public.can_access_chat(p.workspace_id, p.chat_id)
        and (v_chat_like is null or c.name ilike v_chat_like escape '\')
        and (not v_mine or p.created_by = v_uid)
        and (p_from is null or p.created_at >= p_from)
        and (p_to is null or p.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(p.question, '')) @@ v_ts)
          or p.question ilike v_like escape '\'
        )
      order by p.created_at desc
      limit v_lim
    ) s;
  end if;

  -- Ideas: título o detalle.
  if p_types is null or 'ideas' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_ideas
    from (
      select
        i.id as id,
        i.title as title,
        left(i.detail, 140) as detail,
        i.tag as tag,
        i.updated_at as updated_at
      from public.ideas i
      where i.workspace_id = p_ws
        and (not v_mine or i.created_by = v_uid)
        and (p_from is null or i.created_at >= p_from)
        and (p_to is null or i.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', coalesce(i.title, '') || ' ' || coalesce(i.detail, '')) @@ v_ts)
          or i.title ilike v_like escape '\'
          or coalesce(i.detail, '') ilike v_like escape '\'
        )
      order by i.updated_at desc
      limit v_lim
    ) s;
  end if;

  -- Adjuntos: nombre del archivo o texto extraído por OCR (solo de chats
  -- accesibles; los borrados suaves del mensaje también se excluyen).
  if p_types is null or 'attachments' = any (p_types) then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_attachments
    from (
      select
        a.id as id,
        a.message_id as message_id,
        a.chat_id as chat_id,
        c.name as chat_name,
        a.name as name,
        a.mime as mime,
        a.kind as kind,
        a.author_name as author_name,
        left(a.ocr_text, 140) as ocr_text,
        a.created_at as created_at
      from public.message_attachments a
      join public.chats c
        on c.workspace_id = a.workspace_id
       and c.id = a.chat_id
      join public.messages m on m.id = a.message_id
      where a.workspace_id = p_ws
        and m.deleted = false
        and public.can_access_chat(a.workspace_id, a.chat_id)
        and (v_chat_like is null or c.name ilike v_chat_like escape '\')
        and (v_author_like is null or a.author_name ilike v_author_like escape '\')
        and (not v_mine or a.author_id = v_uid)
        and (p_from is null or a.created_at >= p_from)
        and (p_to is null or a.created_at <= p_to)
        and (
          (v_ts is not null and to_tsvector('spanish', public.search_name_text(a.name) || ' ' || coalesce(a.ocr_text, '')) @@ v_ts)
          or public.search_name_text(a.name) ilike v_like escape '\'
          or a.name ilike v_like escape '\'
          or coalesce(a.ocr_text, '') ilike v_like escape '\'
        )
      order by a.created_at desc
      limit v_lim
    ) s;
  end if;

  return jsonb_build_object(
    'messages', v_messages,
    'tasks', v_tasks,
    'projects', v_projects,
    'events', v_events,
    'people', v_people,
    'transcriptions', v_transcriptions,
    'memories', v_memories,
    'lists', v_lists,
    'list_items', v_list_items,
    'polls', v_polls,
    'ideas', v_ideas,
    'attachments', v_attachments
  );
end;
$$;

create or replace function public.search_more(
  p_ws uuid,
  p_q text,
  p_group text,
  p_limit integer default 8,
  p_offset integer default 0,
  p_chat text default null,
  p_author text default null,
  p_mine boolean default false,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_q text := btrim(coalesce(p_q, ''));
  v_like text;
  v_ts tsquery;
  v_uid uuid := auth.uid();
  v_chat_like text;
  v_author_like text;
  v_mine boolean := coalesce(p_mine, false);
  v_lim integer := least(greatest(coalesce(p_limit, 8), 1), 20);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
begin
  if not public.is_member(p_ws) then
    raise exception 'No eres miembro de ese espacio'
      using errcode = 'insufficient_privilege';
  end if;

  if char_length(v_q) < 2 then
    return '[]'::jsonb;
  end if;

  if p_group is null or p_group not in (
    'messages', 'tasks', 'projects', 'events', 'people',
    'transcriptions', 'memories', 'lists', 'list_items',
    'polls', 'ideas', 'attachments'
  ) then
    raise exception 'Grupo desconocido'
      using errcode = 'check_violation';
  end if;

  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  begin
    v_ts := plainto_tsquery('spanish', v_q);
  exception when others then
    v_ts := null;
  end;

  if p_chat is not null and btrim(p_chat) <> '' then
    v_chat_like := '%' || replace(replace(replace(btrim(p_chat), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  else
    v_chat_like := null;
  end if;

  if p_author is not null and btrim(p_author) <> '' then
    v_author_like := '%' || replace(replace(replace(btrim(p_author), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  else
    v_author_like := null;
  end if;

  if p_group = 'messages' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_rows
    from (
      select m.id as id, m.chat_id as chat_id, c.name as chat_name,
        m.author_name as author_name, left(m.text, 140) as text, m.created_at as created_at
      from public.messages m
      join public.chats c on c.workspace_id = m.workspace_id and c.id = m.chat_id
      where m.workspace_id = p_ws and m.deleted = false
        and public.can_access_chat(m.workspace_id, m.chat_id)
        and (v_chat_like is null or c.name ilike v_chat_like escape '\')
        and (v_author_like is null or m.author_name ilike v_author_like escape '\')
        and (not v_mine or m.author_id = v_uid)
        and (p_from is null or m.created_at >= p_from)
        and (p_to is null or m.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(m.text, '')) @@ v_ts)
          or m.text ilike v_like escape '\' or m.author_name ilike v_like escape '\')
      order by m.created_at desc limit v_lim offset v_off
    ) s;
  elsif p_group = 'tasks' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_rows
    from (
      select t.id as id, t.project_id as project_id, p.name as project_name,
        t.title as title, t.status as status, t.updated_at as updated_at
      from public.tasks t join public.projects p on p.id = t.project_id
      where t.workspace_id = p_ws
        and (not v_mine or t.created_by = v_uid or v_uid = any (t.assignee_ids))
        and (p_from is null or t.created_at >= p_from)
        and (p_to is null or t.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(t.title, '') || ' ' || coalesce(t.notes, '')) @@ v_ts)
          or t.title ilike v_like escape '\' or coalesce(t.notes, '') ilike v_like escape '\')
      order by t.updated_at desc limit v_lim offset v_off
    ) s;
  elsif p_group = 'projects' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_rows
    from (
      select p.id as id, p.name as name, p.emoji as emoji, p.updated_at as updated_at
      from public.projects p
      where p.workspace_id = p_ws
        and (not v_mine or p.created_by = v_uid)
        and (p_from is null or p.created_at >= p_from)
        and (p_to is null or p.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(p.name, '') || ' ' || coalesce(p.description, '')) @@ v_ts)
          or p.name ilike v_like escape '\' or coalesce(p.description, '') ilike v_like escape '\')
      order by p.updated_at desc limit v_lim offset v_off
    ) s;
  elsif p_group = 'events' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.starts_at asc), '[]'::jsonb)
      into v_rows
    from (
      select e.id as id, e.title as title, e.starts_at as starts_at, e.updated_at as updated_at
      from public.events e
      where e.workspace_id = p_ws
        and (not v_mine or e.created_by = v_uid)
        and (p_from is null or e.starts_at >= p_from)
        and (p_to is null or e.starts_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(e.title, '') || ' ' || coalesce(e.description, '')) @@ v_ts)
          or e.title ilike v_like escape '\' or coalesce(e.description, '') ilike v_like escape '\')
      order by e.starts_at asc limit v_lim offset v_off
    ) s;
  elsif p_group = 'people' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.display_name asc), '[]'::jsonb)
      into v_rows
    from (
      select m.user_id as user_id, m.display_name as display_name, m.role as role
      from public.workspace_members m
      where m.workspace_id = p_ws and m.display_name ilike v_like escape '\'
        and (not v_mine or m.user_id = v_uid)
      order by m.display_name asc limit v_lim offset v_off
    ) s;
  elsif p_group = 'transcriptions' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_rows
    from (
      select tr.id as id, tr.message_id as message_id, tr.chat_id as chat_id,
        m.author_name as author_name, left(tr.text, 140) as text, tr.created_at as created_at
      from public.audio_transcriptions tr
      left join public.messages m on m.id = tr.message_id
      left join public.chats c on c.workspace_id = tr.workspace_id and c.id = tr.chat_id
      where tr.workspace_id = p_ws and tr.status = 'ready' and coalesce(tr.text, '') <> ''
        and ((tr.message_id is not null and tr.chat_id is not null
          and public.can_read_chat_content(tr.workspace_id, tr.chat_id))
          or (tr.message_id is null and tr.requested_by = v_uid))
        and (v_chat_like is null or tr.chat_id is null or c.name ilike v_chat_like escape '\')
        and (v_author_like is null or m.author_name ilike v_author_like escape '\')
        and (not v_mine or tr.requested_by = v_uid or m.author_id = v_uid)
        and (p_from is null or tr.created_at >= p_from)
        and (p_to is null or tr.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(tr.text, '')) @@ v_ts)
          or tr.text ilike v_like escape '\')
      order by tr.created_at desc limit v_lim offset v_off
    ) s;
  elsif p_group = 'memories' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_rows
    from (
      select m.id as id, left(m.content, 140) as content, m.category as category,
        m.pinned as pinned, coalesce(w.display_name, 'Alguien') as author_name, m.created_at as created_at
      from public.space_memories m
      left join public.workspace_members w
        on w.workspace_id = m.workspace_id and w.user_id = m.created_by
      where m.workspace_id = p_ws and m.sensitive = false and m.visibility = 'espacio'
        and (m.expires_at is null or m.expires_at > now())
        and (v_author_like is null or coalesce(w.display_name, '') ilike v_author_like escape '\')
        and (not v_mine or m.created_by = v_uid)
        and (p_from is null or m.created_at >= p_from)
        and (p_to is null or m.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(m.content, '')) @@ v_ts)
          or m.content ilike v_like escape '\')
      order by m.pinned desc, m.created_at desc limit v_lim offset v_off
    ) s;
  elsif p_group = 'lists' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_rows
    from (
      select l.id as id, l.title as title, l.emoji as emoji, l.kind as kind, l.updated_at as updated_at
      from public.lists l
      where l.workspace_id = p_ws
        and (not v_mine or l.created_by = v_uid)
        and (p_from is null or l.created_at >= p_from)
        and (p_to is null or l.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(l.title, '')) @@ v_ts)
          or l.title ilike v_like escape '\')
      order by l.updated_at desc limit v_lim offset v_off
    ) s;
  elsif p_group = 'list_items' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_rows
    from (
      select i.id as id, i.list_id as list_id, l.title as list_title,
        left(i.text, 140) as text, i.checked as checked, i.updated_at as updated_at
      from public.list_items i join public.lists l on l.id = i.list_id
      where i.workspace_id = p_ws
        and (not v_mine or i.created_by = v_uid)
        and (p_from is null or i.created_at >= p_from)
        and (p_to is null or i.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(i.text, '')) @@ v_ts)
          or i.text ilike v_like escape '\')
      order by i.updated_at desc limit v_lim offset v_off
    ) s;
  elsif p_group = 'polls' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_rows
    from (
      select p.id as id, p.message_id as message_id, p.chat_id as chat_id, c.name as chat_name,
        left(p.question, 140) as question, p.kind as kind,
        (p.closed_at is null) as is_open, p.created_at as created_at
      from public.polls p
      join public.chats c on c.workspace_id = p.workspace_id and c.id = p.chat_id
      where p.workspace_id = p_ws
        and public.can_access_chat(p.workspace_id, p.chat_id)
        and (v_chat_like is null or c.name ilike v_chat_like escape '\')
        and (not v_mine or p.created_by = v_uid)
        and (p_from is null or p.created_at >= p_from)
        and (p_to is null or p.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(p.question, '')) @@ v_ts)
          or p.question ilike v_like escape '\')
      order by p.created_at desc limit v_lim offset v_off
    ) s;
  elsif p_group = 'ideas' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc), '[]'::jsonb)
      into v_rows
    from (
      select i.id as id, i.title as title, left(i.detail, 140) as detail,
        i.tag as tag, i.updated_at as updated_at
      from public.ideas i
      where i.workspace_id = p_ws
        and (not v_mine or i.created_by = v_uid)
        and (p_from is null or i.created_at >= p_from)
        and (p_to is null or i.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', coalesce(i.title, '') || ' ' || coalesce(i.detail, '')) @@ v_ts)
          or i.title ilike v_like escape '\' or coalesce(i.detail, '') ilike v_like escape '\')
      order by i.updated_at desc limit v_lim offset v_off
    ) s;
  else
    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      into v_rows
    from (
      select a.id as id, a.message_id as message_id, a.chat_id as chat_id, c.name as chat_name,
        a.name as name, a.mime as mime, a.kind as kind, a.author_name as author_name,
        left(a.ocr_text, 140) as ocr_text, a.created_at as created_at
      from public.message_attachments a
      join public.chats c on c.workspace_id = a.workspace_id and c.id = a.chat_id
      join public.messages m on m.id = a.message_id
      where a.workspace_id = p_ws and m.deleted = false
        and public.can_access_chat(a.workspace_id, a.chat_id)
        and (v_chat_like is null or c.name ilike v_chat_like escape '\')
        and (v_author_like is null or a.author_name ilike v_author_like escape '\')
        and (not v_mine or a.author_id = v_uid)
        and (p_from is null or a.created_at >= p_from)
        and (p_to is null or a.created_at <= p_to)
        and ((v_ts is not null and to_tsvector('spanish', public.search_name_text(a.name) || ' ' || coalesce(a.ocr_text, '')) @@ v_ts)
          or public.search_name_text(a.name) ilike v_like escape '\'
          or a.name ilike v_like escape '\' or coalesce(a.ocr_text, '') ilike v_like escape '\')
      order by a.created_at desc limit v_lim offset v_off
    ) s;
  end if;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

comment on function public.global_search(uuid, text, text[], text, text, boolean, timestamptz, timestamptz, integer) is
  'Búsqueda global del espacio: 12 grupos (mensajes, tareas, proyectos, eventos, personas, transcripciones, recuerdos no sensibles, listas, ítems, encuestas, ideas y adjuntos con OCR). Filtros por tipo, chat, autor, solo míos y fechas. Solo miembros; DMs ajenos fuera. Los nombres de archivo se buscan normalizados.';

revoke execute on function public.global_search(uuid, text, text[], text, text, boolean, timestamptz, timestamptz, integer) from anon;
revoke execute on function public.global_search(uuid, text, text[], text, text, boolean, timestamptz, timestamptz, integer) from public;
grant execute on function public.global_search(uuid, text, text[], text, text, boolean, timestamptz, timestamptz, integer) to authenticated;

comment on function public.search_more(uuid, text, text, integer, integer, text, text, boolean, timestamptz, timestamptz) is
  'Paginado "ver más" de un grupo de la búsqueda global (misma puerta y filtros que global_search, nombres de archivo normalizados).';

revoke execute on function public.search_more(uuid, text, text, integer, integer, text, text, boolean, timestamptz, timestamptz) from anon;
revoke execute on function public.search_more(uuid, text, text, integer, integer, text, text, boolean, timestamptz, timestamptz) from public;
grant execute on function public.search_more(uuid, text, text, integer, integer, text, text, boolean, timestamptz, timestamptz) to authenticated;
