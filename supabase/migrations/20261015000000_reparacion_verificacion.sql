-- =============================================================================
-- Reparación de verificación (etapas 1-3): corrige lo que el `sb:reset` en
-- fresco y los tests RLS destaparon, SIN tocar las migraciones anteriores.
--
-- 1. Agentes: "concesiones: el dueño gestiona las suyas" consultaba
--    agent_connections, cuyas políticas consultan agent_space_grants:
--    recursión infinita (42P17) en cada lectura. Se usa el helper SECURITY
--    DEFINER agent_connection_owner (no pasa por RLS) en vez del EXISTS
--    directo. Las políticas de connections quedan igual.
-- 2. Encuestas: poll_electors devuelve setof uuid (la columna se llama
--    "poll_electors") y poll_results + create_poll_reminders la leían como
--    e.user_id (42703: ni el resultado, ni los avisos "falta tu voto", ni el
--    conteo de miembros funcionaban). Se pone alias de columna e(user_id).
-- 3. Transcripciones y OCR: `on conflict (workspace_id, idempotency_key)`
--    no casa con el índice único PARCIAL ai_jobs_idempotency_uidx (42P10: el
--    trigger rompía cada insert de audio_transcriptions y el OCR nunca
--    encolaba). Se añade el predicado que casa con el índice parcial.
-- 4. Memoria: memory_query_terms no quitaba "cuál/cuándo/..." con tilde (la
--    lista solo traía las formas sin tilde). Se agregan las formas con tilde.
-- 5. Dispositivos: el PC revocado seguía leyendo su ficha y sus comandos
--    (las políticas del dispositivo no miraban revoked_at). Se exige
--    device_is_active en las dos.
--
-- Convenciones heredadas: snake_case, SECURITY DEFINER con search_path fijo,
-- DROP POLICY IF EXISTS + CREATE POLICY, sin dependencias del entorno fuera
-- de bloques DO (aquí no hay ninguna: todo es SQL puro re-ejecutable).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Grants de agentes sin recursión
-- -----------------------------------------------------------------------------

drop policy if exists "concesiones: el dueño gestiona las suyas"
  on public.agent_space_grants;
create policy "concesiones: el dueño gestiona las suyas"
  on public.agent_space_grants for all to authenticated
  using (
    public.agent_connection_owner(agent_space_grants.connection_id)
      is not distinct from auth.uid()
  )
  with check (
    public.agent_connection_owner(agent_space_grants.connection_id)
      is not distinct from auth.uid()
  );

comment on function public.agent_connection_owner(uuid) is
  'Dueño de una conexión de agente (interno de RLS, sin recursión: SECURITY DEFINER).';

-- -----------------------------------------------------------------------------
-- 2. Encuestas: alias de columna para poll_electors
-- -----------------------------------------------------------------------------

