"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { EmojiPicker } from "@/components/workspaces/emoji-picker";
import { KindPicker } from "@/components/workspaces/kind-picker";
import { EMOJI_OPTIONS } from "@/components/workspaces/workspace-options";
import { createWorkspace } from "@/lib/data/workspaces";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { WorkspaceKind } from "@/types/models";

type CreateWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreateWorkspaceDialog({ open, onOpenChange }: CreateWorkspaceDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const setProfile = useProfileStore((state) => state.setProfile);
  const setCurrentWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);

  const [workspaceName, setWorkspaceName] = React.useState("");
  const [emoji, setEmoji] = React.useState<string>(EMOJI_OPTIONS[0]?.char ?? "🏠");
  const [kind, setKind] = React.useState<WorkspaceKind>("family");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setWorkspaceName("");
      setEmoji(EMOJI_OPTIONS[0]?.char ?? "🏠");
      setKind("family");
      setError(null);
      setSaving(false);
    }
  }, [open ]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (user === null) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    const name = workspaceName.trim();
    if (name === "") {
      setError("Ponle un nombre a tu espacio.");
      return;
    }
    if (name.length > 60) {
      setError("El nombre no puede superar los 60 caracteres.");
      return;
    }
    const displayName =
      profile?.displayName.trim() !== "" && profile?.displayName !== undefined
        ? (profile.displayName as string).trim()
        : (user.displayName ?? "").trim() !== ""
          ? (user.displayName as string).trim()
          : "Miembro";
    const avatarColor = profile?.avatarColor ?? "#00b4d8";
    setSaving(true);
    setError(null);
    try {
      const wsId = await createWorkspace(
        { name, emoji, kind },
        { uid: user.uid, displayName, avatarColor },
      );
      setCurrentWorkspaceId(wsId);
      if (profile !== null) {
        setProfile({ ...profile, currentWorkspaceId: wsId });
      }
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo crear tu espacio. Inténtalo de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Crear espacio</DialogTitle>
        <DialogDescription>Un espacio para tu familia o tu equipo.</DialogDescription>
        <form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-5">
          <div>
            <label htmlFor="workspace-name" className={labelClassName}>
              Nombre del espacio
            </label>
            <input
              id="workspace-name"
              name="workspaceName"
              type="text"
              required
              maxLength={60}
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="p. ej. Familia García"
              className={inputClassName}
            />
          </div>
          <div>
            <span id="create-emoji-label" className={labelClassName}>
              Emoji
            </span>
            <EmojiPicker value={emoji} onChange={setEmoji} labelId="create-emoji-label" />
          </div>
          <div>
            <span id="create-kind-label" className={labelClassName}>
              Tipo de espacio
            </span>
            <KindPicker value={kind} onChange={setKind} labelId="create-kind-label" />
          </div>
          {error !== null ? (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={saving}
            className="flex h-11 w-full items-center justify-center rounded-full bg-foreground text-[15px] font-semibold text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Creando espacio..." : "Crear espacio"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
