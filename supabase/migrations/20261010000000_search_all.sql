-- =============================================================================
-- Búsqueda total: que Cmd/Ctrl+K encuentre TODO lo que se guarda en Loki.
-- NUEVA migración: no toca las anteriores.
--
-- 1. workspace_search_settings: opción por espacio para el OCR de imágenes
--    (cuesta cuota, así que nace apagado y solo un admin lo enciende).
-- 2. message_attachments: índice consultable de adjuntos (nombre, tipo,
--    tamaño, ruta, mensaje, chat, espacio y texto extraído por OCR). Los
--    adjuntos viven en messages.attachments (jsonb); recorrer ese jsonb en
--    cada búsqueda no escala. Lo alimenta un trigger AFTER INSERT/UPDATE de
--    messages (nunca bloquea el envío: cada ítem va en su propio bloque con
--    EXCEPTION). La visibilidad es la del mensaje (can_access_chat: los DMs
--    ajenos quedan fuera con sus archivos y su OCR).
-- 3. OCR por eventos: al indexar una imagen con ruta de Storage, si el
--    espacio tiene el OCR activado, se encola UN trabajo `ocr_image` en
--    ai_jobs (el trigger `wake_ai_worker` ya existente despierta a
--    loki-worker por pg_net). Sin OCR activado, o sin autor al que cargarle
--    la cuota, no se encola nada y la imagen se encuentra solo por nombre.
-- 4. global_search(): misma firma + parámetros opcionales con default (las
--    llamadas viejas con (p_ws, p_q) siguen funcionando). Grupos nuevos:
--    lists, list_items, polls, ideas y attachments. Filtros: p_types (chips
--    por tipo), p_chat (fragmento del nombre del chat), p_author (fragmento
--    del autor, "de: Sofi"), p_mine ("solo míos") y p_from/p_to (rango de
--    fechas, "la semana pasada"). p_limit (1-20, default 8) por grupo.
-- 5. search_more(): paginado "ver más" por grupo (misma puerta y mismos
--    filtros, con p_offset).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ajustes de búsqueda por espacio (el OCR cuesta: apagado por defecto)
-- -----------------------------------------------------------------------------
create table if not exists public.workspace_search_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  ocr_enabled boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.workspace_search_settings is
  'Ajustes de búsqueda por espacio. ocr_enabled: extraer el texto de las imágenes (cuesta cuota de IA).';

comment on column public.workspace_search_settings.ocr_enabled is
  'Si es true, cada imagen subida encola un trabajo ocr_image. Nace en false.';

drop trigger if exists workspace_search_settings_touch_updated_at
  on public.workspace_search_settings;
create trigger workspace_search_settings_touch_updated_at
  before update on public.workspace_search_settings
  for each row execute function public.touch_updated_at();

alter table public.workspace_search_settings enable row level security;

-- Leer: cualquier miembro (la UI muestra el interruptor solo a admins).
drop policy if exists "ajustes busqueda: leer mi espacio"
  on public.workspace_search_settings;
create policy "ajustes busqueda: leer mi espacio"
  on public.workspace_search_settings for select to authenticated
  using (public.is_member(workspace_id));

-- Escribir: solo admins del espacio, siempre a nombre propio.
drop policy if exists "ajustes busqueda: editar admins"
  on public.workspace_search_settings;
create policy "ajustes busqueda: editar admins"
  on public.workspace_search_settings for insert to authenticated
  with check (
    public.is_space_admin(workspace_id)
    and updated_by is not distinct from auth.uid()
  );

drop policy if exists "ajustes busqueda: actualizar admins"
  on public.workspace_search_settings;
create policy "ajustes busqueda: actualizar admins"
  on public.workspace_search_settings for update to authenticated
  using (public.is_space_admin(workspace_id))
  with check (
    public.is_space_admin(workspace_id)
    and updated_by is not distinct from auth.uid()
  );

