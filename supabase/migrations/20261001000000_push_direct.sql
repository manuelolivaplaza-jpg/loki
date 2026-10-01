-- Push directo por notificación (fix del contrato).
--
-- El trigger `maybe_push_notification` mandaba {user_id,title,body,link} pero
-- la Edge `push-send` esperaba {workspace_id,chat_id,message_id}: ningún push
-- llegaba jamás. Se unifica en el formato directo (la función respeta las
-- preferencias del usuario y limpia tokens muertos).
-- Sin `loki.push_url`/`loki.push_key` en la base, o sin pg_net, no hace nada.
-- Nunca rompe el insert.

create extension if not exists pg_net with schema extensions;

create or replace function public.maybe_push_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_key text;
begin
  begin
    v_url := current_setting('loki.push_url', true);
    v_key := current_setting('loki.push_key', true);
  exception when others then
    return null;
  end;
  if v_url is null or v_url = '' or v_key is null or v_key = '' then
    return null;
  end if;
  begin
    -- pg_net vive en el esquema `extensions` en el stack de Supabase.
    perform extensions.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object(
        'user_id', new.user_id,
        'title', new.title,
        'body', new.body,
        'link', new.link,
        'type', new.type
      )
    );
  exception when others then
    null;
  end;
  return null;
end;
$$;

drop trigger if exists maybe_push_notification on public.notifications;
create trigger maybe_push_notification
  after insert on public.notifications
  for each row execute function public.maybe_push_notification();
