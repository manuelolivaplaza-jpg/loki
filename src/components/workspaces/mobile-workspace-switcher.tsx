"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Plus } from "lucide-react";
import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";
import { kindLabel } from "@/components/workspaces/workspace-options";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceStore, useWorkspaces } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

export function MobileWorkspaceSwitcher(): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const { workspaces, currentWorkspace } = useWorkspaces();
  const setCurrent = useWorkspaceStore((state) => state.setCurrent);
  const [open, setOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const display = currentWorkspace ?? workspaces[0] ?? null;

  async function handleSelect(wsId: string): Promise<void> {
    if (user === null || wsId === display?.wsId) {
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
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Cambiar de espacio"
        onClick={() => setOpen(true)}
        className="flex max-w-[60%] items-center gap-1.5 rounded-full px-2 py-1 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span aria-hidden="true" className="text-[16px] leading-none">
          {display?.emoji ?? "🏠"}
        </span>
        <span className="truncate text-[16px] font-semibold text-foreground">
          {display?.name ?? "Espacios"}
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {mounted
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <div
                  className="fixed inset-0 z-50 md:hidden"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Cambiar de espacio"
                >
                  <motion.button
                    type="button"
                    aria-label="Cerrar selector de espacios"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setOpen(false)}
                    className="absolute inset-0 bg-black/30"
                  />
                  <motion.div
                    initial={{ y: "100%" }}
                    animate={{ y: 0 }}
                    exit={{ y: "100%" }}
                    transition={{ type: "spring", damping: 30, stiffness: 300 }}
                    className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-[20px] border-t border-border bg-background px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-2"
                  >
                    <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-border-strong" />
                    <div role="menu" aria-label="Espacios de trabajo" className="flex flex-col gap-0.5">
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
                  </motion.div>
                </div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
