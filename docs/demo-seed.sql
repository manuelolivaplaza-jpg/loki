-- Semilla demo OPCIONAL para un espacio nuevo (T36).
--
-- NO se ejecuta solo ni en CI: es una plantilla para que Manu la adapte en el
-- SQL editor del Supabase real. Reemplaza los valores <...> por UUIDs reales
-- (los ves en Authentication y en la tabla workspaces).
--
-- Crea: un proyecto de ejemplo + dos tareas + un evento de ejemplo.

-- 1) Proyecto de ejemplo -------------------------------------------------------
-- insert into public.projects (workspace_id, name, description, emoji, color, created_by)
-- values (
--   '<WORKSPACE_ID>',        -- uuid del espacio
--   'Casa',
--   'Pendientes de la casa',
--   '🏠',
--   '#1d9bf0',
--   '<USER_ID>'              -- tu uuid de auth.users
-- )
-- returning id;  -- anota el id como <PROJECT_ID>

-- 2) Tareas de ejemplo ----------------------------------------------------------
-- insert into public.tasks (project_id, workspace_id, title, status, due_at, created_by)
-- values
--   ('<PROJECT_ID>', '<WORKSPACE_ID>', 'Comprar pan', 'todo', now() + interval '1 day', '<USER_ID>'),
--   ('<PROJECT_ID>', '<WORKSPACE_ID>', 'Llamar al técnico', 'todo', now() + interval '2 days', '<USER_ID>');

-- 3) Evento de ejemplo -----------------------------------------------------------
-- insert into public.events (
--   workspace_id, title, description, starts_at, ends_at,
--   all_day, location, color, created_by, attendees, reminder_minutes, recurrence
-- )
-- values (
--   '<WORKSPACE_ID>',
--   'Cena familiar',
--   'En casa de los abuelos',
--   date_trunc('day', now() + interval '3 days') + time '20:00',
--   date_trunc('day', now() + interval '3 days') + time '22:00',
--   false,
--   'Casa de los abuelos',
--   '#1d9bf0',
--   '<USER_ID>',
--   '[]',
--   '{60}',
--   null
-- );

select 'plantilla demo: reemplaza <WORKSPACE_ID>, <PROJECT_ID> y <USER_ID> antes de ejecutar' as aviso;
