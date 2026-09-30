-- =============================================================================
-- Loki · búsqueda global (Cmd/Ctrl+K) + presencia.
-- NUEVA migración: no toca las de T19 ni T22. Índices GIN en español,
-- RPC `global_search` y tabla `user_presence`.
--
-- Convenciones heredadas: snake_case, helpers SECURITY DEFINER con
-- search_path fijo, políticas comentadas en español, GRANTs explícitos.
-- Todo lo que puede fallar por entorno (unaccent/pg_trgm ausentes) va en
-- bloques con EXCEPTION para no romper `sb:reset`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensiones: unaccent (sin tildes: "camion" encuentra "camión") y
--    pg_trgm (trigramas para el ILIKE parcial "%cam%").
-- -----------------------------------------------------------------------------

do $ext_unaccent$
begin
  create extension if not exists unaccent;
exception when others then
  raise notice 'unaccent no disponible, la búsqueda sigue sin tildes normalizadas: %', sqlerrm;
end
$ext_unaccent$;

do $ext_trgm$
begin
  create extension if not exists pg_trgm;
exception when others then
  raise notice 'pg_trgm no disponible, la búsqueda sigue solo con tsvector: %', sqlerrm;
end
$ext_trgm$;

-- -----------------------------------------------------------------------------
-- 1. Índices GIN de expresión en español (menos invasivo: no se altera
--    ninguna tabla existente, solo índices de expresión).
--
--    Cada índice se intenta primero con unaccent y, si el entorno no lo
--    tiene, se reintenta sin él. Si tampoco hay pg_trgm/tsvector, aviso y
--    a otra cosa: la RPC `global_search` funciona igual (más lenta).
-- -----------------------------------------------------------------------------

