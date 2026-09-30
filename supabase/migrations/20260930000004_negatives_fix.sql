-- T35: escrituras ajenas ruidosas en el organizador.
--
-- Las políticas UPDATE de projects/events/ideas tenían el USING igual que el
-- WITH CHECK (creador o admin): un miembro que intentaba editar lo ajeno
-- recibía 0 filas sin error y el cliente no distinguía "sin permiso" de
-- "no existe". Con el USING en "miembro del espacio" (la fila SÍ se ve) y el
-- WITH CHECK en "creador o admin", el intento ajeno falla con 42501 y la app
-- muestra el error en español. Los ajenos (no miembros) siguen viendo 0 filas
-- sin error, y los DELETE conservan su USING silencioso.
-- No toca tests: alinea la base con tests/rls/organizer.test.mjs (assertDenied
-- al editar lo ajeno siendo miembro).

-- --- projects -----------------------------------------------------------------
drop policy if exists "projects: editar creador o admin" on public.projects;
create policy "projects: editar creador o admin"
  on public.projects for update to authenticated
  using (public.is_member(workspace_id))
  with check (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

-- --- events -------------------------------------------------------------------
drop policy if exists "events: editar creador o admin" on public.events;
create policy "events: editar creador o admin"
  on public.events for update to authenticated
  using (public.is_member(workspace_id))
  with check (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );

-- --- ideas --------------------------------------------------------------------
drop policy if exists "ideas: editar creador o admin" on public.ideas;
create policy "ideas: editar creador o admin"
  on public.ideas for update to authenticated
  using (public.is_member(workspace_id))
  with check (
    public.is_member(workspace_id)
    and (created_by is not distinct from auth.uid() or public.is_space_admin(workspace_id))
  );
