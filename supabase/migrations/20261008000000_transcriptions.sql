-- =============================================================================
-- Transcripciones de notas de voz (bajo demanda) + índice para la búsqueda.
-- NUEVA migración: no toca las anteriores.
--
-- Por qué una tabla y no un trabajo suelto: la transcripción es un dato que se
-- lee, se busca y hereda la visibilidad del mensaje. Un trabajo de `ai_jobs`
-- morrería con su resultado.
--
-- 1. audio_transcriptions: una fila por archivo de audio ya subido a Storage
--    (ruta `{workspace_id}/{uuid}-{nombre}` en `chat-media` o `post-media`).
--    Un CHECK exige que el PRIMER segmento de la ruta sea el workspace_id: por
--    eso la RLS del INSERT (ser miembro de ESE espacio) es la verificación de
--    "quien pide la transcripción es miembro del espacio del archivo".
-- 2. Visibilidad: hereda la del mensaje (`can_access_chat`, así en un DM solo
--    sus miembros). Un dictado suelto (message_id null) solo lo ve quien lo
--    grabó.
-- 3. Encolado por evento: el AFTER INSERT mete el trabajo en `ai_jobs`
--    (type 'transcribe_audio') y el trigger `wake_ai_worker` existente lo
--    despierta por pg_net. Nada escucha: duerme hasta que alguien abre
--    "Ver transcripción" (o dicta a Loki).
-- 4. retry_transcription(): reencola un fallo (quien lo pidió o un admin).
-- 5. global_search(): se reemplaza por la misma firma con un grupo más
--    (`transcriptions`), para que el texto dictado se encuentre en Cmd/Ctrl+K.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tabla de transcripciones
-- -----------------------------------------------------------------------------
create table if not exists public.audio_transcriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  bucket text not null default 'chat-media' check (bucket in ('chat-media', 'post-media')),
  -- Ruta del objeto en Storage SIN el bucket: `{workspace_id}/{uuid}-{nombre}`.
  object_path text not null check (char_length(object_path) between 4 and 400),
  -- Mensaje que lleva el audio. Con mensaje, la transcripción es de todos los
  -- que pueden leerlo; sin mensaje (dictado a Loki) es privada de quien habló.
  message_id uuid references public.messages (id) on delete cascade,
  chat_id text check (chat_id is null or char_length(chat_id) between 1 and 64),
  author_id uuid references auth.users (id) on delete set null,
  requested_by uuid references auth.users (id) on delete set null,
  text text not null default '' check (char_length(text) <= 16000),
  language text not null default '' check (char_length(language) <= 16),
  duration_seconds double precision
    check (duration_seconds is null or duration_seconds >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'ready', 'error')),
  -- 'openai' | 'gemini' (lo que se usó; '' si no llegó a transcribir).
  provider text not null default '' check (char_length(provider) <= 40),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- El espacio del archivo es el primer segmento de la ruta (helper de T19).
  constraint audio_transcriptions_workspace_path
    check (public.storage_workspace_id(object_path) = workspace_id),
  -- Con mensaje siempre hay chat: es lo que evalúa can_access_chat.
  constraint audio_transcriptions_message_chat
    check (message_id is null or chat_id is not null)
);

comment on table public.audio_transcriptions is
  'Transcripciones de notas de voz y dictados, una por archivo de audio. Solo se hacen bajo demanda (Ver transcripción / Dictar a Loki).';

comment on column public.audio_transcriptions.object_path is
  'Ruta en Storage sin el bucket: {workspace_id}/{uuid}-{nombre}. El primer segmento debe ser el workspace_id.';

-- Un archivo, una transcripción: abrirla de nuevo no vuelve a pagar.
create unique index if not exists audio_transcriptions_path_uidx
  on public.audio_transcriptions (workspace_id, object_path);

create index if not exists audio_transcriptions_ws_idx
  on public.audio_transcriptions (workspace_id, created_at desc);

create index if not exists audio_transcriptions_message_idx
  on public.audio_transcriptions (message_id)
  where message_id is not null;

-- updated_at automático (mismo trigger que el resto).
drop trigger if exists audio_transcriptions_touch_updated_at on public.audio_transcriptions;
create trigger audio_transcriptions_touch_updated_at
  before update on public.audio_transcriptions
  for each row execute function public.touch_updated_at();

-- Índices de texto para la búsqueda (mismo criterio que 20260930000003_search.sql:
-- primero con unaccent, si el entorno no lo tiene se reintenta sin él).
do $idx_tr_text$
begin
  begin
    create index if not exists audio_transcriptions_search_idx
      on public.audio_transcriptions
      using gin (to_tsvector('spanish', unaccent(coalesce(text, ''))));
  exception when others then
    create index if not exists audio_transcriptions_search_idx
      on public.audio_transcriptions
      using gin (to_tsvector('spanish', coalesce(text, '')));
  end;
exception when others then
  raise notice 'sin índice GIN de transcripciones: %', sqlerrm;
end
$idx_tr_text$;

do $idx_tr_trgm$
begin
  create index if not exists audio_transcriptions_trgm_idx
    on public.audio_transcriptions using gin (coalesce(text, '') gin_trgm_ops);
exception when others then
  raise notice 'sin índice de trigramas de transcripciones: %', sqlerrm;
end
$idx_tr_trgm$;

alter table public.audio_transcriptions enable row level security;

-- Leer: la nota de voz de un chat con la MISMA visibilidad que su mensaje
-- (can_access_chat deja fuera los DMs ajenos); el dictado suelto, solo suyo.
drop policy if exists "transcripciones: leer las que me tocan"
  on public.audio_transcriptions;
