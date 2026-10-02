-- =============================================================================
-- Memoria del espacio (lo que Loki recuerda y usa al responder).
-- NUEVA migración: no toca las anteriores.
--
-- Por qué una tabla y no un trabajo de `ai_jobs`: un recuerdo se lee, se
-- busca, se edita y caduca; es un dato, no el resultado de una llamada.
--
-- 1. space_memories: un hecho útil del espacio ("la clave del wifi es…",
--    "Tomás es alérgico al maní"). Categorías: salud, casa, contactos, trabajo
--    y otros. `sensitive` para claves y datos de salud, `pinned` para lo de
--    arriba de todo y `expires_at` para lo que cambia ("el código del portón
--    cambia en marzo").
-- 2. Visibilidad: `espacio` (los miembros) o `privado` (solo quien lo guardó,
--    un recuerdo personal dentro del espacio).
-- 3. Confirmación explícita: un recuerdo tomado de un DM nace `privado`
--    (trigger `space_memories_guard_source`); solo si quien lo guarda marca
--    `share_confirmed` pasa a `espacio`. Un DM no se filtra al espacio solo.
-- 4. Nada de barrer el chat: no hay proceso que lo lea en busca de recuerdos.
--    Se guardan por acción explícita (Loki con confirmación, el menú del
--    mensaje o la pantalla Memoria) y Loki los consulta con la RPC
--    `search_space_memories` (full-text en español, SQL barato, sin IA)
--    cuando alguien pregunta.
-- 5. Los sensibles no salen en push ni en la búsqueda global: el aviso por
--    insert solo se manda para recuerdos no sensibles y compartidos.
-- 6. Caducidad: pg_cron (SQL barato, sin LLM) avisa una vez al autor cuando
--    un recuerdo caduca en menos de 7 días.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tabla de recuerdos
-- -----------------------------------------------------------------------------
create table if not exists public.space_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 1000),
  category text not null default 'otros'
    check (category in ('salud', 'casa', 'contactos', 'trabajo', 'otros')),
  -- Claves, datos de salud, cuentas: se muestran ocultos y nunca van en push.
  sensitive boolean not null default false,
  pinned boolean not null default false,
  -- 'espacio' lo ven todos los miembros; 'privado' solo quien lo guardó.
  visibility text not null default 'espacio' check (visibility in ('espacio', 'privado')),
  -- Mensaje del que salió (el menú "Recordar en el espacio" o Loki en el chat).
  source_message_id uuid references public.messages (id) on delete set null,
  -- El autor confirmó que un recuerdo tomado de un DM puede verse en el espacio.
  share_confirmed boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  -- "el código del portón cambia en marzo": pasado el día, deja de ofrecerse.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.space_memories is
  'Recuerdos del espacio que Loki usa al responder. Se guardan solo por acción explícita (nunca se lee el chat en busca de datos).';

comment on column public.space_memories.sensitive is
  'Claves y datos de salud: oculto con "Mostrar", fuera de push y de la búsqueda global.';