create or replace function public.poll_results(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll public.polls%rowtype;
  v_uid uuid := auth.uid();
  v_anon boolean;
  v_options jsonb;
  v_max integer := 0;
  v_winners jsonb;
  v_missing jsonb;
  v_voters integer := 0;
  v_members integer := 0;
begin
  if v_uid is null then
    raise exception 'Hay que iniciar sesión'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_poll from public.polls where id = p_poll_id;
  if v_poll.id is null then
    raise exception 'Esa encuesta ya no existe' using errcode = 'no_data_found';
  end if;
  if not public.can_access_chat(v_poll.workspace_id, v_poll.chat_id) then
    raise exception 'No tienes acceso a ese chat'
      using errcode = 'insufficient_privilege';
  end if;

  -- Cierre por tiempo al leer (SQL barato): la tarjeta nunca sale "abierta"
  -- con el plazo vencido aunque el job no haya pasado todavía.
  if v_poll.closed_at is null
     and v_poll.closes_at is not null
     and v_poll.closes_at <= now()
  then
    perform set_config('loki.poll_write', 'on', true);
    update public.polls set closed_at = now(), closed_by = v_uid where id = v_poll.id;
    select * into v_poll from public.polls where id = p_poll_id;
  end if;

  v_anon := public.poll_flag(v_poll.settings, 'anonymous', false);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', o.id,
        'text', o.text,
        'startsAt', o.starts_at,
        'endsAt', o.ends_at,
        'position', o.position,
        'addedBy', o.added_by,
        'votes', coalesce(t.votes, 0),
        'mine', coalesce(t.mine, false),
        'voters', case
          when v_anon then '[]'::jsonb
          else coalesce(t.voters, '[]'::jsonb)
        end
      )
      order by o.position, o.created_at, o.id
    ),
    '[]'::jsonb
  ) into v_options
    from public.poll_options o
    left join lateral (
      select count(*)::int as votes,
             coalesce(bool_or(v.user_id = v_uid), false) as mine,
             coalesce(
               jsonb_agg(v.user_id order by v.created_at, v.id)
                 filter (where v.user_id is not null),
               '[]'::jsonb
             ) as voters
        from public.poll_votes v
       where v.option_id = o.id
    ) t on true
   where o.poll_id = v_poll.id;

  select coalesce(max(coalesce((elem ->> 'votes')::int, 0)), 0) into v_max
    from jsonb_array_elements(v_options) elem;

  select coalesce(
    jsonb_agg(elem ->> 'id' order by elem ->> 'id'),
    '[]'::jsonb
  ) into v_winners
    from jsonb_array_elements(v_options) elem
   where coalesce((elem ->> 'votes')::int, 0) = v_max;

  -- Un empate no se resuelve solo: lo muestra y decide quien creó la encuesta.
  if v_max = 0 or jsonb_array_length(v_winners) <> 1 then
    v_winners := '[]'::jsonb;
  end if;

  select count(*)::int into v_members
    from public.poll_electors(v_poll.workspace_id, v_poll.chat_id);

  select count(distinct user_id)::int into v_voters
    from public.poll_votes where poll_id = v_poll.id;

  -- Quién falta por votar solo si NO es anónima (en las anónimas contarlo ya
  -- diría quién votó por descarte). poll_electors devuelve setof uuid: el
  -- alias e(user_id) nombra la columna (sin él, 42703).
  if v_anon then
    v_missing := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(e.user_id), '[]'::jsonb) into v_missing
      from public.poll_electors(v_poll.workspace_id, v_poll.chat_id) as e(user_id)
     where not exists (
       select 1 from public.poll_votes v
        where v.poll_id = v_poll.id and v.user_id = e.user_id
     );
  end if;

  return jsonb_build_object(
    'id', v_poll.id,
    'messageId', v_poll.message_id,
    'workspaceId', v_poll.workspace_id,
    'chatId', v_poll.chat_id,
    'question', v_poll.question,
    'kind', v_poll.kind,
    'settings', v_poll.settings,
    'closesAt', v_poll.closes_at,
    'closedAt', v_poll.closed_at,
    'closedBy', v_poll.closed_by,
    'createdBy', v_poll.created_by,
    'createdAt', v_poll.created_at,
    'anonymous', v_anon,
    'allowSuggestions', public.poll_flag(v_poll.settings, 'allowSuggestions', true),
    'remindMissing', public.poll_flag(v_poll.settings, 'remindMissing', false),
    'closeBy', coalesce(v_poll.settings ->> 'closeBy', 'creator'),
    'isOpen', v_poll.closed_at is null,
    'canManage', public.poll_can_manage(v_poll.id),
    'canSuggest', public.poll_can_suggest(v_poll.id),
    'options', v_options,
    'maxVotes', v_max,
    'winners', v_winners,
    'tied', v_max > 0 and jsonb_array_length(v_winners) = 0,
    'totalVotes', v_voters,
    'membersCount', v_members,
    'missingCount', greatest(v_members - v_voters, 0),
    'missing', v_missing
  );
end;
$$;

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

-- -----------------------------------------------------------------------------
-- 3. Encolado de transcripción y OCR: el ON CONFLICT casa con el índice parcial
-- -----------------------------------------------------------------------------

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
  on conflict (workspace_id, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning id into v_job;
  return v_job;
end;
$$;

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
    on conflict (workspace_id, idempotency_key)
      where idempotency_key is not null
      do nothing;
  exception when others then
    -- Encolar nunca rompe la subida: la imagen se encuentra por nombre.
    null;
  end;
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Memoria: las interrogativas con tilde también son "palabras sin sentido"
-- -----------------------------------------------------------------------------

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
        'para', 'con', 'sin', 'sobre', 'entre', 'mis', 'nuestro',
        'cuál', 'cuáles', 'cuándo', 'dónde', 'quién', 'cómo', 'aquí', 'está'
      ])
  ) t;
$$;

-- -----------------------------------------------------------------------------
-- 5. Dispositivos: revocar bloquea la lectura al instante
-- -----------------------------------------------------------------------------

drop policy if exists "dispositivos: el dispositivo ve su ficha"
  on public.user_devices;
create policy "dispositivos: el dispositivo ve su ficha"
  on public.user_devices for select to authenticated
  using (
    id is not distinct from public.my_device_id()
    and public.device_is_active(id)
  );

drop policy if exists "comandos: el dispositivo ve los suyos"
  on public.device_commands;
create policy "comandos: el dispositivo ve los suyos"
  on public.device_commands for select to authenticated
  using (
    device_id is not distinct from public.my_device_id()
    and public.device_is_active(device_id)
  );
