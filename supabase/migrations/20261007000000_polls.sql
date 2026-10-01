-- =============================================================================
-- Encuestas dentro del chat (polls) + cruce con el calendario.
-- NUEVA migración: no toca las anteriores.
--
-- 1. polls: la encuesta vive pegada a un mensaje 'card' (meta = {kind:"poll",
--    poll_id}). Tipos: 'single' (una opción), 'multiple', 'yesno' (rápido) y
--    'date' (opciones con fecha y hora). `settings` jsonb guarda los ajustes
--    (anónima, suggestions, recordatorio y quién puede cerrar).
-- 2. poll_options: texto o rango de fecha (starts_at/ends_at) + position.
--    `added_by` para saber quién propuso cada opción.
-- 3. poll_votes: una fila por (encuesta, opción, usuario). En 'single' y
--    'yesno' el trigger de guarda deja un solo voto por persona (cambiar de
--    opción es borrar la anterior, nunca acumular).
-- 4. Privacidad de las anónimas: la política de SELECT de poll_votes NO deja
--    ver los votos de una encuesta anónima (salvo los propios) y el conteo se
--    lee con la RPC `poll_results`, que devuelve los uids solo si no es
--    anónima. Así la RLS es la puerta y la RPC no filtra.
-- 5. Encuestas de fecha: `poll_option_busy` cuenta cuántos miembros ya tienen
--    algo agendado en `events` a esa hora. Solo "ocupado/libre": nunca el
--    detalle del evento (los importados de Google cuentan igual, son filas de
--    la misma tabla con external_source = 'google').
-- 6. Cierre: `close_poll` a mano (creador o admin, o quien diga settings) y
--    `close_due_polls` por tiempo. El tick de pg_cron (5 min, SQL barato sin
--    LLM) cierra lo vencido y manda UN recordatorio "falta tu voto" a quien no
--    Voteó (dedupe por encuesta y usuario). Al leer la encuesta también se
--    cierra si ya venció, para que no dependa del job.
-- 7. Notificaciones tipo 'poll' (+ preferencia por tipo).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Helpers de ajustes y permisos (SECURITY DEFINER, search_path fijo)
-- -----------------------------------------------------------------------------

-- Lee un booleano de `settings` con default. Un valor basura devuelve el
-- default en vez de romper la política (jsonb puede venir de cualquier cliente).
create or replace function public.poll_flag(
  p_settings jsonb,
  p_key text,
  p_default boolean
)
returns boolean
language plpgsql
immutable
as $$
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    return p_default;
  end if;
  return coalesce((p_settings ->> p_key)::boolean, p_default);
exception when others then
  return p_default;
end;
$$;

comment on function public.poll_flag(jsonb, text, boolean) is
  'Lee un booleano de polls.settings con default (nunca falla).';

-- Ajustes por defecto de una encuesta nueva.
create or replace function public.poll_default_settings()
returns jsonb
language sql
immutable
as $$
  select '{"anonymous":false,"allowSuggestions":true,"remindMissing":false,"closeBy":"creator"}'::jsonb;
$$;

-- ¿Quién puede cerrar o editar la encuesta? Creador o admin siempre; además
-- cualquiera con acceso al chat si el creador dejó closeBy = 'anyone'.
create or replace function public.poll_can_manage(p_poll_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.polls p
    where p.id = p_poll_id
      and (
        p.created_by is not distinct from auth.uid()
        or public.is_space_admin(p.workspace_id)
        or (
          public.poll_flag(p.settings, 'closeBy', 'creator') = 'anyone'
          and public.can_access_chat(p.workspace_id, p.chat_id)
        )
      )
  );
$$;

comment on function public.poll_can_manage(uuid) is
  'Creador, admin del espacio o cualquiera con acceso si closeBy=anyone.';

-- ¿Puede este usuario votar ahora mismo (acceso al chat y encuesta abierta)?
create or replace function public.poll_can_vote(p_poll_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.polls p
    where p.id = p_poll_id
      and public.can_access_chat(p.workspace_id, p.chat_id)
      and p.closed_at is null
      and (p.closes_at is null or p.closes_at > now())
  );
