-- =============================================================================
-- Agentes en el chat (etapa 2, prompt 13): invocar con @handle y ver el
-- progreso y el resultado dentro del chat, por eventos.
--
-- NUEVA migración: no toca las anteriores.
--
-- 1. Mensajes tipo `agent`: los publica la service role (Edge agent-callback)
--    cuando el grant permite publicar. El cliente NO puede escribirlos (la
--    política de INSERT sigue sin incluirlos, igual que `ai`).
-- 2. agent_runs.message_id + history: qué mensaje disparó la ejecución (la
--    tarjeta vive bajo ese mensaje) y las continuaciones de needs_input
--    (respuestas en el hilo que viajan al proveedor).
-- 3. expire_agent_runs(): además de marcar expired, avisa en el chat (mensaje
--    `agent` de la service role) y notifica a quien invocó (tipo `agent`,
--    que dispara el push por maybe_push_notification).
-- 4. agent_continue_run(p_run_id, p_text): quien invocó responde en el hilo;
--    guarda la respuesta en history, vuelve a running y despierta a
--    agent-dispatch por pg_net (mismo patrón que notify_agent_dispatch).
--
-- Convenciones heredadas: snake_case, SECURITY DEFINER con search_path fijo,
-- políticas con nombre en español, DROP POLICY IF EXISTS + CREATE POLICY,
-- GRANTs explícitos, y pg_cron/pg_net en bloques DO con EXCEPTION.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Mensajes tipo `agent` (solo service role, como `ai`).
-- -----------------------------------------------------------------------------
alter table public.messages drop constraint if exists messages_type_check;
alter table public.messages add check (type in (
  'user', 'system', 'ai', 'post', 'card', 'agent'
));

-- El preview también avanza con respuestas de agentes (muestra su texto).
drop trigger if exists messages_update_chat_preview on public.messages;
create trigger messages_update_chat_preview
  after insert on public.messages
  for each row
  when (new.thread_parent_id is null and new.type in ('user', 'post', 'ai', 'card', 'agent'))
  execute function public.messages_update_chat_preview();

-- La política de INSERT del cliente NO incluye `agent` a propósito: esos
-- mensajes solo los escribe la service role (agent-callback, expiración).
-- Se redeclara para dejar constancia (misma lista que antes).
drop policy if exists "messages: enviar mensajes como yo" on public.messages;
create policy "messages: enviar mensajes como yo"
  on public.messages
  for insert
  to authenticated
  with check (
    public.can_access_chat(workspace_id, chat_id)
    and author_id is not distinct from auth.uid()
    and type in ('user', 'system', 'post', 'card')
  );

-- -----------------------------------------------------------------------------
-- 2. Vínculo mensaje ↔ ejecución + historial de continuaciones.
-- -----------------------------------------------------------------------------
alter table public.agent_runs
  add column if not exists message_id uuid references public.messages (id) on delete set null;

alter table public.agent_runs
  add column if not exists history jsonb not null default '[]'::jsonb;

create index if not exists agent_runs_message_idx
  on public.agent_runs (message_id)
  where message_id is not null;

comment on column public.agent_runs.message_id is
  'Mensaje que disparó la ejecución (@handle). La tarjeta de progreso vive bajo ese mensaje; null en los ping de prueba.';

comment on column public.agent_runs.history is
  'Continuaciones de needs_input: [{from:"agent"|"user", text, at}]. Las respuestas en el hilo viajan al proveedor con la tarea.';

