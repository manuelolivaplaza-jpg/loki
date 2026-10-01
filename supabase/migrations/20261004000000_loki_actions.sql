-- =============================================================================
-- Acciones de Loki: Bandeja por espacio y registro anti-spam.
-- NUEVA migración: no toca las anteriores.
--
-- 1. projects.is_system + ensure_inbox_project(): proyecto "Bandeja" por
--    espacio (📥, primero en la lista). Recordatorios y tareas sin proyecto
--    explícito caen ahí: nunca más "Me falta el proyecto". Ni siquiera un
--    admin puede borrarla ni archivarla; renombrarla, solo un admin (la RLS
--    de projects ya lo deja así: created_by null solo pasa WITH CHECK admin).
-- 2. loki_action_log: avisos a terceros (límite por hora y destinatario).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Bandeja del espacio
-- -----------------------------------------------------------------------------
alter table public.projects
  add column if not exists is_system boolean not null default false;

comment on column public.projects.is_system is
  'True solo en la Bandeja del espacio (la crea ensure_inbox_project).';

-- Una sola Bandeja por espacio.
create unique index if not exists projects_inbox_uidx
  on public.projects (workspace_id)
  where is_system;

-- Guardia: la Bandeja no se borra ni se archiva (ni los admins). Los
-- cambios de nombre/emoji/color pasan por la RLS normal (solo admins, pues
-- created_by es null). La service role (migraciones) tiene vía libre.
create or replace function public.projects_guard_system()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'La Bandeja del espacio no se puede borrar'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if old.is_system and new.is_system is distinct from old.is_system then
    raise exception 'La Bandeja siempre es del sistema'
      using errcode = 'insufficient_privilege';
  end if;
  if old.is_system and new.status is distinct from old.status then
    raise exception 'La Bandeja no se puede archivar'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' and new.is_system then
    -- Solo ensure_inbox_project (marca su insert con el setting
    -- `loki.inbox_bootstrap`) o la service role crean Bandejas.
    if coalesce(current_setting('loki.inbox_bootstrap', true), '') = 'on' then
      return new;
    end if;
    raise exception 'La Bandeja solo la crea ensure_inbox_project'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_guard_system on public.projects;
create trigger projects_guard_system
  before insert or update or delete on public.projects
  for each row execute function public.projects_guard_system();

-- Crea (o devuelve) la Bandeja del espacio. Idempotente y segura para
-- llamadas concurrentes (índice único parcial + on conflict).
create or replace function public.ensure_inbox_project(p_workspace_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_ws uuid;
begin
  if v_uid is null then
    raise exception 'Hay que iniciar sesión'
      using errcode = 'insufficient_privilege';
  end if;
  if p_workspace_id is null or not public.is_member(p_workspace_id) then
    raise exception 'Sin acceso al espacio'
      using errcode = 'insufficient_privilege';
  end if;
  -- El guardia de projects deja pasar este insert (y solo este).
  perform set_config('loki.inbox_bootstrap', 'on', true);
  select id into v_ws
    from public.projects
   where workspace_id = p_workspace_id and is_system
   limit 1;
  if v_ws is not null then return v_ws; end if;
  insert into public.projects (workspace_id, name, emoji, color, is_system)
  values (p_workspace_id, 'Bandeja', '📥', '#1d9bf0', true)
  on conflict (workspace_id) where is_system do nothing
  returning id into v_ws;
  if v_ws is not null then return v_ws; end if;
  select id into v_ws
    from public.projects
   where workspace_id = p_workspace_id and is_system
   limit 1;
  return v_ws;
end;
$$;

comment on function public.ensure_inbox_project(uuid) is
  'Bandeja del espacio (idempotente): tareas y recordatorios sin proyecto.';

-- Backfill: espacios existentes sin Bandeja.
select set_config('loki.inbox_bootstrap', 'on', false);
insert into public.projects (workspace_id, name, emoji, color, is_system)
select w.id, 'Bandeja', '📥', '#1d9bf0', true
  from public.workspaces w
 where not exists (
   select 1 from public.projects p
    where p.workspace_id = w.id and p.is_system
 )
on conflict (workspace_id) where is_system do nothing;

-- -----------------------------------------------------------------------------
-- 2. Registro anti-spam de avisos a terceros
-- -----------------------------------------------------------------------------
create table if not exists public.loki_action_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  target_id uuid references auth.users (id) on delete set null,
  action text not null,
  created_at timestamptz not null default now()
);

comment on table public.loki_action_log is
  'Avisos de Loki a terceros (anti-spam). Solo la service role.';

create index if not exists loki_action_log_target_idx
  on public.loki_action_log (target_id, created_at desc);

alter table public.loki_action_log enable row level security;
-- Sin políticas: ningún cliente lee ni escribe; solo la service role (worker/Edge).

-- Registra si cabe (límite por hora y destinatario) y dice si se permite.
create or replace function public.log_loki_action(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_target_id uuid,
  p_action text,
  p_limit_hour integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_target_id is null then return true; end if;
  select count(*) into v_count
    from public.loki_action_log
   where target_id = p_target_id
     and action = p_action
     and created_at > now() - interval '1 hour';
  if v_count >= greatest(coalesce(p_limit_hour, 10), 1) then
    return false;
  end if;
  insert into public.loki_action_log (workspace_id, actor_id, target_id, action)
  values (p_workspace_id, p_actor_id, p_target_id, p_action);
  return true;
end;
$$;

comment on function public.log_loki_action(uuid, uuid, uuid, text, integer) is
  'Anti-spam de avisos a terceros: tope por hora y destinatario.';

-- -----------------------------------------------------------------------------
-- 3. Realtime + privilegios
-- -----------------------------------------------------------------------------
do $aipub$
begin
  begin
    alter publication supabase_realtime add table public.projects;
  exception when others then
    raise notice 'projects ya publicado o sin realtime: %', sqlerrm;
  end;
end
$aipub$;

grant execute on function public.ensure_inbox_project(uuid) to authenticated;
grant execute on function public.log_loki_action(uuid, uuid, uuid, text, integer) to authenticated;
