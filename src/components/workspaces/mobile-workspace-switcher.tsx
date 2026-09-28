"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Plus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { MenuItem } from "@/components/ui/menu-card";
import { Pill } from "@/components/ui/pill";
import { fade, fadeScale } from "@/lib/motion";
import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";
import { kindLabel } from "@/components/workspaces/workspace-options";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceStore, useWorkspaces } from "@/stores/workspace-store";
import { useProfileStore } from "@/stores/profile-store";
import { cn } from "@/lib/utils";

export function MobileWorkspaceSwitcher(): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const { workspaces, currentWorkspace, currentWorkspaceId, isLoading } = useWorkspaces();
  const setCurrent = useWorkspaceStore((state) => state.setCurrent);
  const [open, setOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const display = currentWorkspace ?? workspaces[0] ?? null;
  // Mientras carga (o mientras el perfil ya apunta a un espacio que la
  // lista aún no trae) nunca se muestra el genérico "Espacios": skeleton
  // con el nombre real en cuanto llega.
  const hasCurrent =
    currentWorkspaceId ?? profile?.currentWorkspaceId ?? null;
  const loading =
    (isLoading && display === null) ||
    (display === null && hasCurrent !== null);

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
      <Pill
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Cambiar de espacio"
        onClick={() => setOpen(true)}
        leading={
          loading ? (
            <span
              aria-hidden="true"
              className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-surface-soft"
            />
          ) : (
            <span aria-hidden="true" className="text-body leading-none">
              {display?.emoji ?? "🏠"}
            </span>
          )
        }
        text={loading ? "Cargando" : (display?.name ?? "Espacios")}
        className={loading ? "animate-pulse" : undefined}
      />

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
                    variants={fade}
                    initial="hidden"
                    animate="show"
                    exit="exit"
                    onClick={() => setOpen(false)}
                    className="absolute inset-0 bg-black/20"
                  />
                  <motion.div
                    variants={fadeScale}
                    initial="hidden"
                    animate="show"
                    exit="exit"
                    style={{ transformOrigin: "50% 100%" }}
                    className="glass-sheet absolute inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))] max-h-[80dvh] overflow-y-auto p-2"
                  >
                    <div role="menu" aria-label="Espacios de trabajo" className="flex flex-col gap-1">
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
                              "flex h-12 w-full items-center gap-3 rounded-sm px-3 py-2 text-left outline-none interactive",
                            )}
                          >
                            <Avatar emoji={item.emoji} size={32} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body font-medium text-foreground">{item.name}</span>
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