-- -----------------------------------------------------------------------------
-- 2. Índice de adjuntos (una fila por archivo de cada mensaje)
-- -----------------------------------------------------------------------------
create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  chat_id text not null check (char_length(chat_id) between 1 and 64),
  message_id uuid not null references public.messages (id) on delete cascade,
  -- Bucket y ruta DENTRO del bucket. Null en adjuntos viejos sin path: se
  -- indexan igual por nombre, pero sin OCR posible.
  bucket text check (bucket is null or bucket in ('chat-media', 'post-media')),
  object_path text check (object_path is null or char_length(object_path) between 4 and 400),
  name text not null default 'archivo' check (char_length(name) between 1 and 200),
  mime text not null default 'application/octet-stream' check (char_length(mime) between 1 and 120),
  kind text not null default 'file' check (kind in ('image', 'video', 'audio', 'file')),
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  author_id uuid references auth.users (id) on delete set null,
  author_name text not null default '',
  -- Texto extraído por OCR (solo imágenes con ruta, bajo demanda por evento).
  ocr_text text not null default '' check (char_length(ocr_text) <= 8000),
  ocr_status text not null default 'none'
    check (ocr_status in ('none', 'pending', 'ready', 'error', 'skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- El espacio del archivo es el primer segmento de la ruta (helper de T19).
  constraint message_attachments_workspace_path
    check (object_path is null or public.storage_workspace_id(object_path) = workspace_id)
);

comment on table public.message_attachments is
  'Índice buscable de adjuntos (nombre, tipo, ruta y texto OCR). Lo mantiene el trigger sync_message_attachments.';

-- Un mensaje no indexa dos veces el mismo archivo.
create unique index if not exists message_attachments_msg_path_uidx
  on public.message_attachments (message_id, object_path)
  where object_path is not null;

create index if not exists message_attachments_ws_idx
  on public.message_attachments (workspace_id, created_at desc);

create index if not exists message_attachments_message_idx
  on public.message_attachments (message_id);

drop trigger if exists message_attachments_touch_updated_at on public.message_attachments;
create trigger message_attachments_touch_updated_at
  before update on public.message_attachments
  for each row execute function public.touch_updated_at();

-- Índices de texto (mismo criterio que 20260930000003_search.sql: primero con
-- unaccent, si el entorno no lo tiene se reintenta sin él).
do $idx_att_text$
begin
  begin
    create index if not exists message_attachments_search_idx
      on public.message_attachments
      using gin (to_tsvector('spanish', unaccent(coalesce(name, '') || ' ' || coalesce(ocr_text, ''))));
  exception when others then
    create index if not exists message_attachments_search_idx
      on public.message_attachments
      using gin (to_tsvector('spanish', coalesce(name, '') || ' ' || coalesce(ocr_text, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de adjuntos: %', sqlerrm;
end
$idx_att_text$;

do $idx_att_trgm$
begin
  create index if not exists message_attachments_trgm_idx
    on public.message_attachments using gin (coalesce(name, '') gin_trgm_ops);
exception when others then
  raise notice 'sin índice de trigramas de adjuntos: %', sqlerrm;
end
$idx_att_trgm$;

alter table public.message_attachments enable row level security;

-- Leer: la MISMA visibilidad que el mensaje (can_access_chat deja fuera los
-- DMs ajenos, con sus archivos, transcripciones y OCR). Sin políticas de
-- escritura para el cliente: el índice lo escribe el trigger y el OCR el
-- worker con la service role.
drop policy if exists "adjuntos: leer los del chat que veo"
  on public.message_attachments;
create policy "adjuntos: leer los del chat que veo"
  on public.message_attachments for select to authenticated
  using (
    public.is_member(workspace_id)
    and public.can_access_chat(workspace_id, chat_id)
  );

-- -----------------------------------------------------------------------------
-- 3. Sincronización messages.attachments (jsonb) -> message_attachments
-- -----------------------------------------------------------------------------
create or replace function public.sync_message_attachments()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_kind text;
  v_name text;
  v_mime text;
  v_size bigint;
  v_path text;
  v_bucket text;
  v_object text;
begin
  if tg_op = 'UPDATE' and new.attachments = old.attachments then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    -- Reindexado completo del mensaje (los adjuntos no se editan por
    -- cliente, pero la service role puede corregirlos).
    delete from public.message_attachments where message_id = old.id;
  end if;
  -- Cinturón y tirantes: el CHECK de messages ya exige un array, pero un
  -- adjunto raro nunca frena el mensaje.
  if jsonb_typeof(coalesce(new.attachments, '[]'::jsonb)) <> 'array' then
    return null;
  end if;
  for v_item in
    select elem
    from jsonb_array_elements(coalesce(new.attachments, '[]'::jsonb)) as elem
    where jsonb_typeof(elem) = 'object'
  loop
    begin
      v_kind := coalesce(v_item ->> 'kind', 'file');
      if v_kind not in ('image', 'video', 'audio', 'file') then
        continue;
      end if;
      v_name := left(nullif(btrim(coalesce(v_item ->> 'name', '')), ''), 200);
      if v_name is null then v_name := 'archivo'; end if;
      v_mime := left(coalesce(nullif(v_item ->> 'mime', ''), 'application/octet-stream'), 120);
      begin
        v_size := coalesce((v_item ->> 'size')::bigint, 0);
        if v_size < 0 then v_size := 0; end if;
      exception when others then
        v_size := 0;
      end;
      -- El path del adjunto es `{bucket}/{workspace_id}/…`: se parte en
      -- bucket + ruta dentro del bucket. Sin esa forma, se indexa por
      -- nombre (sin OCR posible).
      v_path := v_item ->> 'path';
      v_bucket := null;
      v_object := null;
      if v_path is not null
        and (v_path like 'chat-media/%' or v_path like 'post-media/%')
        and public.storage_workspace_id(split_part(v_path, '/', 2)) is not null
      then
        v_bucket := split_part(v_path, '/', 1);
        v_object := substr(v_path, char_length(v_bucket) + 2);
      end if;
      insert into public.message_attachments
        (workspace_id, chat_id, message_id, bucket, object_path,
         name, mime, kind, size_bytes, author_id, author_name,
         ocr_status)
      values
        (new.workspace_id, new.chat_id, new.id, v_bucket, v_object,
         v_name, v_mime, v_kind, v_size, new.author_id, new.author_name,
         case when v_kind = 'image' and v_object is not null then 'pending' else 'none' end)
      on conflict do nothing;
    exception when others then
      -- Un adjunto raro nunca frena el mensaje: se salta y sigue.
      continue;
    end;
  end loop;
  return null;
end;
$$;

comment on function public.sync_message_attachments() is
  'Indexa messages.attachments en message_attachments (nunca bloquea el envío).';

drop trigger if exists sync_message_attachments_ins on public.messages;
create trigger sync_message_attachments_ins
  after insert on public.messages
  for each row
  when (new.attachments is not null and new.attachments <> '[]'::jsonb)
  execute function public.sync_message_attachments();

drop trigger if exists sync_message_attachments_upd on public.messages;
create trigger sync_message_attachments_upd
  after update of attachments on public.messages
  for each row execute function public.sync_message_attachments();

-- -----------------------------------------------------------------------------
-- 4. OCR por eventos (solo imágenes con ruta, solo si el espacio lo activó)
-- -----------------------------------------------------------------------------
create or replace function public.enqueue_image_ocr()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean := false;
begin
  -- Sin autor no hay a quién cargarle la cuota: queda pendiente por nombre.
  if new.author_id is null then
    return null;
  end if;
  select ocr_enabled into v_enabled
    from public.workspace_search_settings
   where workspace_id = new.workspace_id;
  if coalesce(v_enabled, false) = false then
    return null;
  end if;
  begin
    insert into public.ai_jobs (workspace_id, requested_by, type, payload, idempotency_key)
    values (
      new.workspace_id,
      new.author_id,
      'ocr_image',
      jsonb_build_object('attachment_id', new.id),
      'ocr:' || new.id::text
    )
    on conflict (workspace_id, idempotency_key) do nothing;
  exception when others then
    -- Encolar nunca rompe la subida: la imagen se encuentra por nombre.
    null;
  end;
  return null;
end;
$$;

comment on function public.enqueue_image_ocr() is
  'Encola UN trabajo ocr_image por imagen indexada (solo si el espacio activó el OCR).';

drop trigger if exists enqueue_image_ocr on public.message_attachments;
create trigger enqueue_image_ocr
  after insert on public.message_attachments
  for each row
  when (new.kind = 'image' and new.object_path is not null and new.ocr_status = 'pending')
  execute function public.enqueue_image_ocr();

-- -----------------------------------------------------------------------------
-- 5. global_search con TODO + filtros (misma firma + opcionales con default)
--
-- Grupos: messages, transcriptions, memories, tasks, projects, events,
-- people, lists, list_items, polls, ideas y attachments (12).
-- Filtros: p_types (chips), p_chat (fragmento del nombre del chat, solo
-- grupos ligados a un chat), p_author (fragmento del autor, "de: Sofi"),
-- p_mine ("solo míos"), p_from/p_to (rango de fechas) y p_limit (1-20).
-- La puerta sigue siendo la membresía + can_access_chat en lo ligado a
-- chats (DMs ajenos fuera, con archivos, transcripciones y OCR). Los
-- recuerdos sensibles, privados y caducados siguen fuera del global.
--
-- La versión de 2 parámetros (7 grupos) se retira: la nueva cubre las
-- llamadas viejas con sus defaults.
-- -----------------------------------------------------------------------------
drop function if exists public.global_search(uuid, text);

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
            and public.can_access_chat(tr.workspace_id, tr.chat_id))
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
          (v_ts is not null and to_tsvector('spanish', coalesce(a.name, '') || ' ' || coalesce(a.ocr_text, '')) @@ v_ts)
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

comment on function public.global_search(uuid, text, text[], text, text, boolean, timestamptz, timestamptz, integer) is
  'Búsqueda global del espacio: 12 grupos (mensajes, tareas, proyectos, eventos, personas, transcripciones, recuerdos no sensibles, listas, ítems, encuestas, ideas y adjuntos con OCR). Filtros por tipo, chat, autor, solo míos y fechas. Solo miembros; DMs ajenos fuera.';

revoke execute on function public.global_search(uuid, text, text[], text, text, boolean, timestamptz, timestamptz, integer) from anon;
revoke execute on function public.global_search(uuid, text, text[], text, text, boolean, timestamptz, timestamptz, integer) from public;
grant execute on function public.global_search(uuid, text, text[], text, text, boolean, timestamptz, timestamptz, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. search_more: "ver más" paginado de UN grupo (misma puerta y filtros)
-- -----------------------------------------------------------------------------
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
          and public.can_access_chat(tr.workspace_id, tr.chat_id))
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
        and ((v_ts is not null and to_tsvector('spanish', coalesce(a.name, '') || ' ' || coalesce(a.ocr_text, '')) @@ v_ts)
          or a.name ilike v_like escape '\' or coalesce(a.ocr_text, '') ilike v_like escape '\')
      order by a.created_at desc limit v_lim offset v_off
    ) s;
  end if;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

comment on function public.search_more(uuid, text, text, integer, integer, text, text, boolean, timestamptz, timestamptz) is
  'Paginado "ver más" de un grupo de la búsqueda global (misma puerta y filtros que global_search).';

revoke execute on function public.search_more(uuid, text, text, integer, integer, text, text, boolean, timestamptz, timestamptz) from anon;
revoke execute on function public.search_more(uuid, text, text, integer, integer, text, text, boolean, timestamptz, timestamptz) from public;
grant execute on function public.search_more(uuid, text, text, integer, integer, text, text, boolean, timestamptz, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Realtime (el índice y los ajustes se repintan solos) + privilegios
-- -----------------------------------------------------------------------------
do $searchpub$
begin
  begin
    alter publication supabase_realtime add table public.message_attachments;
  exception when others then
    raise notice 'message_attachments sin realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.workspace_search_settings;
  exception when others then
    raise notice 'workspace_search_settings sin realtime: %', sqlerrm;
  end;
end
$searchpub$;

grant select on public.message_attachments to authenticated;
grant select, insert, update on public.workspace_search_settings to authenticated;

-- ai_jobs ya admite 'ocr_image' (el CHECK lo trae desde la infra de IA y lo
-- conservan las migraciones de digest y encuestas): nada que cambiar.