comment on column public.space_memories.visibility is
  '''espacio'' para los miembros, ''privado'' para el recuerdo personal de quien lo guardó.';

comment on column public.space_memories.share_confirmed is
  'Verdadero solo si quien lo guardó confirmó compartirlo con todo el espacio (obligatorio cuando viene de un DM).';

create index if not exists space_memories_ws_idx
  on public.space_memories (workspace_id, pinned desc, created_at desc);

create index if not exists space_memories_expires_idx
  on public.space_memories (expires_at)
  where expires_at is not null;

drop trigger if exists space_memories_touch_updated_at on public.space_memories;
create trigger space_memories_touch_updated_at
  before update on public.space_memories
  for each row execute function public.touch_updated_at();

-- Índices de texto para el buscador y el recall de Loki (mismo criterio que
-- 20260930000003_search.sql: primero con unaccent, si el entorno no lo tiene
-- se reintenta sin él).
do $idx_mem_text$
begin
  begin
    create index if not exists space_memories_search_idx
      on public.space_memories
      using gin (to_tsvector('spanish', unaccent(coalesce(content, ''))));
  exception when others then
    create index if not exists space_memories_search_idx
      on public.space_memories
      using gin (to_tsvector('spanish', coalesce(content, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de recuerdos: %', sqlerrm;
end
$idx_mem_text$;

do $idx_mem_trgm$
begin
  create index if not exists space_memories_trgm_idx
    on public.space_memories using gin (coalesce(content, '') gin_trgm_ops);
exception when others then
  raise notice 'sin índice de trigramas de recuerdos: %', sqlerrm;
end
$idx_mem_trgm$;

alter table public.space_memories enable row level security;

-- -----------------------------------------------------------------------------
-- 2. RLS: los miembros leen lo compartido, cada uno crea lo suyo
-- -----------------------------------------------------------------------------

drop policy if exists "memoria: leer los recuerdos del espacio" on public.space_memories;
create policy "memoria: leer los recuerdos del espacio"
  on public.space_memories for select to authenticated
  using (
    public.is_member(workspace_id)
    and (visibility = 'espacio' or created_by is not distinct from auth.uid())
  );

-- Cualquier miembro guarda un recuerdo, siempre a nombre propio (el CHECK de
-- visibilidad y el trigger de DM se encargan del resto).
drop policy if exists "memoria: guardar en mi espacio" on public.space_memories;
create policy "memoria: guardar en mi espacio"
  on public.space_memories for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
  );

-- Edita quien lo guardó o un admin del espacio. El WITH CHECK mantiene la
-- regla de "solo se es quien se es": si además el chat de origen es un DM,
-- `share_confirmed` tiene que venir en true (el trigger lo exige igual).
drop policy if exists "memoria: editar creador o admin" on public.space_memories;
create policy "memoria: editar creador o admin"
  on public.space_memories for update to authenticated
  using (
    created_by is not distinct from auth.uid()
    or public.is_space_admin(workspace_id)
  )
  with check (
    public.is_member(workspace_id)
    and (
      created_by is not distinct from auth.uid()
      or public.is_space_admin(workspace_id)
    )
  );

drop policy if exists "memoria: borrar creador o admin" on public.space_memories;
create policy "memoria: borrar creador o admin"
  on public.space_memories for delete to authenticated
  using (
    created_by is not distinct from auth.uid()
    or public.is_space_admin(workspace_id)
  );

-- -----------------------------------------------------------------------------
-- 3. Un recuerdo que sale de un DM no se comparte solo
-- -----------------------------------------------------------------------------
create or replace function public.space_memories_guard_source()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_chat_type text;
begin
  if new.source_message_id is null then return new; end if;
  if new.visibility = 'privado' then return new; end if;
  select c.type into v_chat_type
    from public.messages m
    join public.chats c
      on c.workspace_id = m.workspace_id
     and c.id = m.chat_id
   where m.id = new.source_message_id;
  if v_chat_type = 'dm' and coalesce(new.share_confirmed, false) = false then
    -- Sin confirmación explícita queda como recuerdo personal de quien lo guardó.
    new.visibility := 'privado';
  end if;
  return new;
end;
$$;

comment on function public.space_memories_guard_source() is
  'Fuerza visibility = ''privado'' si el recuerdo viene de un DM y quien lo guarda no confirmó compartirlo.';

drop trigger if exists space_memories_guard_source on public.space_memories;
create trigger space_memories_guard_source
  before insert or update on public.space_memories
  for each row execute function public.space_memories_guard_source();

-- -----------------------------------------------------------------------------
-- 4. Búsqueda para Loki y para el buscador de la pantalla Memoria
--    (full-text en español + ilike, sin IA). SECURITY DEFINER: aquí se
--    repiten a mano las mismas condiciones que la RLS de la tabla.
-- -----------------------------------------------------------------------------

-- Palabras con sentido de una pregunta: "¿cuál era la clave del wifi?" se
-- busca por "clave | wifi" y no por la frase entera (plainto_tsquery exige
-- TODAS las palabras y no encuentra nada).
create or replace function public.memory_query_terms(p_query text)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(t.word), '{}'::text[])
  from (
    select distinct btrim(w) as word
    from unnest(
      regexp_split_to_array(
        lower(coalesce(p_query, '')),
        '[^[:alnum:]áéíóúüñÁÉÍÓÚÜÑ]+'
      )
    ) as w
    where char_length(btrim(w)) >= 3
      and lower(btrim(w)) <> all (array[
        'cual', 'cuales', 'cuando', 'donde', 'quien', 'como', 'esto',
        'esta', 'este', 'ese', 'esa', 'aqui', 'ser', 'estar', 'tiene',
        'habia', 'hay', 'era', 'eran', 'los', 'las', 'del', 'por',
        'para', 'con', 'sin', 'sobre', 'entre', 'mis', 'nuestro'
      ])
  ) t;
$$;

comment on function public.memory_query_terms(text) is
  'Palabras con sentido de una pregunta en español (para la búsqueda OR de la memoria).';

create or replace function public.search_space_memories(
  p_ws uuid,
  p_query text,
  p_limit integer default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_q text := btrim(coalesce(p_query, ''));
  v_like text;
  v_ts tsquery;
  v_any tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 20);
  v_rows jsonb;
begin
  if not public.is_member(p_ws) then
    raise exception 'No eres miembro de ese espacio'
      using errcode = 'insufficient_privilege';
  end if;

  if char_length(v_q) < 2 then
    return '[]'::jsonb;
  end if;

  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  begin
    v_ts := plainto_tsquery('spanish', v_q);
  exception when others then
    v_ts := null;
  end;

  -- Segunda pasada, la que de verdad sirve para una pregunta: OR de sus
  -- palabras con sentido ("clave | wifi").
  begin
    if array_length(public.memory_query_terms(v_q), 1) is not null then
      v_any := to_tsquery(
        'spanish',
        array_to_string(public.memory_query_terms(v_q), ' | ')
      );
    end if;
  exception when others then
    v_any := null;
  end;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
    into v_rows
  from (
    select
      m.id as id,
      m.content as content,
      m.category as category,
      m.sensitive as sensitive,
      m.pinned as pinned,
      m.visibility as visibility,
      m.expires_at as expires_at,
      m.created_at as created_at,
      coalesce(w.display_name, 'Alguien') as author_name
    from public.space_memories m
    left join public.workspace_members w
      on w.workspace_id = m.workspace_id
     and w.user_id = m.created_by
    where m.workspace_id = p_ws
      and (m.visibility = 'espacio' or m.created_by = auth.uid())
      and (m.expires_at is null or m.expires_at > now())
      and (
        (v_ts is not null and to_tsvector('spanish', coalesce(m.content, '')) @@ v_ts)
        or m.content ilike v_like escape '\'
        or (
          v_any is not null
          and to_tsvector('spanish', coalesce(m.content, '')) @@ v_any
        )
      )
    order by m.pinned desc, m.created_at desc
    limit v_limit
  ) s;

  return v_rows;
end;
$$;

comment on function public.search_space_memories(uuid, text, integer) is
  'Busca recuerdos del espacio (full-text en español, sin IA) para la pantalla Memoria y para el recall de Loki. Solo miembros, nunca caduca';

grant execute on function public.memory_query_terms(text) to authenticated;
revoke execute on function public.memory_query_terms(text) from anon;

-- -----------------------------------------------------------------------------
-- 5. Aviso al autor cuando su recuerdo está por caducar (SQL barato)
-- -----------------------------------------------------------------------------
create or replace function public.notify_expiring_memories()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_created integer := 0;
  v_total integer := 0;
begin
  for v_row in
    select id, workspace_id, content, sensitive, created_by, expires_at
      from public.space_memories
     where expires_at is not null
       and expires_at > now()
       and expires_at <= now() + interval '7 days'
       and created_by is not null
  loop
    begin
      insert into public.notifications
        (user_id, workspace_id, type, title, body, link, dedupe)
      values (
        v_row.created_by,
        v_row.workspace_id,
        'memory',
        'Un recuerdo está por caducar',
        case when v_row.sensitive then 'Recuerdo sensible' else left(v_row.content, 100) end,
        '/memoria',
        'memory-exp:' || v_row.id::text
      )
      on conflict (user_id, dedupe) where dedupe is not null do nothing;
      get diagnostics v_created = row_count;
      v_total := v_total + v_created;
    exception when others then
      null;
    end;
  end loop;
  return v_total;
end;
$$;

comment on function public.notify_expiring_memories() is
  'Avisa (una vez) al autor de los recuerdos que caducan en menos de 7 días. Sin contenido sensible.';

-- Aviso al espacio cuando alguien guarda un recuerdo compartido y no sensible.
create or replace function public.notify_memory_saved()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member record;
begin
  -- Nada de push ni de bandeja para lo privado o lo sensible.
  if new.visibility <> 'espacio' or new.sensitive then return null; end if;
  for v_member in
    select user_id from public.workspace_members
     where workspace_id = new.workspace_id
       and user_id is distinct from new.created_by
  loop
    begin
      insert into public.notifications
        (user_id, workspace_id, type, title, body, link, dedupe)
      values (
        v_member.user_id,
        new.workspace_id,
        'memory',
        'Nuevo recuerdo en el espacio',
        left(new.content, 100),
        '/memoria',
        'memory:' || new.id::text
      )
      on conflict (user_id, dedupe) where dedupe is not null do nothing;
    exception when others then
      null;
    end;
  end loop;
  return null;
end;
$$;

drop trigger if exists notify_memory_saved_ins on public.space_memories;
create trigger notify_memory_saved_ins
  after insert on public.space_memories
  for each row execute function public.notify_memory_saved();

-- -----------------------------------------------------------------------------
-- 6. global_search con el grupo `memories` (misma firma, un grupo más)
--
-- Copia de 20261008000000_transcriptions.sql + el grupo nuevo. Sin sensibles:
-- el buscador global es una vista previa y ahí no se filtran datos de salud
-- ni claves.
-- -----------------------------------------------------------------------------
create or replace function public.global_search(p_ws uuid, p_q text)
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
  v_messages jsonb;
  v_tasks jsonb;
  v_projects jsonb;
  v_events jsonb;
  v_people jsonb;
  v_transcriptions jsonb;
  v_memories jsonb;
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
      'memories', '[]'::jsonb
    );
  end if;

  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  begin
    v_ts := plainto_tsquery('spanish', v_q);
  exception when others then
    v_ts := null;
  end;

  -- Mensajes (sin borrados): solo de chats a los que tengo acceso.
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
      and (
        (v_ts is not null and to_tsvector('spanish', coalesce(m.text, '')) @@ v_ts)
        or m.text ilike v_like escape '\'
        or m.author_name ilike v_like escape '\'
      )
    order by m.created_at desc
    limit 8
  ) s;

  -- Tareas: título o notas.
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
      and (
        (v_ts is not null and to_tsvector('spanish', coalesce(t.title, '') || ' ' || coalesce(t.notes, '')) @@ v_ts)
        or t.title ilike v_like escape '\'
        or coalesce(t.notes, '') ilike v_like escape '\'
      )
    order by t.updated_at desc
    limit 8
  ) s;

  -- Proyectos: nombre o descripción.
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
      and (
        (v_ts is not null and to_tsvector('spanish', coalesce(p.name, '') || ' ' || coalesce(p.description, '')) @@ v_ts)
        or p.name ilike v_like escape '\'
        or coalesce(p.description, '') ilike v_like escape '\'
      )
    order by p.updated_at desc
    limit 8
  ) s;

  -- Eventos: título o descripción (los próximos primero).
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
      and (
        (v_ts is not null and to_tsvector('spanish', coalesce(e.title, '') || ' ' || coalesce(e.description, '')) @@ v_ts)
        or e.title ilike v_like escape '\'
        or coalesce(e.description, '') ilike v_like escape '\'
      )
    order by e.starts_at asc
    limit 8
  ) s;

  -- Personas: miembros del espacio por nombre visible.
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
    order by m.display_name asc
    limit 8
  ) s;

  -- Transcripciones listas: nota de voz de un chat accesible o dictado propio.
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
    where tr.workspace_id = p_ws
      and tr.status = 'ready'
      and coalesce(tr.text, '') <> ''
      and (
        (tr.message_id is not null and tr.chat_id is not null
          and public.can_access_chat(tr.workspace_id, tr.chat_id))
        or (tr.message_id is null and tr.requested_by = auth.uid())
      )
      and (
        (v_ts is not null and to_tsvector('spanish', coalesce(tr.text, '')) @@ v_ts)
        or tr.text ilike v_like escape '\'
      )
    order by tr.created_at desc
    limit 8
  ) s;

  -- Recuerdos compartidos y no sensibles (una clave nunca aparece en el
  -- buscador global).
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
      and (
        (v_ts is not null and to_tsvector('spanish', coalesce(m.content, '')) @@ v_ts)
        or m.content ilike v_like escape '\'
      )
    order by m.pinned desc, m.created_at desc
    limit 8
  ) s;

  return jsonb_build_object(
    'messages', v_messages,
    'tasks', v_tasks,
    'projects', v_projects,
    'events', v_events,
    'people', v_people,
    'transcriptions', v_transcriptions,
    'memories', v_memories
  );
end;
$$;

comment on function public.global_search(uuid, text) is
  'Búsqueda global del espacio para Cmd/Ctrl+K: 7 grupos de 8 (mensajes, tareas, proyectos, eventos, personas, transcripciones y recuerdos no sensibles). Solo miembros.';

-- -----------------------------------------------------------------------------
-- 7. Notificaciones tipo `memory` (+ preferencia por tipo)
-- -----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add check (type in (
  'mention', 'reply', 'reaction', 'task_assigned', 'task_due',
  'event_reminder', 'invite', 'ai_alert', 'list', 'poll', 'memory'
));

alter table public.notification_prefs
  add column if not exists memory boolean not null default true;

comment on column public.notification_prefs.memory is
  'Avisos de la memoria del espacio (recuerdo nuevo o por caducar). Los sensibles nunca notifican.';

-- -----------------------------------------------------------------------------
-- 8. Realtime (la lista se repinta sola) + privilegios
-- -----------------------------------------------------------------------------
do $mempub$
begin
  begin
    alter publication supabase_realtime add table public.space_memories;
  exception when others then
    raise notice 'space_memories sin realtime: %', sqlerrm;
  end;
end
$mempub$;

grant select, insert, update, delete on public.space_memories to authenticated;

grant execute on function public.search_space_memories(uuid, text, integer) to authenticated;
revoke execute on function public.search_space_memories(uuid, text, integer) from anon;

-- El aviso de caducidad lo corre pg_cron; anon y authenticated no lo ejecutan
-- (los usuarios leen, no escriben avisos).
revoke execute on function public.notify_expiring_memories() from anon, authenticated;

revoke execute on function public.notify_memory_saved() from anon, authenticated;

revoke execute on function public.space_memories_guard_source() from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 9. pg_cron: un tick diario, SQL barato (sin IA), dentro de un DO con
--    EXCEPTION para que `sb:reset` no se rompa si el entorno no lo trae.
-- -----------------------------------------------------------------------------
do $memcron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin job de recuerdos: %', sqlerrm;
    return;
  end;
  begin
    -- pg_cron instala sus funciones en el esquema `cron`.
    perform cron.unschedule('loki-memory-expiry');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule(
      'loki-memory-expiry',
      '15 9 * * *',
      'select public.notify_expiring_memories()'
    );
  exception when others then
    raise notice 'no se pudo programar el job de recuerdos: %', sqlerrm;
  end;
end
$memcron$;