"use client";

import * as React from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { MenuItem } from "@/components/ui/menu-card";
import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";
import { kindLabel } from "@/components/workspaces/workspace-options";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceStore, useWorkspaces } from "@/stores/workspace-store";
import { useProfileStore } from "@/stores/profile-store";
import { cn } from "@/lib/utils";

export function WorkspaceSwitcher(): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const { workspaces, currentWorkspace, currentWorkspaceId, isLoading } = useWorkspaces();
  const setCurrent = useWorkspaceStore((state) => state.setCurrent);
  const [open, setOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const display = currentWorkspace ?? workspaces[0] ?? null;
  // Mientras carga (o mientras el perfil ya apunta a un espacio que la
  // lista aún no trae) nunca se muestra "Sin espacios": skeleton sobrio.
  const hasCurrent =
    currentWorkspaceId ?? profile?.currentWorkspaceId ?? null;
  const loading =
    (isLoading && display === null) ||
    (display === null && hasCurrent !== null);

  async function handleSelect(wsId: string): Promise<void> {
    if (user === null || wsId === currentWorkspace?.wsId) {
      setOpen(false);
      return;
    }
    setError(null);
    try {
      await setCurrent(user.uid, wsId);
      setOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar de espacio.");
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Cambiar de espacio"
            className="flex w-full items-center justify-center gap-2 rounded-sm px-2 py-2 outline-none interactive xl:justify-start xl:px-2"
          >
            {loading ? (
              <span
                aria-hidden="true"
                className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-soft"
              />
            ) : (
              <Avatar emoji={display?.emoji ?? "🏠"} size={32} />
            )}
            <span className="hidden min-w-0 max-w-32 flex-1 text-left xl:block">
              {loading ? (
                <span
                  aria-hidden="true"
                  className="block h-5 w-full animate-pulse rounded-full bg-surface-soft"
                />
              ) : (
                <span className="block truncate text-body-sm font-semibold leading-tight text-foreground">
                  {display?.name ?? "Sin espacios"}
                </span>
              )}
            </span>
            <Icon icon={ChevronDown} size={20} className="hidden shrink-0 text-muted-foreground xl:block" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64" align="start">
          <div role="menu" aria-label="Espacios de trabajo" className="flex flex-col">
            {workspaces.map((item) => {
              const selected = item.wsId === display?.wsId;
              return (
                <button
                  key={item.wsId}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-label={`Espacio ${item.name}`}
                  onClick={() => void handleSelect(item.wsId)}
                  className={cn(
                    "flex h-12 w-full items-center gap-3 rounded-sm px-3 text-left outline-none interactive",
                  )}
                >
                  <Avatar emoji={item.emoji} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm font-medium text-foreground">{item.name}</span>
                    <span className="block text-meta leading-tight text-muted-foreground">{kindLabel(item.kind)}</span>
                  </span>
                  {selected ? <Icon icon={Check} size={20} /> : null}
                </button>
              );
            })}
            {workspaces.length === 0 && !isLoading ? (
              <p className="px-3 py-2 text-meta text-muted-foreground">Todavía no tienes espacios.</p>
            ) : null}
            <div aria-hidden="true" className="mx-2 my-2 h-px bg-divider" />
            <MenuItem
              icon={Plus}
              role="menuitem"
              aria-label="Crear espacio"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              Crear espacio
            </MenuItem>
            {error !== null ? (
              <p role="alert" className="px-3 py-1 text-meta text-danger">
                {error}
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
