-- =============================================================================
-- Listas compartidas + mensajes tarjeta.
-- NUEVA migración: no toca las anteriores.
--
-- 1. lists y list_items (workspace_id en ambas para RLS simple, position
--    numeric como en tasks, checked_by/at, assignee, quantity/unit).
--    Tipos: compras (cantidad/unidad/categoría), quehaceres (responsable y
--    fecha) y checklist genérica.
-- 2. list_watchers: avisos por lista ("cuando agreguen", "cuando esté
--    completa"), agrupados por cuarto de hora con dedupe (una sola push).
-- 3. messages: tipo 'card' + columna meta jsonb (tarjeta viva de lista
--    compartida en el chat con progreso; marcar desde el chat).
-- 4. notifications: tipo 'list' para esos avisos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Listas e ítems
-- -----------------------------------------------------------------------------
create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  emoji text not null default '🛒' check (char_length(btrim(emoji)) between 1 and 16),
  color text not null default '#1d9bf0',
  kind text not null default 'checklist' check (kind in ('groceries', 'chores', 'checklist')),
  pinned boolean not null default false,
  archived boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lists is
  'Listas compartidas del espacio (compras, quehaceres, checklist).';

create table if not exists public.list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 200),
  quantity text not null default '',
  unit text not null default '',
  category text not null default '',
  checked boolean not null default false,
  checked_by uuid references auth.users (id) on delete set null,
  checked_at timestamptz,
  assignee_id uuid references auth.users (id) on delete set null,
  due_at timestamptz,
  position numeric not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.list_items is
  'Ítems de lista. position numeric como en tasks (reordenar sin reescribir).';

create index if not exists list_items_list_idx
  on public.list_items (list_id, checked, position);

create index if not exists lists_ws_idx
  on public.lists (workspace_id, archived, pinned);

drop trigger if exists lists_touch_updated_at on public.lists;
create trigger lists_touch_updated_at
  before update on public.lists
  for each row execute function public.touch_updated_at();

drop trigger if exists list_items_touch_updated_at on public.list_items;
create trigger list_items_touch_updated_at
  before update on public.list_items
  for each row execute function public.touch_updated_at();

alter table public.lists enable row level security;
alter table public.list_items enable row level security;

-- Listas: miembros leen y escriben; borrar solo creador o admin.
drop policy if exists "lists: ver las de mi espacio" on public.lists;
create policy "lists: ver las de mi espacio"
  on public.lists for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "lists: crear en mi espacio" on public.lists;
create policy "lists: crear en mi espacio"
  on public.lists for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
  );

drop policy if exists "lists: editar miembros" on public.lists;
create policy "lists: editar miembros"
  on public.lists for update to authenticated
  using (public.is_member(workspace_id))
  with check (public.is_member(workspace_id));

drop policy if exists "lists: borrar creador o admin" on public.lists;
create policy "lists: borrar creador o admin"
  on public.lists for delete to authenticated
  using (
    created_by is not distinct from auth.uid()
    or public.is_space_admin(workspace_id)
  );

-- Ítems: miembros leen y escriben (marcar es de todos); borrar creador/admin.
drop policy if exists "list_items: ver los de mi espacio" on public.list_items;
create policy "list_items: ver los de mi espacio"
  on public.list_items for select to authenticated
  using (public.is_member(workspace_id));

drop policy if exists "list_items: agregar en mi espacio" on public.list_items;
create policy "list_items: agregar en mi espacio"
  on public.list_items for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
  );

drop policy if exists "list_items: editar miembros" on public.list_items;
create policy "list_items: editar miembros"
  on public.list_items for update to authenticated
  using (public.is_member(workspace_id))
  with check (public.is_member(workspace_id));

drop policy if exists "list_items: borrar creador o admin" on public.list_items;
create policy "list_items: borrar creador o admin"
  on public.list_items for delete to authenticated
  using (
    created_by is not distinct from auth.uid()
    or public.is_space_admin(workspace_id)
  );

-- -----------------------------------------------------------------------------
-- 2. Vigilantes por lista (avisos agrupados, nada de una push por ítem)
-- -----------------------------------------------------------------------------
create table if not exists public.list_watchers (
  user_id uuid not null references auth.users (id) on delete cascade,
  list_id uuid not null references public.lists (id) on delete cascade,
  on_add boolean not null default true,
  on_complete boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, list_id)
);

comment on table public.list_watchers is
  'Avisos por lista. El trigger agrupa por cuarto de hora (dedupe).';

alter table public.list_watchers enable row level security;

drop policy if exists "list_watchers: solo las mias" on public.list_watchers;
create policy "list_watchers: solo las mias"
  on public.list_watchers for select to authenticated
  using (user_id is not distinct from auth.uid());

drop policy if exists "list_watchers: crear solo las mias" on public.list_watchers;
create policy "list_watchers: crear solo las mias"
  on public.list_watchers for insert to authenticated
  with check (user_id is not distinct from auth.uid());

