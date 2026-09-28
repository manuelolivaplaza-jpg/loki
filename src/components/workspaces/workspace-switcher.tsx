"use client";

import * as React from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";
import { kindLabel } from "@/components/workspaces/workspace-options";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceStore, useWorkspaces } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

export function WorkspaceSwitcher(): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const { workspaces, currentWorkspace } = useWorkspaces();
  const setCurrent = useWorkspaceStore((state) => state.setCurrent);
  const [open, setOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const display = currentWorkspace ?? workspaces[0] ?? null;

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
            className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent xl:px-2"
          >
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-xl"
            >
              {display?.emoji ?? "🏠"}
            </span>
            <span className="hidden min-w-0 flex-1 text-left xl:block">
              <span className="block truncate text-[15px] font-semibold leading-tight text-foreground">
                {display?.name ?? "Sin espacios"}
              </span>
              <span className="block text-[13px] leading-tight text-muted-foreground">
                {display !== null ? kindLabel(display.kind) : "Crea uno nuevo"}
              </span>
            </span>
            <ChevronDown aria-hidden="true" className="hidden h-4 w-4 shrink-0 text-muted-foreground xl:block" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 rounded-2xl" align="start">
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
                    "flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent",
                  )}
                >
                  <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 text-lg">
                    {item.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-foreground">{item.name}</span>
                    <span className="block text-[12px] leading-tight text-muted-foreground">{kindLabel(item.kind)}</span>
                  </span>
                  {selected ? <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground" /> : null}
                </button>
              );
            })}
            {workspaces.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-muted-foreground">Todavía no tienes espacios.</p>
            ) : null}
            <div aria-hidden="true" className="my-1.5 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              aria-label="Crear espacio"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
              className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[14px] font-medium text-foreground outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Crear espacio
            </button>
            {error !== null ? (
              <p role="alert" className="px-2.5 py-1 text-[13px] text-danger">
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
