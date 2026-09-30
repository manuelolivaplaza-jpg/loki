-- =============================================================================
-- Loki IA con herramientas: cuota diaria, resúmenes y resumen diario.
-- NUEVA migración: no toca las anteriores.
--
-- Convenciones heredadas: snake_case, helpers SECURITY DEFINER con
-- search_path fijo, políticas comentadas en español, GRANTs explícitos.
-- Todo lo de pg_cron va en bloque DO con EXCEPTION para no romper `sb:reset`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ai_usage: contador diario de usos de Loki IA por usuario.
-- -----------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default CURRENT_DATE,
  count integer not null default 0 check (count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day)
);

comment on table public.ai_usage is
  'Cuota diaria de Loki IA por usuario. La incrementa bump_ai_usage().';

create index if not exists ai_usage_user_day_idx
  on public.ai_usage (user_id, day desc);

-- -----------------------------------------------------------------------------
-- 2. ai_summaries: resumen de conversaciones largas (contexto compacto).
-- -----------------------------------------------------------------------------
create table if not exists public.ai_summaries (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Clave del hilo: 'personal' en el chat privado, 'ws:chat' en menciones.
  chat_key text not null check (char_length(btrim(chat_key)) between 1 and 200),
  summary text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, chat_key)
);

comment on table public.ai_summaries is
  'Resumen de 2 líneas por conversación larga. La Edge loki-chat lo antepone.';

-- -----------------------------------------------------------------------------
-- 3. RLS: cada usuario ve y actualiza solo lo suyo.
-- -----------------------------------------------------------------------------

alter table public.ai_usage enable row level security;
alter table public.ai_summaries enable row level security;

-- ai_usage: solo lo propio (la Edge usa service_role para el conteo).
drop policy if exists "ai_usage: ver solo lo mio" on public.ai_usage;
create policy "ai_usage: ver solo lo mio"
  on public.ai_usage for select to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "ai_usage: crear solo lo mio" on public.ai_usage;
create policy "ai_usage: crear solo lo mio"
  on public.ai_usage for insert to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "ai_usage: editar solo lo mio" on public.ai_usage;
create policy "ai_usage: editar solo lo mio"
  on public.ai_usage for update to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

-- ai_summaries: solo las propias.
drop policy if exists "ai_summaries: ver solo las mias" on public.ai_summaries;
create policy "ai_summaries: ver solo las mias"
  on public.ai_summaries for select to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "ai_summaries: guardar solo las mias" on public.ai_summaries;
create policy "ai_summaries: guardar solo las mias"
  on public.ai_summaries for insert to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "ai_summaries: editar solo las mias" on public.ai_summaries;
create policy "ai_summaries: editar solo las mias"
  on public.ai_summaries for update to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

-- -----------------------------------------------------------------------------
-- 4. bump_ai_usage: incrementa el contador del día si hay cuota.
--    Devuelve {"allowed": bool, "count": int}. Si se supera el límite,
--    devuelve allowed=false sin incrementar de más.
-- -----------------------------------------------------------------------------
create or replace function public.bump_ai_usage(p_uid uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_uid is null then
    return jsonb_build_object('allowed', false, 'count', 0);
  end if;
  if p_limit is null or p_limit < 1 then
    p_limit := 50;
  end if;

  -- Crea la fila del día si falta (sin chocar entre llamadas concurrentes).
  insert into public.ai_usage (user_id, day, count)
  values (p_uid, CURRENT_DATE, 0)
  on conflict (user_id, day) do nothing;

  select count into v_count
  from public.ai_usage
  where user_id = p_uid and day = CURRENT_DATE;

  if v_count is null then
    v_count := 0;
  end if;

  -- Sin cuota: avisa sin incrementar de más.
  if v_count >= p_limit then
    return jsonb_build_object('allowed', false, 'count', v_count);
  end if;

  update public.ai_usage
  set count = count + 1, updated_at = now()
  where user_id = p_uid and day = CURRENT_DATE
  returning count into v_count;

  return jsonb_build_object('allowed', true, 'count', v_count);
end;
$$;

comment on function public.bump_ai_usage(uuid, integer) is
  'Cuota diaria de Loki IA. Incrementa el contador salvo que supere el límite.';

-- -----------------------------------------------------------------------------
-- 5. Resumen diario 8:00 America/Santiago (texto fijo en español).
--
-- La redacción es fija porque la base no guarda LLM key: la IA redacta solo
-- en los flujos de usuario (Edge Function loki-chat) cuando está configurada.
-- Una notificación `ai_alert` por usuario y día (dedupe ai-daily:YYYYMMDD).
-- -----------------------------------------------------------------------------
create or replace function public.create_ai_daily_digest()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created integer := 0;
  v_uid uuid;
  v_dedupe text := 'ai-daily:' || to_char(now(), 'YYYYMMDD');
begin
  -- Un aviso por miembro (miembros duplicados entre espacios colapsan).
  for v_uid in
    select distinct user_id from public.workspace_members
  loop
    if v_uid is null then continue; end if;
    begin
      insert into public.notifications (user_id, type, title, body, link, dedupe)
      values (
        v_uid,
        'ai_alert',
        'Tu día con Loki',
        'Buenos días. Revisa tus tareas que vencen hoy y tus eventos en Loki.',
        '/calendario',
        v_dedupe
      )
      on conflict (user_id, dedupe) where dedupe is not null do nothing;
      if found then v_created := v_created + 1; end if;
    exception when others then null; end;
  end loop;
  return v_created;
end;
$$;

comment on function public.create_ai_daily_digest() is
  'Resumen diario fijo (ai_alert "Tu día con Loki"), idempotente por dedupe.';

-- Alta del job diario. Si pg_cron no está (o falla), aviso y a otra cosa:
-- la migración no puede depender del entorno.
do $aicron$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise notice 'pg_cron no disponible, sin resumen diario de Loki: %', sqlerrm;
    return;
  end;
  begin
    -- pg_cron instala sus funciones en el esquema `cron` (fijo del módulo).
    perform cron.unschedule('loki-ai-daily-8am');
  exception when others then
    null;
  end;
  begin
    -- 8:00 America/Santiago (el servidor de Supabase usa UTC: 12:00 UTC
    -- equivale a 8:00 en horario de invierno chileno UTC-4).
    perform cron.schedule(
      'loki-ai-daily-8am',
      '0 12 * * *',
      'select public.create_ai_daily_digest()'
    );
  exception when others then
    raise notice 'no se pudo programar el resumen diario de Loki: %', sqlerrm;
  end;
end
$aicron$;

-- -----------------------------------------------------------------------------
-- 6. Privilegios (mismo criterio que el organizador: la puerta es la RLS).
-- -----------------------------------------------------------------------------
grant select, insert, update on
  public.ai_usage,
  public.ai_summaries
  to authenticated;

grant execute on function public.bump_ai_usage(uuid, integer) to authenticated;
grant execute on function public.create_ai_daily_digest() to authenticated;
revoke execute on function public.create_ai_daily_digest() from public;