create policy "transcripciones: leer las que me tocan"
  on public.audio_transcriptions for select to authenticated
  using (
    public.is_member(workspace_id)
    and (
      (message_id is not null and chat_id is not null
        and public.can_access_chat(workspace_id, chat_id))
      or (message_id is null and requested_by is not distinct from auth.uid())
    )
  );

-- Pedir: miembro del espacio del ARCHIVO (el CHECK ata la ruta al workspace)
-- y siempre a nombre propio. Ni update ni delete de cliente: el ciclo lo mueve
-- la service role (worker) y el reintento pasa por retry_transcription().
drop policy if exists "transcripciones: pedir en mi espacio"
  on public.audio_transcriptions;
create policy "transcripciones: pedir en mi espacio"
  on public.audio_transcriptions for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and requested_by is not distinct from auth.uid()
  );

-- -----------------------------------------------------------------------------
-- 2. Encolado por evento (insert -> ai_jobs -> pg_net -> loki-worker)
-- -----------------------------------------------------------------------------

-- Deja UN trabajo vivo por transcripción (borra los anteriores: así el
-- reintento no choca con el idempotency_key). Devuelve el id o null.
create or replace function public.enqueue_transcription(p_transcription_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.audio_transcriptions%rowtype;
  v_job uuid;
begin
  select * into v_row
    from public.audio_transcriptions
   where id = p_transcription_id;
  if v_row.id is null then return null; end if;

  delete from public.ai_jobs
   where workspace_id = v_row.workspace_id
     and type = 'transcribe_audio'
     and payload->>'transcription_id' = v_row.id::text;

  insert into public.ai_jobs (workspace_id, requested_by, type, payload, idempotency_key)
  values (
    v_row.workspace_id,
    v_row.requested_by,
    'transcribe_audio',
    jsonb_build_object('transcription_id', v_row.id),
    'transcribe:' || v_row.id::text
  )
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_job;
  return v_job;
end;
$$;

comment on function public.enqueue_transcription(uuid) is
  'Encola (o reencola) el trabajo de transcripción de una fila. Solo interno: la usan el trigger y retry_transcription.';

-- Tras cada transcripción pedida se inserta el trabajo; el trigger
-- `wake_ai_worker` que ya existe en ai_jobs lo despierta por pg_net.
create or replace function public.audio_transcriptions_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.enqueue_transcription(new.id);
  return null;
end;
$$;

drop trigger if exists audio_transcriptions_enqueue on public.audio_transcriptions;
create trigger audio_transcriptions_enqueue
  after insert on public.audio_transcriptions
  for each row execute function public.audio_transcriptions_enqueue();

-- Reintento manual: quien lo pidió o un admin del espacio.
create or replace function public.retry_transcription(p_transcription_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.audio_transcriptions%rowtype;
begin
  select * into v_row
    from public.audio_transcriptions
   where id = p_transcription_id;
  if v_row.id is null then return false; end if;
  if v_row.requested_by is distinct from auth.uid()
     and not public.is_space_admin(v_row.workspace_id) then
    raise exception 'Solo quien pidió la transcripción o un admin del espacio puede reintentarla'
      using errcode = 'insufficient_privilege';
  end if;
  if v_row.status <> 'error' then return false; end if;
  update public.audio_transcriptions
     set status = 'pending', error = null
   where id = p_transcription_id;
  perform public.enqueue_transcription(p_transcription_id);
  return true;
end;
$$;

comment on function public.retry_transcription(uuid) is
  'Reencola la transcripción de un audio que falló (quien lo pidió o un admin).';

-- -----------------------------------------------------------------------------
-- 3. global_search con el grupo `transcriptions` (misma firma, un grupo más)
--
-- Copia de 20260930000003_search.sql + el grupo nuevo. Es SECURITY DEFINER,
-- así que aquí se repiten a mano las mismas condiciones que la RLS de la tabla
-- (si no, una transcripción de un DM ajeno se colaría en la búsqueda).
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
      'transcriptions', '[]'::jsonb
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

  return jsonb_build_object(
    'messages', v_messages,
    'tasks', v_tasks,
    'projects', v_projects,
    'events', v_events,
    'people', v_people,
    'transcriptions', v_transcriptions
  );
end;
$$;

comment on function public.global_search(uuid, text) is
  'Búsqueda global del espacio para Cmd/Ctrl+K: 6 grupos de 8 (mensajes de chats accesibles, tareas, proyectos, eventos, personas y transcripciones). Solo miembros.';

-- -----------------------------------------------------------------------------
-- 4. Realtime (la UI ve el estado sin consultar en bucle) + privilegios
-- -----------------------------------------------------------------------------
do $trpub$
begin
  begin
    alter publication supabase_realtime add table public.audio_transcriptions;
  exception when others then
    raise notice 'no se pudo publicar audio_transcriptions en realtime: %', sqlerrm;
  end;
end
$trpub$;

grant select, insert on public.audio_transcriptions to authenticated;

grant execute on function public.retry_transcription(uuid) to authenticated;
-- enqueue_transcription es interna (trigger + retry): nadie la llama directo.
revoke execute on function public.enqueue_transcription(uuid) from public;
revoke execute on function public.enqueue_transcription(uuid) from anon;
revoke execute on function public.enqueue_transcription(uuid) from authenticated;

revoke execute on function public.global_search(uuid, text) from anon;
revoke execute on function public.global_search(uuid, text) from public;
grant execute on function public.global_search(uuid, text) to authenticated;
