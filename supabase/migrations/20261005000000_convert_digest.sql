-- =============================================================================
-- Convertir mensajes + resumen de no leídos.
-- NUEVA migración: no toca las anteriores.
--
-- 1. message_links: vínculo mensaje -> tarea/evento (chip "✓ Tarea: …" con
--    estado en vivo). Solo miembros del espacio ven y crean vínculos.
-- 2. ai_jobs: nuevo tipo 'chat_digest' (resumen privado de no leídos).
-- 3. ai_summaries: columna last_message_id para cachear el resumen por
--    (usuario, chat, último mensaje incluido).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Vínculos mensaje -> tarea/evento
-- -----------------------------------------------------------------------------
create table if not exists public.message_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  kind text not null check (kind in ('task', 'event')),
  task_id uuid references public.tasks (id) on delete cascade,
  event_id uuid references public.events (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (
    (kind = 'task' and task_id is not null and event_id is null) or
    (kind = 'event' and event_id is not null and task_id is null)
  )
);

comment on table public.message_links is
  'Vínculo mensaje -> tarea/evento (chip de conversión con estado en vivo).';

create index if not exists message_links_message_idx
  on public.message_links (message_id);

create index if not exists message_links_task_idx
  on public.message_links (task_id)
  where task_id is not null;

create index if not exists message_links_event_idx
  on public.message_links (event_id)
  where event_id is not null;

alter table public.message_links enable row level security;

-- Ver: miembros del espacio (el vínculo no expone DMs: lo creado queda en
-- el mismo espacio y la RLS de tasks/events sigue mandando).
drop policy if exists "message_links: ver los de mi espacio" on public.message_links;
create policy "message_links: ver los de mi espacio"
  on public.message_links for select to authenticated
  using (public.is_member(workspace_id));

-- Crear: miembros, a nombre propio.
drop policy if exists "message_links: crear en mi espacio" on public.message_links;
create policy "message_links: crear en mi espacio"
  on public.message_links for insert to authenticated
  with check (
    public.is_member(workspace_id)
    and created_by is not distinct from auth.uid()
  );

-- Borrar: quien lo creó o un admin.
drop policy if exists "message_links: borrar el creador o admin" on public.message_links;
create policy "message_links: borrar el creador o admin"
  on public.message_links for delete to authenticated
  using (
    created_by is not distinct from auth.uid()
    or public.is_space_admin(workspace_id)
  );

-- -----------------------------------------------------------------------------
-- 2. ai_jobs: tipo chat_digest
-- -----------------------------------------------------------------------------
alter table public.ai_jobs drop constraint if exists ai_jobs_type_check;
alter table public.ai_jobs add check (type in (
  'chat_summary', 'day_digest', 'transcribe_audio', 'ocr_image',
  'dispatch_agent', 'redact_highlights', 'chat_digest'
));

-- -----------------------------------------------------------------------------
-- 3. Cache del resumen por (usuario, chat, último mensaje)
-- -----------------------------------------------------------------------------
alter table public.ai_summaries
  add column if not exists last_message_id uuid references public.messages (id) on delete set null;

comment on column public.ai_summaries.last_message_id is
  'Último mensaje incluido en el resumen: si coincide, el resumen se reutiliza.';

-- -----------------------------------------------------------------------------
-- 4. Realtime + privilegios
-- -----------------------------------------------------------------------------
do $aipub$
begin
  begin
    alter publication supabase_realtime add table public.message_links;
  exception when others then
    raise notice 'message_links ya publicado o sin realtime: %', sqlerrm;
  end;
end
$aipub$;

grant select, insert, delete on public.message_links to authenticated;