-- Las columnas nuevas entran en los GRANTs de columna (los secretos siguen
-- revocados): el cliente lee message_id/history y escribe message_id al pedir.
revoke all on public.agent_runs from anon, authenticated;
grant select (
  id, connection_id, workspace_id, chat_id, requested_by, kind, instruction,
  status, token_expires_at, deadline_at, context, history, result, error,
  cancel_requested_at, idempotency_key, message_id, created_at, updated_at, finished_at
) on public.agent_runs to authenticated;
grant insert (
  connection_id, workspace_id, chat_id, requested_by, kind, instruction,
  idempotency_key, message_id
) on public.agent_runs to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Continuación desde el hilo (quien invocó responde a needs_input).
-- -----------------------------------------------------------------------------
create or replace function public.agent_continue_run(p_run_id uuid, p_text text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.agent_runs%rowtype;
  v_owner uuid;
  v_text text := btrim(coalesce(p_text, ''));
  v_history jsonb;
  v_url text;
  v_key text;
begin
  if v_text = '' or char_length(v_text) > 4000 then
    raise exception 'La respuesta debe tener entre 1 y 4000 caracteres'
      using errcode = 'check_violation';
  end if;
  select * into v_run
  from public.agent_runs
  where id = p_run_id;
  if v_run.id is null then return false; end if;
  if v_run.status <> 'needs_input' then return false; end if;
  select c.owner_id into v_owner
  from public.agent_connections c
  where c.id = v_run.connection_id;
  -- Solo quien invocó (o el dueño) continúa; el agente nunca escribe directo
  -- y un tercero no puede meter texto en la tarea.
  if v_run.requested_by is distinct from auth.uid()
     and v_owner is distinct from auth.uid() then
    raise exception 'Solo quien pidió la ejecución puede responder'
      using errcode = 'insufficient_privilege';
  end if;
  -- Protección contra bucles: la continuación no puede mencionar a otro
  -- agente (ni a sí mismo) para disparar ejecuciones en cadena.
  if v_text ~ '@[a-z0-9._-]{2,31}' then
    v_text := regexp_replace(v_text, '@[a-z0-9._-]{2,31}', '@mención', 'gi');
  end if;
  v_history := coalesce(v_run.history, '[]'::jsonb) || jsonb_build_object(
    'from', 'user',
    'text', left(v_text, 4000),
    'at', now()
  );
  update public.agent_runs
     set history = v_history,
         status = 'running'
   where id = p_run_id
     and status = 'needs_input';
  if not found then return false; end if;
  -- Despierta a agent-dispatch (mismo patrón opt-in que notify_agent_dispatch).
  begin
    v_url := current_setting('loki.agent_dispatch_url', true);
    v_key := current_setting('loki.agent_dispatch_key', true);
  exception when others then
    return true;
  end;
  if v_url is null or v_url = '' or v_key is null or v_key = '' then
    return true;
  end if;
  begin
    perform extensions.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object('run_id', p_run_id, 'action', 'continue')
    );
  exception when others then
    null;
  end;
  return true;
end;
$$;

comment on function public.agent_continue_run(uuid, text) is
  'Respuesta en el hilo a un needs_input (quien invocó o el dueño). Guarda en history, vuelve a running y despierta al despacho.';

grant execute on function public.agent_continue_run(uuid, text) to authenticated;
revoke execute on function public.agent_continue_run(uuid, text) from anon;

-- -----------------------------------------------------------------------------
-- 4. Expiración que avisa en el chat (barrido SQL barato, sin LLM).
-- -----------------------------------------------------------------------------
create or replace function public.expire_agent_runs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_run record;
  v_seq integer;
  v_handle text;
  v_msg_id uuid;
begin
  for v_run in
    select r.id, r.connection_id, r.workspace_id, r.chat_id,
           r.requested_by, r.message_id
    from public.agent_runs r
    where r.status in ('queued', 'dispatched', 'running', 'needs_input')
      and r.deadline_at is not null
      and r.deadline_at <= now()
    order by r.deadline_at asc
    limit 50
  loop
    update public.agent_runs
       set status = 'expired',
           error = 'Sin respuesta a tiempo.',
           finished_at = coalesce(finished_at, now())
     where id = v_run.id
       and status in ('queued', 'dispatched', 'running', 'needs_input');
    if not found then continue; end if;
    select coalesce(max(seq), -1) + 1 into v_seq
    from public.agent_run_events
    where run_id = v_run.id;
    begin
      insert into public.agent_run_events (run_id, seq, type, text)
      values (v_run.id, v_seq, 'expired', 'Sin respuesta a tiempo.');
    exception when others then
      null;
    end;
    -- Nombre visible del agente para el aviso.
    select '@' || c.handle into v_handle
    from public.agent_connections c
    where c.id = v_run.connection_id;
    if v_handle is null then v_handle := '@agente'; end if;
    -- Aviso en el chat (service role dentro de SECURITY DEFINER: puede
    -- escribir type `agent`, que el cliente no puede).
    begin
      insert into public.messages
        (workspace_id, chat_id, author_id, author_name, text, type, mentions)
      values (
        v_run.workspace_id,
        v_run.chat_id,
        v_run.requested_by,
        v_handle,
        v_handle || ' no respondió a tiempo. Vuelve a intentarlo cuando quieras.',
        'agent',
        '{}'
      )
      returning id into v_msg_id;
    exception when others then
      v_msg_id := null;
    end;
    -- Aviso a quien invocó (dispara el push por maybe_push_notification).
    if v_run.requested_by is not null then
      begin
        insert into public.notifications (user_id, workspace_id, type, title, body, link)
        values (
          v_run.requested_by,
          v_run.workspace_id,
          'agent',
          v_handle,
          'no respondió a tiempo.',
          '/chat/c?id=' || v_run.chat_id ||
            case when v_msg_id is null then '' else '&msg=' || v_msg_id::text end
        );
      exception when others then
        null;
      end;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function public.expire_agent_runs() is
  'Marca expired lo pasado de su deadline y avisa en el chat + notificación (pg_cron cada 5 min, SQL barato, sin LLM).';

revoke execute on function public.expire_agent_runs() from public;
revoke execute on function public.expire_agent_runs() from anon;
revoke execute on function public.expire_agent_runs() from authenticated;