$$;

comment on function public.poll_can_vote(uuid) is
  'Vota quien puede ver el chat, mientras la encuesta siga abierta.';

-- ¿Puede agregar opciones? El creador y los admins siempre; el resto solo si
-- la encuesta está abierta y permite sugerencias.
create or replace function public.poll_can_suggest(p_poll_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.polls p
    where p.id = p_poll_id
      and public.can_access_chat(p.workspace_id, p.chat_id)
      and p.closed_at is null
      and (p.closes_at is null or p.closes_at > now())
      and (
        p.created_by is not distinct from auth.uid()
        or public.is_space_admin(p.workspace_id)
        or public.poll_flag(p.settings, 'allowSuggestions', true)
      )
  );
$$;

comment on function public.poll_can_suggest(uuid) is
  'Agregar opciones: creador/admin siempre, el resto si allowSuggestions.';

-- Editar o borrar una opción: quien administra la encuesta, o quien la propuso
-- mientras siga abierta (para corregir un añadido propio).
create or replace function public.poll_can_manage_option(p_option_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.poll_options o
    join public.polls p on p.id = o.poll_id
    where o.id = p_option_id
      and (
        public.poll_can_manage(o.poll_id)
        or (
          o.added_by is not distinct from auth.uid()
          and p.closed_at is null
          and (p.closes_at is null or p.closes_at > now())
        )
      )
  );
$$;

comment on function public.poll_can_manage_option(uuid) is
  'Editar/borrar una opción: quien administra la encuesta o quien la propuso.';

-- Quién puede votar: los miembros del espacio; en un dm, solo sus miembros.
create or replace function public.poll_electors(p_workspace_id uuid, p_chat_id text)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with chat as (
    select c.type, c.member_ids
      from public.chats c
     where c.workspace_id = p_workspace_id
       and c.id = p_chat_id
  ), scope as (
    select case
             when (select type from chat) = 'dm'
               then coalesce((select member_ids from chat), '{}'::uuid[])
             else null
           end as uids
  )
  select m.user_id
    from public.workspace_members m
    cross join scope s
   where m.workspace_id = p_workspace_id
     and (s.uids is null or m.user_id = any (s.uids));
$$;

comment on function public.poll_electors(uuid, text) is
  'Uids que pueden votar: miembros del espacio (o del dm si es privado).';

-- -----------------------------------------------------------------------------
-- 1. Tablas
-- -----------------------------------------------------------------------------

-- La encuesta es un mensaje 'card': `message_id` es único (así el reintento no
-- duplica) y al borrar el mensaje se lleva la encuesta y sus votos.
create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.messages (id) on delete cascade,
  workspace_id uuid not null,
  chat_id text not null,
  question text not null check (char_length(btrim(question)) between 1 and 200),
  kind text not null default 'single' check (kind in ('single', 'multiple', 'yesno', 'date')),
  settings jsonb not null default '{"anonymous":false,"allowSuggestions":true,"remindMissing":false,"closeBy":"creator"}'::jsonb,
  closes_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint polls_chat_fk
    foreign key (workspace_id, chat_id)
    references public.chats (workspace_id, id) on delete cascade
);

comment on table public.polls is
  'Encuesta del chat. El resultado se calcula de los votos al leer (al cerrar '
  'ya no se pueden cambiar, así queda fijado sin desnormalizar).';

comment on column public.polls.settings is
  'Ajustes: anonymous, allowSuggestions, remindMissing, closeBy.';

-- Opciones: texto siempre; en kind 'date' además el rango (starts_at/ends_at).
create table if not exists public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 200),
  starts_at timestamptz,
  ends_at timestamptz,
  position numeric not null default 0,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint poll_options_range check (starts_at is null or ends_at is null or ends_at >= starts_at)
);

comment on table public.poll_options is
  'Opciones de la encuesta. En kind date, starts_at/ends_at son la franja propuesta.';

