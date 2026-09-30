-- =============================================================================
-- Loki · Storage de adjuntos y voz (chat + publicaciones).
-- NUEVA migración: no toca las anteriores. Buckets privados `chat-media` y
-- `post-media` con ruta `{workspace_id}/...`: solo los miembros del espacio
-- del primer segmento pueden leer, subir, reemplazar y borrar.
--
-- Convenciones heredadas: snake_case, políticas comentadas en español,
-- DROP POLICY IF EXISTS + CREATE POLICY, helper public.storage_workspace_id
-- y public.is_member de la migración inicial (T19).
--
-- El límite de 25 MB (imagen/video/archivo) y 10 MB (audio) lo aplica el
-- cliente en src/lib/media/upload.ts: Storage no limita por tipo MIME, solo
-- por tamaño de bucket, y el mensaje amable en español vive mejor en la UI.
-- =============================================================================

-- Buckets privados (sin URLs públicas: la app firma URLs al subir).
insert into storage.buckets (id, name, public)
values ('chat-media', 'chat-media', false),
       ('post-media', 'post-media', false)
on conflict (id) do nothing;

-- --- chat-media · leer: solo miembros del espacio del primer segmento ------
-- (p. ej. `chat-media/{workspace_id}/{uuid}-{nombre}`).
drop policy if exists "chat-media: leer si soy miembro" on storage.objects;
create policy "chat-media: leer si soy miembro"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'chat-media'
    and public.is_member(public.storage_workspace_id(name))
  );

-- --- chat-media · subir: mismo criterio que leer ---------------------------
drop policy if exists "chat-media: subir si soy miembro" on storage.objects;
create policy "chat-media: subir si soy miembro"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'chat-media'
    and public.is_member(public.storage_workspace_id(name))
  );

-- --- chat-media · reemplazar (reintento de subida con el mismo path) -------
drop policy if exists "chat-media: reemplazar si soy miembro" on storage.objects;
create policy "chat-media: reemplazar si soy miembro"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'chat-media'
    and public.is_member(public.storage_workspace_id(name))
  )
  with check (
    bucket_id = 'chat-media'
    and public.is_member(public.storage_workspace_id(name))
  );

-- --- chat-media · borrar (solo miembros; la app no borra, queda reservado) --
drop policy if exists "chat-media: borrar si soy miembro" on storage.objects;
create policy "chat-media: borrar si soy miembro"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'chat-media'
    and public.is_member(public.storage_workspace_id(name))
  );

-- --- post-media · leer: igual que chat-media --------------------------------
drop policy if exists "post-media: leer si soy miembro" on storage.objects;
create policy "post-media: leer si soy miembro"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'post-media'
    and public.is_member(public.storage_workspace_id(name))
  );

-- --- post-media · subir ------------------------------------------------------
drop policy if exists "post-media: subir si soy miembro" on storage.objects;
create policy "post-media: subir si soy miembro"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'post-media'
    and public.is_member(public.storage_workspace_id(name))
  );

-- --- post-media · reemplazar -------------------------------------------------
drop policy if exists "post-media: reemplazar si soy miembro" on storage.objects;
create policy "post-media: reemplazar si soy miembro"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'post-media'
    and public.is_member(public.storage_workspace_id(name))
  )
  with check (
    bucket_id = 'post-media'
    and public.is_member(public.storage_workspace_id(name))
  );

-- --- post-media · borrar -----------------------------------------------------
drop policy if exists "post-media: borrar si soy miembro" on storage.objects;
create policy "post-media: borrar si soy miembro"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'post-media'
    and public.is_member(public.storage_workspace_id(name))
  );
