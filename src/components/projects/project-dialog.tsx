"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { EmojiPicker } from "@/components/workspaces/emoji-picker";
import { useCreateProject, useDeleteProject, useUpdateProject } from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import { AVATAR_COLORS } from "@/types/models";
import type { ProjectItem } from "@/types/organizer";
import { cn } from "@/lib/utils";

export function ProjectDialog({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: ProjectItem | null;
  onClose: () => void;
}): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const { currentWorkspaceId } = useWorkspaces();
  const createProject = useCreateProject(currentWorkspaceId);
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();

  const [name, setName] = React.useState(project?.name ?? "");
  const [description, setDescription] = React.useState(project?.description ?? "");
  const [emoji, setEmoji] = React.useState(project?.emoji ?? "📁");
  const [color, setColor] = React.useState(project?.color ?? "#1d9bf0");
  const [archived, setArchived] = React.useState(project?.status === "archived");
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setEmoji(project?.emoji ?? "📁");
    setColor(project?.color ?? "#1d9bf0");
    setArchived(project?.status === "archived");
    setError(null);
    setConfirmDelete(false);
  }, [open, project]);

  const saving = createProject.isPending || updateProject.isPending;

  async function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (user === null || currentWorkspaceId === null) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    setError(null);
    try {
      if (project === null) {
        await createProject.mutateAsync({
          uid: user.uid,
          name,
          emoji,
          color,
          description,
        });
      } else {
        await updateProject.mutateAsync({
          id: project.id,
          patch: {
            name,
            description,
            emoji,
            color,
            status: archived ? "archived" : "active",
          },
        });
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el proyecto.");
    }
  }

  async function handleDelete(): Promise<void> {
    if (project === null) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setError(null);
    try {
      await deleteProject.mutateAsync(project.id);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el proyecto.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label={project === null ? "Nuevo proyecto" : "Editar proyecto"}>
        <DialogTitle>{project === null ? "Nuevo proyecto" : "Editar proyecto"}</DialogTitle>
        <DialogDescription>Visible para todo el espacio.</DialogDescription>
        <form onSubmit={(formEvent) => void handleSubmit(formEvent)} className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
          <div>
            <label htmlFor="project-name" className={labelClassName}>
              Nombre
            </label>
            <input
              id="project-name"
              name="name"
              type="text"
              required
              maxLength={80}
              value={name}
              onChange={(formEvent) => setName(formEvent.target.value)}
              placeholder="p. ej. Reforma cocina"
              className={inputClassName}
            />
          </div>
          <div>
            <label htmlFor="project-description" className={labelClassName}>
              Descripción
            </label>
            <textarea
              id="project-description"
              name="description"
              rows={2}
              value={description}
              onChange={(formEvent) => setDescription(formEvent.target.value)}
              placeholder="Opcional"
              className={`${inputClassName} min-h-11 py-3`}
            />
          </div>
          <div>
            <span id="project-emoji-label" className={labelClassName}>
              Emoji
            </span>
            <EmojiPicker value={emoji} onChange={setEmoji} labelId="project-emoji-label" />
          </div>
          <div>
            <span id="project-color-label" className={labelClassName}>
              Color
            </span>
            <div role="radiogroup" aria-labelledby="project-color-label" className="flex flex-wrap gap-2">
              {AVATAR_COLORS.map((option) => {
                const selected = color === option.value;
                return (
                  <label
                    key={option.value}
                    className="cursor-pointer rounded-full outline-none focus-within:ring-2 focus-within:ring-accent"
                  >
                    <input
                      type="radio"
                      name="color"
                      value={option.value}
                      checked={selected}
                      onChange={() => setColor(option.value)}
                      aria-label={option.name}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      style={{ backgroundColor: option.value }}
                      className={cn(
                        "block h-9 w-9 rounded-full",
                        selected && "ring-2 ring-accent ring-offset-2 ring-offset-background",
                      )}
                    />
                  </label>
                );
              })}
            </div>
          </div>
          {project !== null ? (
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={archived}
                onChange={(formEvent) => setArchived(formEvent.target.checked)}
                className="h-5 w-5 accent-[var(--color-accent)]"
              />
              <span className="text-body-sm text-foreground">Archivado</span>
            </label>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={saving} className="w-full">
            {saving ? "Guardando…" : project === null ? "Crear proyecto" : "Guardar cambios"}
          </Button>
          {project !== null ? (
            <Button
              type="button"
              variant="secondary"
              disabled={deleteProject.isPending}
              onClick={() => void handleDelete()}
              className="w-full"
            >
              {confirmDelete ? "Toca de nuevo para eliminar" : "Eliminar proyecto"}
            </Button>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