create table if not exists public.poll_votes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls (id) on delete cascade,
  option_id uuid not null references public.poll_options (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint poll_votes_once unique (poll_id, option_id, user_id)
);

comment on table public.poll_votes is
  'Votos. En single/yesno el trigger deja uno por persona (cambiar = borrar).';

create index if not exists polls_chat_idx
  on public.polls (workspace_id, chat_id, created_at desc);
create index if not exists polls_open_idx
  on public.polls (closes_at)
  where closed_at is null;
create index if not exists poll_options_poll_idx
  on public.poll_options (poll_id, position);
create index if not exists poll_votes_poll_idx
  on public.poll_votes (poll_id, user_id);

-- updated_at automático.
drop trigger if exists polls_touch_updated_at on public.polls;
create trigger polls_touch_updated_at
  before update on public.polls
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Guardas de escritura
--    El cliente solo puede cambiar question, settings, closes_at y el cierre.
--    Lo demás lo pone el trigger o la service role (bandera `loki.poll_write`).
-- -----------------------------------------------------------------------------

create or replace function public.polls_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role'
     or pg_trigger_depth() > 1
     or coalesce(current_setting('loki.poll_write', true), '') = 'on'
  then
    return new;
  end if;

  if new.message_id is distinct from old.message_id
     or new.workspace_id is distinct from old.workspace_id
     or new.chat_id is distinct from old.chat_id
     or new.kind is distinct from old.kind
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'En una encuesta solo se pueden modificar question, settings, closes_at y el cierre'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists polls_guard_update on public.polls;
create trigger polls_guard_update
  before update on public.polls
  for each row execute function public.polls_guard_update();

-- Opciones: nadie mueve la opción de encuesta ni cambia su autor.
create or replace function public.poll_options_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' or pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.poll_id is distinct from old.poll_id
     or new.workspace_id is distinct from old.workspace_id
     or new.added_by is distinct from old.added_by
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'En una opción solo se pueden modificar text, starts_at, ends_at y position'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists poll_options_guard_update on public.poll_options;
create trigger poll_options_guard_update
  before update on public.poll_options
  for each row execute function public.poll_options_guard_update();

-- Votos: la opción tiene que ser de la encuesta, la encuesta abierta y en
-- single/yesno solo queda un voto por persona. Cambiar de opción es borrar la
-- anterior (hecho aquí, con la puerta de la RLS ya abierta por SECURITY
-- DEFINER: la RPC valida antes acceso y estado).
create or replace function public.poll_votes_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll public.polls%rowtype;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  select * into v_poll from public.polls where id = new.poll_id;
  if v_poll.id is null then
    raise exception 'La encuesta ya no existe' using errcode = 'foreign_key_violation';
  end if;

  if not exists (
    select 1 from public.poll_options o
     where o.id = new.option_id and o.poll_id = new.poll_id
  ) then
    raise exception 'Esa opción no pertenece a la encuesta'
      using errcode = 'foreign_key_violation';
  end if;

  if v_poll.closed_at is not null
     or (v_poll.closes_at is not null and v_poll.closes_at <= now())
  then
    raise exception 'La encuesta ya está cerrada' using errcode = 'check_violation';
  end if;

  if v_poll.kind in ('single', 'yesno') then
    delete from public.poll_votes
     where poll_id = new.poll_id
       and user_id = new.user_id
       and id is distinct from new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists poll_votes_guard on public.poll_votes;
create trigger poll_votes_guard
  before insert or update on public.poll_votes
  for each row execute function public.poll_votes_guard();

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------

alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;

-- --- polls ------------------------------------------------------------------
drop policy if exists "polls: ver las de mi chat" on public.polls;
create policy "polls: ver las de mi chat"
  on public.polls for select to authenticated
  using (public.can_access_chat(workspace_id, chat_id));

drop policy if exists "polls: crear en mi chat" on public.polls;
create policy "polls: crear en mi chat"
  on public.polls for insert to authenticated
  with check (
    public.can_access_chat(workspace_id, chat_id)
    and created_by is not distinct from auth.uid()
  );

