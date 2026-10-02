"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  BarChart3,
  Brain,
  CalendarPlus,
  FolderPlus,
  Lightbulb,
  ListPlus,
  Mic,
  Send,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogOverlay,
} from "@/components/ui/dialog";
import { InviteDialog } from "@/components/members/invite-dialog";
import { PollSheet } from "@/components/polls/poll-sheet";
import { useWorkspaces } from "@/stores/workspace-store";
import { MenuItem } from "@/components/ui/menu-card";
import { fade, slideUp, stagger, fadeScale } from "@/lib/motion";

export type QuickAction = {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Destino real en la app (invitar abre su diálogo en vez de navegar). */
  href: string | null;
};

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: "idea", title: "Nueva idea", description: "Anota algo antes de olvidarlo", icon: Lightbulb, href: "/ideas" },
  { key: "evento", title: "Nuevo evento o fecha", description: "Agenda en el calendario", icon: CalendarPlus, href: "/calendario" },
  { key: "proyecto", title: "Nuevo proyecto", description: "Organiza tareas en un espacio", icon: FolderPlus, href: "/proyectos" },
  { key: "lista", title: "Nueva lista", description: "Compras, quehaceres o checklist", icon: ListPlus, href: "/proyectos?tab=listas" },
  { key: "encuesta", title: "Nueva encuesta", description: "Decide rápido en el chat", icon: BarChart3, href: null },
  { key: "post", title: "Compartir algo", description: "Publica un post en el espacio", icon: Send, href: "/chat/publicaciones" },
  { key: "memoria", title: "Recordar algo", description: "Guarda un dato útil del espacio", icon: Brain, href: "/memoria" },
  { key: "dictar", title: "Dictar a Loki", description: "Habla y Loki lo convierte en tareas", icon: Mic, href: "/chat/loki-ia?dictar=1" },
  { key: "invitar", title: "Invitar miembro", description: "Suma a alguien a tu espacio", icon: UserPlus, href: null },
];

export function QuickActionsList({
  onSelect,
}: {
  onSelect: (action: QuickAction) => void;
}): React.JSX.Element {
  return (
    <div role="menu" aria-label="Acciones rápidas" className="flex flex-col">
      <motion.ul
        variants={stagger}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-1"
      >
        {QUICK_ACTIONS.map((action) => (
          <motion.li key={action.key} variants={slideUp}>
            <MenuItem
              icon={action.icon}
              description={action.description}
              role="menuitem"
              onClick={() => onSelect(action)}
            >
              {action.title}
            </MenuItem>
          </motion.li>
        ))}
      </motion.ul>
    </div>
  );
}

export function PlaceholderDialog({
  title,
  open,
  onClose,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogOverlay className="bg-black/20" />
      <DialogContent className="text-center">
        <DialogTitle className="text-center">{title}</DialogTitle>
        <DialogDescription className="text-center">
          Próximamente
        </DialogDescription>
        <Button type="button" onClick={onClose} className="mx-auto mt-1">
          Cerrar
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function QuickActionDialog({
  action,
  onClose,
}: {
  action: QuickAction | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const { currentWorkspaceId } = useWorkspaces();
  // Invitar ya es real: abre el diálogo con link, código y QR.
  if (action?.key === "invitar") {
    return (
      <InviteDialog
        open={action !== null}
        wsId={currentWorkspaceId}
        onClose={onClose}
      />
    );
  }
  // Encuesta: hoja propia con selector de chat (es un mensaje del chat).
  if (action?.key === "encuesta") {
    if (currentWorkspaceId === null) return null;
    return (
      <PollSheet open wsId={currentWorkspaceId} chatId={null} onClose={onClose} />
    );
  }
  return (
    <PlaceholderDialog
      title={action?.title ?? ""}
      open={action !== null}
      onClose={onClose}
    />
  );
}

/** Tarjeta flotante móvil con las acciones rápidas (reutilizada por BottomNav y header). */
export function QuickActionsMobileMenu({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const router = useRouter();
  const [mounted, setMounted] = React.useState(false);
  const [selected, setSelected] = React.useState<QuickAction | null>(null);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  React.useEffect(() => {
    if (!open) setSelected(null);
  }, [open ]);

  if (!mounted) return null;

  return createPortal(
    <>
      <AnimatePresence>
        {open ? (
          <div className="fixed inset-0 z-30 md:hidden">
            <motion.button
              type="button"
              aria-label="Cerrar acciones rápidas"
              variants={fade}
              initial="hidden"
              animate="show"
              exit="exit"
              onClick={onClose}
              className="absolute inset-0 bg-black/20"
            />
            <motion.div
              variants={fadeScale}
              initial="hidden"
              animate="show"
              exit="exit"
              style={{ transformOrigin: "50% 100%" }}
              className="glass-sheet absolute inset-x-3 bottom-[calc(78px+env(safe-area-inset-bottom))] rounded-xl p-2 shadow-float"
            >
              <QuickActionsList
                onSelect={(action) => {
                  onClose();
                  // Invitar abre su diálogo; el resto navega a su sección.
                  if (action.href === null) setSelected(action);
                  else router.push(action.href);
                }}
              />
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
      <QuickActionDialog action={selected} onClose={() => setSelected(null)} />
    </>,
    document.body,
  );
}