-- Mensajes: texto del mensaje.
do $idx_messages$
begin
  begin
    create index if not exists messages_search_idx
      on public.messages using gin (to_tsvector('spanish', unaccent(coalesce(text, ''))));
  exception when others then
    create index if not exists messages_search_idx
      on public.messages using gin (to_tsvector('spanish', coalesce(text, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de mensajes: %', sqlerrm;
end
$idx_messages$;

do $idx_messages_trgm$
begin
  create index if not exists messages_trgm_idx
    on public.messages using gin (coalesce(text, '') gin_trgm_ops);
exception when others then
  raise notice 'sin índice de trigramas de mensajes: %', sqlerrm;
end
$idx_messages_trgm$;

-- Tareas: título + notas.
do $idx_tasks$
begin
  begin
    create index if not exists tasks_search_idx
      on public.tasks using gin (to_tsvector('spanish', unaccent(coalesce(title, '') || ' ' || coalesce(notes, ''))));
  exception when others then
    create index if not exists tasks_search_idx
      on public.tasks using gin (to_tsvector('spanish', coalesce(title, '') || ' ' || coalesce(notes, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de tareas: %', sqlerrm;
end
$idx_tasks$;

do $idx_tasks_trgm$
begin
  create index if not exists tasks_trgm_idx
    on public.tasks using gin ((coalesce(title, '') || ' ' || coalesce(notes, '')) gin_trgm_ops);
exception when others then
  raise notice 'sin índice de trigramas de tareas: %', sqlerrm;
end
$idx_tasks_trgm$;

-- Proyectos: nombre + descripción.
do $idx_projects$
begin
  begin
    create index if not exists projects_search_idx
      on public.projects using gin (to_tsvector('spanish', unaccent(coalesce(name, '') || ' ' || coalesce(description, ''))));
  exception when others then
    create index if not exists projects_search_idx
      on public.projects using gin (to_tsvector('spanish', coalesce(name, '') || ' ' || coalesce(description, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de proyectos: %', sqlerrm;
end
$idx_projects$;

do $idx_projects_trgm$
begin
  create index if not exists projects_trgm_idx
    on public.projects using gin ((coalesce(name, '') || ' ' || coalesce(description, '')) gin_trgm_ops);
exception when others then
  raise notice 'sin índice de trigramas de proyectos: %', sqlerrm;
end
$idx_projects_trgm$;

-- Eventos: título + descripción.
do $idx_events$
begin
  begin
    create index if not exists events_search_idx
      on public.events using gin (to_tsvector('spanish', unaccent(coalesce(title, '') || ' ' || coalesce(description, ''))));
  exception when others then
    create index if not exists events_search_idx
      on public.events using gin (to_tsvector('spanish', coalesce(title, '') || ' ' || coalesce(description, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de eventos: %', sqlerrm;
end
$idx_events$;

do $idx_events_trgm$
begin
  create index if not exists events_trgm_idx
    on public.events using gin ((coalesce(title, '') || ' ' || coalesce(description, '')) gin_trgm_ops);
exception when others then
  raise notice 'sin índice de trigramas de eventos: %', sqlerrm;
end
$idx_events_trgm$;

-- Personas: nombre visible de los miembros del espacio.
do $idx_members$
begin
  begin
    create index if not exists members_search_idx
      on public.workspace_members using gin (to_tsvector('spanish', unaccent(coalesce(display_name, ''))));
  exception when others then
    create index if not exists members_search_idx
      on public.workspace_members using gin (to_tsvector('spanish', coalesce(display_name, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de miembros: %', sqlerrm;
end
$idx_members$;

do $idx_profiles$
begin
  begin
    create index if not exists profiles_search_idx
      on public.profiles using gin (to_tsvector('spanish', unaccent(coalesce(display_name, ''))));
  exception when others then
    create index if not exists profiles_search_idx
      on public.profiles using gin (to_tsvector('spanish', coalesce(display_name, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de perfiles: %', sqlerrm;
end
$idx_profiles$;

-- -----------------------------------------------------------------------------
-- 2. global_search: una sola llamada para la paleta Cmd/Ctrl+K.
--
--    Devuelve un jsonb con 5 grupos (messages/tasks/projects/events/people),
--    8 resultados por grupo como máximo. La puerta es la membresía: sin ser
--    miembro del espacio no hay nada; los mensajes además pasan por
--    `can_access_chat` (los DMs ajenos quedan fuera).
-- -----------------------------------------------------------------------------

create or replace function public.global_search(p_ws uuid, p_q text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  -- Consulta recortada; con menos de 2 letras no se escanea nada.
  v_q text := btrim(coalesce(p_q, ''));
  -- ILIKE literal: los comodines %, _ y \ del usuario van escapados.
  v_like text;
  -- Consulta de texto completo en español; si falla, queda solo el ILIKE.
  v_ts tsquery;
  v_messages jsonb;
  v_tasks jsonb;
  v_projects jsonb;
  v_events jsonb;
  v_people jsonb;
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
      'people', '[]'::jsonb
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

  return jsonb_build_object(
    'messages', v_messages,
    'tasks', v_tasks,
    'projects', v_projects,
    'events', v_events,
    'people', v_people
  );
end;
$$;

comment on function public.global_search(uuid, text) is
  'Búsqueda global del espacio para Cmd/Ctrl+K: 5 grupos de 8 (mensajes de chats accesibles, tareas, proyectos, eventos y personas). Solo miembros.';

-- La RPC solo se ofrece a usuarios con sesión; anon se queda sin ella.
revoke execute on function public.global_search(uuid, text) from anon;
revoke execute on function public.global_search(uuid, text) from public;
grant execute on function public.global_search(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Presencia: una fila por usuario (latido + estado personalizado).
--
--    El "en línea ahora mismo" va por el canal Realtime Presence
--    `presence:{wsId}` (efímero); esta tabla guarda el latido (`last_seen`,
--    refrescado cada 60 s) y el estado personalizado (emoji + texto) para
--    mostrar "Última vez hace…" cuando alguien no está conectado.
-- -----------------------------------------------------------------------------

-- `profiles` no tiene last_seen: la presencia vive en su propia tabla.
create table if not exists public.user_presence (
  user_id uuid primary key references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  online boolean not null default false,
  last_seen timestamptz not null default now(),
  status_emoji text not null default '',
  status_text text not null default '' check (char_length(status_text) <= 120),
  updated_at timestamptz not null default now()
);

comment on table public.user_presence is
  'Presencia por usuario: latido (last_seen) y estado personalizado (emoji + texto). Una fila por usuario.';

-- updated_at automático (mismo trigger que el organizador).
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'touch_updated_at_user_presence'
  ) then
    create trigger touch_updated_at_user_presence
      before update on public.user_presence
      for each row execute function public.touch_updated_at();
  end if;
end
$$;

alter table public.user_presence enable row level security;

-- Leer: los miembros del espacio ven la presencia de su espacio…
drop policy if exists "presence: leer los del espacio" on public.user_presence;
create policy "presence: leer los del espacio"
  on public.user_presence for select to authenticated
  using (public.is_member(workspace_id));

-- …y cada uno siempre ve la suya (aunque cambie de espacio).
drop policy if exists "presence: ver la mia" on public.user_presence;
create policy "presence: ver la mia"
  on public.user_presence for select to authenticated
  using (user_id is not distinct from auth.uid());

-- Escribir: cada uno solo la suya (latido + estado propio).
drop policy if exists "presence: crear solo la mia" on public.user_presence;
create policy "presence: crear solo la mia"
  on public.user_presence for insert to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "presence: editar solo la mia" on public.user_presence;
create policy "presence: editar solo la mia"
  on public.user_presence for update to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

drop policy if exists "presence: borrar solo la mia" on public.user_presence;
create policy "presence: borrar solo la mia"
  on public.user_presence for delete to authenticated
  using (user_id is not distinct from auth.uid());

-- -----------------------------------------------------------------------------
-- 4. Privilegios (mismo criterio que T19: la puerta es la RLS)
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on public.user_presence to authenticated;

grant select on public.user_presence to anon;