drop policy if exists "polls: editar creador o admin" on public.polls;
create policy "polls: editar creador o admin"
  on public.polls for update to authenticated
  using (public.poll_can_manage(id))
  with check (public.poll_can_manage(id));

drop policy if exists "polls: borrar creador o admin" on public.polls;
create policy "polls: borrar creador o admin"
  on public.polls for delete to authenticated
  using (
    created_by is not distinct from auth.uid()
    or public.is_space_admin(workspace_id)
  );

-- --- poll_options -----------------------------------------------------------
drop policy if exists "poll_options: ver los de mi chat" on public.poll_options;
create policy "poll_options: ver los de mi chat"
  on public.poll_options for select to authenticated
  using (
    exists (
      select 1 from public.polls p
       where p.id = poll_id
         and public.can_access_chat(p.workspace_id, p.chat_id)
    )
  );

drop policy if exists "poll_options: agregar si está abierta" on public.poll_options;
create policy "poll_options: agregar si está abierta"
  on public.poll_options for insert to authenticated
  with check (
    public.poll_can_suggest(poll_id)
    and public.is_member(workspace_id)
    and added_by is not distinct from auth.uid()
  );

drop policy if exists "poll_options: editar quien pueda gestionarlas" on public.poll_options;
create policy "poll_options: editar quien pueda gestionarlas"
  on public.poll_options for update to authenticated
  using (public.poll_can_manage_option(id))
  with check (public.poll_can_manage_option(id));

drop policy if exists "poll_options: borrar quien pueda gestionarlas" on public.poll_options;
create policy "poll_options: borrar quien pueda gestionarlas"
  on public.poll_options for delete to authenticated
  using (public.poll_can_manage_option(id));

-- --- poll_votes -------------------------------------------------------------
-- Clave de privacidad: en una encuesta anónima SOLO se ven los votos propios.
-- El conteo de los demás llega por `poll_results`, que tampoco los expone.
drop policy if exists "poll_votes: ver los votos si la encuesta no es anonima" on public.poll_votes;
create policy "poll_votes: ver los votos si la encuesta no es anonima"
  on public.poll_votes for select to authenticated
  using (
    user_id is not distinct from auth.uid()
    or exists (
      select 1 from public.polls p
       where p.id = poll_id
         and public.can_access_chat(p.workspace_id, p.chat_id)
         and public.poll_flag(p.settings, 'anonymous', false) = false
    )
  );

drop policy if exists "poll_votes: votar mi voto" on public.poll_votes;
create policy "poll_votes: votar mi voto"
  on public.poll_votes for insert to authenticated
  with check (
    user_id is not distinct from auth.uid()
    and public.poll_can_vote(poll_id)
  );

-- Retirar el voto solo con la encuesta abierta; el administrador limpia
-- cualquier voto (por ejemplo al borrar una opción).
drop policy if exists "poll_votes: retirar mi voto" on public.poll_votes;
create policy "poll_votes: retirar mi voto"
  on public.poll_votes for delete to authenticated
  using (
    (user_id is not distinct from auth.uid() and public.poll_can_vote(poll_id))
    or public.poll_can_manage(poll_id)
  );

-- Sin política de UPDATE: un voto no se edita, se cambia (borrar + insert).

-- -----------------------------------------------------------------------------
-- 4. RPCs
-- -----------------------------------------------------------------------------

-- Contador de la encuesta: opciones con sus votos, resultado y quién falta.
-- En las anónimas `voters` y `missing` van vacíos: la RLS tampoco los deja ver.
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
  -- diría quién votó por descarte).
  if v_anon then
    v_missing := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(e.user_id), '[]'::jsonb) into v_missing
      from public.poll_electors(v_poll.workspace_id, v_poll.chat_id) e
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

comment on function public.poll_results(uuid) is
  'Estado de una encuesta: opciones con votos, resultado, empate y quién falta.';