drop policy if exists "list_watchers: editar solo las mias" on public.list_watchers;
create policy "list_watchers: editar solo las mias"
  on public.list_watchers for update to authenticated
  using (user_id is not distinct from auth.uid())
  with check (user_id is not distinct from auth.uid());

drop policy if exists "list_watchers: borrar solo las mias" on public.list_watchers;
create policy "list_watchers: borrar solo las mias"
  on public.list_watchers for delete to authenticated
  using (user_id is not distinct from auth.uid());

-- Aviso agrupado: un insert y un check generan como máximo una notificación
-- por lista y cuarto de hora (dedupe), con el actor fuera de los avisados.
create or replace function public.notify_list_watchers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_list record;
  v_watcher record;
  v_bucket text := to_char(now(), 'YYYYMMDDHH24') || ((extract(minute from now())::int / 15)::text);
  v_actor uuid;
  v_is_check boolean := false;
  v_complete boolean := false;
begin
  if tg_op = 'INSERT' then
    v_actor := new.created_by;
  else
    v_actor := coalesce(new.checked_by, old.checked_by, new.created_by);
    v_is_check := (old.checked is distinct from new.checked);
    if not v_is_check then return null; end if;
  end if;

  select workspace_id, title into v_list
    from public.lists
   where id = coalesce(new.list_id, old.list_id);
  if v_list.workspace_id is null then return null; end if;

  -- ¿Se completó la lista con este check?
  if v_is_check and new.checked then
    select not exists (
      select 1 from public.list_items
       where list_id = new.list_id and checked = false
    ) into v_complete;
  end if;

  for v_watcher in
    select user_id, on_add, on_complete
      from public.list_watchers
     where list_id = coalesce(new.list_id, old.list_id)
       and user_id is distinct from v_actor
  loop
    if tg_op = 'INSERT' and not v_watcher.on_add then continue; end if;
    if tg_op = 'UPDATE' and not (
      (v_complete and v_watcher.on_complete) or
      (not v_complete and v_watcher.on_add)
    ) then continue; end if;
    begin
      insert into public.notifications
        (user_id, workspace_id, type, title, body, link, dedupe)
      values (
        v_watcher.user_id,
        v_list.workspace_id,
        'list',
        case when v_complete then 'Lista completa' else 'Novedades en lista' end,
        left(v_list.title, 100),
        '/proyectos?tab=listas',
        'list:' || coalesce(new.list_id, old.list_id)::text || ':' || v_bucket
      )
      on conflict (user_id, dedupe) where dedupe is not null do nothing;
    exception when others then null; end;
  end loop;
  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists notify_list_watchers_ins on public.list_items;
create trigger notify_list_watchers_ins
  after insert on public.list_items
  for each row execute function public.notify_list_watchers();

drop trigger if exists notify_list_watchers_upd on public.list_items;
create trigger notify_list_watchers_upd
  after update of checked on public.list_items
  for each row execute function public.notify_list_watchers();

-- -----------------------------------------------------------------------------
-- 3. Mensajes tarjeta (lista viva compartida en el chat)
-- -----------------------------------------------------------------------------
alter table public.messages
  add column if not exists meta jsonb not null default '{}'::jsonb;

comment on column public.messages.meta is
  'Datos de tarjeta (p. ej. {kind:"list", list_id}). Nunca HTML.';

alter table public.messages drop constraint if exists messages_type_check;
alter table public.messages add check (type in (
  'user', 'system', 'ai', 'post', 'card'
));

-- La tarjeta la escribe cualquier miembro (compartir lista); 'ai' sigue
-- siendo solo service role.
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

-- El preview también avanza con tarjetas (muestra su texto legible).
drop trigger if exists messages_update_chat_preview on public.messages;
create trigger messages_update_chat_preview
  after insert on public.messages
  for each row
  when (new.thread_parent_id is null and new.type in ('user', 'post', 'ai', 'card'))
  execute function public.messages_update_chat_preview();

-- -----------------------------------------------------------------------------
-- 4. Notificaciones tipo lista
-- -----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add check (type in (
  'mention', 'reply', 'reaction', 'task_assigned', 'task_due',
  'event_reminder', 'invite', 'ai_alert', 'list'
));

-- -----------------------------------------------------------------------------
-- 5. Realtime + privilegios
-- -----------------------------------------------------------------------------
do $listpub$
begin
  begin
    alter publication supabase_realtime add table public.lists;
  exception when others then
    raise notice 'lists sin realtime: %', sqlerrm;
  end;
  begin
    alter publication supabase_realtime add table public.list_items;
  exception when others then
    raise notice 'list_items sin realtime: %', sqlerrm;
  end;
end
$listpub$;

grant select, insert, update, delete on public.lists to authenticated;
grant select, insert, update, delete on public.list_items to authenticated;
grant select, insert, update, delete on public.list_watchers to authenticated;
