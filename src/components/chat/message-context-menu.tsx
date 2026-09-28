"use client";

import * as React from "react";
import { Copy, MessageSquareReply, Pencil, Reply, Trash2 } from "lucide-react";
import { MenuCard, MenuItem } from "@/components/ui/menu-card";
import type { MessageDoc } from "@/types/chat";
import { cn } from "@/lib/utils";

export type MessageMenuAction =
  | "reply"
  | "thread"
  | "copy"
  | "edit"
  | "delete";

type MessageContextMenuProps = {
  message: MessageDoc;
  isMine: boolean;
  onAction: (action: MessageMenuAction) => void;
  onClose: () => void;
};

/**
 * Menú contextual del mensaje (T16).
 *
 * Acciones: Responder, Responder en hilo, Copiar, Editar y Eliminar
 * (las dos últimas solo del autor). Eliminar pide confirmación suave
 * en línea ("Eliminar mensaje?" con Cancelar/Eliminar) sin salir del
 * menú. Cierra con click afuera o Escape; cuelga del borde exterior de
 * la burbuja para no salirse de la pantalla en móvil.
 */
export function MessageContextMenu({
  message,
  isMine,
  onAction,
  onClose,
}: MessageContextMenuProps): React.JSX.Element | null {
  const ref = React.useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  if (message.deleted) return null;

  return (
    <div
      ref={ref}
      data-floating="true"
      className={cn(
        "absolute top-full z-30 mt-1 w-60",
        isMine ? "right-0" : "left-0",
      )}
    >
      {confirmDelete ? (
        <MenuCard aria-label="Eliminar mensaje" className="p-1">
          <p className="px-3 py-2 text-body-sm font-medium text-foreground">
            Eliminar mensaje?
          </p>
          <p className="px-3 pb-1 text-meta leading-4 text-muted-foreground">
            Deja de verse, pero sigue en el historial.
          </p>
          <div className="flex gap-2 px-2 pb-1 pt-1">
            <button
              type="button"
              autoFocus
              onClick={() => setConfirmDelete(false)}
              className="h-10 flex-1 rounded-full bg-surface-soft text-body-sm font-medium text-foreground outline-none interactive"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => onAction("delete")}
              className="h-10 flex-1 rounded-full bg-danger text-body-sm font-medium text-danger-foreground outline-none interactive-solid"
            >
              Eliminar
            </button>
          </div>
        </MenuCard>
      ) : (
        <MenuCard role="menu" aria-label="Acciones del mensaje">
          <MenuItem
            icon={Reply}
            role="menuitem"
            onClick={() => onAction("reply")}
          >
            Responder
          </MenuItem>
          <MenuItem
            icon={MessageSquareReply}
            role="menuitem"
            onClick={() => onAction("thread")}
          >
            Responder en hilo
          </MenuItem>
          <MenuItem
            icon={Copy}
            role="menuitem"
            onClick={() => onAction("copy")}
          >
            Copiar
          </MenuItem>
          {isMine ? (
            <MenuItem
              icon={Pencil}
              role="menuitem"
              onClick={() => onAction("edit")}
            >
              Editar
            </MenuItem>
          ) : null}
          {isMine ? (
            <MenuItem
              icon={Trash2}
              danger
              role="menuitem"
              onClick={() => setConfirmDelete(true)}
            >
              Eliminar
            </MenuItem>
          ) : null}
        </MenuCard>
      )}
    </div>
  );
}