-- Votar (o cambiar el voto, o retirarlo con la lista vacía) en una sola
-- llamada: valida acceso, encuesta abierta y tipo antes de tocar nada.
create or replace function public.cast_poll_vote(
  p_poll_id uuid,
  p_option_ids uuid[]
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_poll public.polls%rowtype;
  v_ids uuid[];
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
  if v_poll.closed_at is not null
     or (v_poll.closes_at is not null and v_poll.closes_at <= now())
  then
    raise exception 'La encuesta ya está cerrada' using errcode = 'check_violation';
  end if;

  v_ids := array(select distinct unnest(coalesce(p_option_ids, '{}'::uuid[])));

  -- Sin opciones: retirar el voto.
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    delete from public.poll_votes
     where poll_id = p_poll_id and user_id = v_uid;
    return false;
  end if;

  if (
    select count(*)
      from public.poll_options o
     where o.poll_id = p_poll_id and o.id = any (v_ids)
  ) <> coalesce(array_length(v_ids, 1), 0) then
    raise exception 'Alguna opción no pertenece a la encuesta'
      using errcode = 'check_violation';
  end if;

  if v_poll.kind in ('single', 'yesno') and coalesce(array_length(v_ids, 1), 0) <> 1 then
    raise exception 'En esta encuesta solo puedes elegir una opción'
      using errcode = 'check_violation';
  end if;

  if v_poll.kind = 'multiple' and coalesce(array_length(v_ids, 1), 0) > 10 then
    raise exception 'Máximo 10 opciones por persona' using errcode = 'check_violation';
  end if;

  -- Cambiar de voto reemplaza: nunca se acumulan opciones.
  delete from public.poll_votes where poll_id = p_poll_id and user_id = v_uid;
  insert into public.poll_votes (poll_id, option_id, user_id)
  select p_poll_id, chosen.id, v_uid from unnest(v_ids) as chosen(id);

  return true;
end;
$$;

comment on function public.cast_poll_vote(uuid, uuid[]) is
  'Vota, cambia o retira el voto. Lista vacía = retirar.';

-- Cierre a mano. El resultado queda fijado porque después no hay más votos.
create or replace function public.close_poll(p_poll_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_closed_at timestamptz;
begin
  if v_uid is null then
    raise exception 'Hay que iniciar sesión'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.poll_can_manage(p_poll_id) then
    raise exception 'Solo quien creó la encuesta o un admin puede cerrarla'
      using errcode = 'insufficient_privilege';
  end if;

  perform set_config('loki.poll_write', 'on', true);
  update public.polls
     set closed_at = coalesce(closed_at, now()),
         closed_by = coalesce(closed_by, v_uid)
   where id = p_poll_id
  returning closed_at into v_closed_at;

  return v_closed_at is not null;
end;
$$;

comment on function public.close_poll(uuid) is
  'Cierra la encuesta a mano (creador, admin o quien diga closeBy).';

-- Disponibilidad de las opciones con fecha: cuántos miembros ya tienen algo
-- agendado en `events` en esa franja. Solo el número (ocupado/libre): el
-- detalle del evento nunca sale de la base. Los importados de Google cuentan
-- igual (son filas de `events` con external_source = 'google').
create or replace function public.poll_option_busy(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll public.polls%rowtype;
  v_rows jsonb;
begin
  if auth.uid() is null then
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

  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', o.id, 'busy', coalesce(b.busy, 0))
      order by o.position, o.created_at, o.id
    ),
    '[]'::jsonb
  ) into v_rows
    from public.poll_options o
    left join lateral (
      select count(distinct b.uid)::int as busy
        from public.events e
        cross join lateral unnest(
          case
            when coalesce(array_length(e.attendees, 1), 0) > 0 then e.attendees
            else array[e.created_by]
          end
        ) as b(uid)
       where e.workspace_id = v_poll.workspace_id
         and b.uid is not null
         and b.uid = any (coalesce(
           array(select public.poll_electors(v_poll.workspace_id, v_poll.chat_id)),
           '{}'::uuid[]
         ))
         and e.starts_at < coalesce(o.ends_at, o.starts_at + interval '1 hour')
         and e.ends_at > o.starts_at
    ) b on o.starts_at is not null
   where o.poll_id = v_poll.id;

  return jsonb_build_object('options', v_rows);
end;
$$;

comment on function public.poll_option_busy(uuid) is
  'Ocupados por opción (solo el número; nunca el detalle del evento).';

-- -----------------------------------------------------------------------------
-- 5. Cierre por tiempo y recordatorio "falta tu voto" (SQL barato, sin LLM)
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

-- Una sola notificación por persona y encuesta (dedupe), y solo a quien no
-- votó: el aviso llega por el camino normal (notifications -> push-send), que
-- ya respeta preferencias y horario de silencio.
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
        from public.poll_electors(v_poll.workspace_id, v_poll.chat_id) e
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

-- Un solo tick para pg_cron: cierra lo vencido y avisa lo que falta.
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
  'Job de encuestas (pg_cron, SQL barato): cierra vencidas y avisa pendientes.';

do $pollcron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin job de encuestas: %', sqlerrm;
    return;
  end;
  begin
    -- pg_cron instala sus funciones en el esquema `cron`.
    perform cron.unschedule('loki-poll-tick');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule('loki-poll-tick', '*/5 * * * *', 'select public.poll_tick()');
  exception when others then
    raise notice 'no se pudo programar el job de encuestas: %', sqlerrm;
  end;
end
$pollcron$;

-- -----------------------------------------------------------------------------
-- 6. Notificaciones tipo encuesta
-- -----------------------------------------------------------------------------

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add check (type in (
  'mention', 'reply', 'reaction', 'task_assigned', 'task_due',
  'event_reminder', 'invite', 'ai_alert', 'list', 'poll'
));

-- Interruptores por tipo (mismo criterio que el resto: sin fila = todo
-- activado). Se agregan los que faltaban para los tipos que ya existen
-- ('list' de las listas compartidas) y el nuevo ('poll').
alter table public.notification_prefs
  add column if not exists list boolean not null default true;
alter table public.notification_prefs
  add column if not exists poll boolean not null default true;

comment on column public.notification_prefs.list is
  'Avisos de listas compartidas (novedades y lista completa).';
comment on column public.notification_prefs.poll is
  'Avisos de encuestas ("falta tu voto").';

-- -----------------------------------------------------------------------------
-- 7. Realtime (las barras se actualizan solas)
-- -----------------------------------------------------------------------------

do $pollpub$
begin
  begin
    alter publication supabase_realtime add table public.polls;
  exception when others then
    raise notice 'polls sin realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.poll_options;
  exception when others then
    raise notice 'poll_options sin realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.poll_votes;
  exception when others then
    raise notice 'poll_votes sin realtime: %', sqlerrm;
  end;
end
$pollpub$;

-- -----------------------------------------------------------------------------
-- 8. Privilegios (la puerta es la RLS; esto solo evita 404/403 por GRANT)
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on public.polls to authenticated;
grant select, insert, update, delete on public.poll_options to authenticated;
grant select, insert, delete on public.poll_votes to authenticated;

grant execute on function public.poll_results(uuid) to authenticated;
grant execute on function public.cast_poll_vote(uuid, uuid[]) to authenticated;
grant execute on function public.close_poll(uuid) to authenticated;
grant execute on function public.poll_option_busy(uuid) to authenticated;

grant execute on function public.poll_flag(jsonb, text, boolean) to authenticated;
grant execute on function public.poll_default_settings() to authenticated;
grant execute on function public.poll_can_manage(uuid) to authenticated;
grant execute on function public.poll_can_vote(uuid) to authenticated;
grant execute on function public.poll_can_suggest(uuid) to authenticated;
grant execute on function public.poll_can_manage_option(uuid) to authenticated;
grant execute on function public.poll_electors(uuid, text) to authenticated;

-- El tick es de la base (pg_cron) y de la service role (diagnóstico):
-- `anon` y `authenticated` no lo ejecutan (los usuarios leen, no escriben).
revoke execute on function public.close_due_polls() from anon, authenticated;
revoke execute on function public.create_poll_reminders() from anon, authenticated;
revoke execute on function public.poll_tick() from anon, authenticated;
