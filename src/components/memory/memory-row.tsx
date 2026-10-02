"use client";

import * as React from "react";
import { Eye, EyeOff, Lock, Pencil, Pin, PinOff, Share2, Trash2 } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import {
  isMemoryExpired,
  maskedMemoryText,
  memoryCategoryEmoji,
  memoryCategoryLabel,
  memoryDaysToExpiry,
  memoryExpiryLabel,
} from "@/lib/memory/memory";
import type { MemoryItem } from "@/types/organizer";
import { cn } from "@/lib/utils";

/** Mantener pulsado para editar (táctil), como el resto de la app. */
const LONG_PRESS_MS = 500;

export type MemoryRowProps = {
  memory: MemoryItem;
  /** Nombre de quien lo guardó (para el subtítulo). */
  authorName: string;
  /** `true` si puedo editarlo o borrarlo (creador o admin). */
  canManage: boolean;
  /** `true` si es mío (para el "Solo yo" y el botón de compartir). */
  isMine: boolean;
  onEdit: (memory: MemoryItem) => void;
  onDelete: (memory: MemoryItem) => void;
  onTogglePin: (memory: MemoryItem) => void;
  onShare: (memory: MemoryItem) => void;
};

/**
 * Fila de un recuerdo de la memoria del espacio.
 *
 * Gestos equivalentes en las dos plataformas: en móvil se desliza a la
 * izquierda para borrar y se mantiene pulsado (500 ms) para editar; en
 * escritorio, doble clic edita, las acciones aparecen al pasar el ratón y hay
 * atajos (Supr borra, Espacio fija).
 *
 * Los sensibles salen tapados ("Recuerdo sensible · salud", con el texto en
 * blur) y solo se muestran tras una confirmación corta; al ocultar la app
 * (vuelve el móvil al fondo) se vuelven a tapar, para que no queden en la
 * vista previa de las apps recientes.
 */
export function MemoryRow({
  memory,
  authorName,
  canManage,
  isMine,
  onEdit,
  onDelete,
  onTogglePin,
  onShare,
}: MemoryRowProps): React.JSX.Element {
  const [revealed, setRevealed] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const [swipeX, setSwipeX] = React.useState(0);
  const swipeRef = React.useRef({ x: 0, y: 0, active: false });
  const longPressRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelLongPress = React.useCallback((): void => {
    if (longPressRef.current !== null) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);

  React.useEffect(() => cancelLongPress, [cancelLongPress]);

  // Al ocultar la app se tapa lo sensible (vista previa de apps recientes).
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") {
        setRevealed(false);
        setConfirming(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Si el recuerdo cambia, vuelve a estar tapado.
  const previousId = React.useRef(memory.id);
  React.useEffect(() => {
    if (previousId.current === memory.id) return;
    previousId.current = memory.id;
    setRevealed(false);
    setConfirming(false);
    setSwipeX(0);
  }, [memory.id]);

  const hidden = memory.sensitive && revealed === false;
  const expiresAt = memory.expiresAt !== null ? memory.expiresAt.toDate() : null;
  const expired = isMemoryExpired(expiresAt);
  const daysLeft = memoryDaysToExpiry(expiresAt);

  function startSwipe(event: React.PointerEvent): void {
    if (memory.sensitive) return;
    swipeRef.current = { x: event.clientX, y: event.clientY, active: true };
    cancelLongPress();
    longPressRef.current = setTimeout(() => {
      onEdit(memory);
    }, LONG_PRESS_MS);
  }

  function moveSwipe(event: React.PointerEvent): void {
    const swipe = swipeRef.current;
    if (swipe.active === false || event.buttons === 0) {
      cancelLongPress();
      return;
    }
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) cancelLongPress();
    if (dx < -10 && Math.abs(dx) > Math.abs(dy)) {
      setSwipeX(Math.max(dx, -96));
    }
  }

  function endSwipe(): void {
    swipeRef.current.active = false;
    cancelLongPress();
    const offset = swipeX;
    setSwipeX(0);
    if (offset <= -64) onDelete(memory);
  }

  /** Un toque pone la confirmación; el siguiente lo muestra. Nunca solo. */
  function handleReveal(): void {
    if (confirming === false) {
      setConfirming(true);
      return;
    }
    setRevealed(true);
    setConfirming(false);
  }

  /** Teclado de escritorio: Supr borra y Espacio fija. */
  function handleKey(event: React.KeyboardEvent): void {
    if (event.key === "Delete" && canManage) {
      event.preventDefault();
      onDelete(memory);
      return;
    }
    if (event.key === " " && canManage) {
      event.preventDefault();
      onTogglePin(memory);
    }
  }

  const meta: string[] = [memoryCategoryLabel(memory.category), authorName];
  if (memory.visibility === "privado") meta.push("Solo yo");
  if (memory.expiresAt !== null) {
    meta.push(memoryExpiryLabel(expiresAt));
  } else if (memory.pinned) {
    meta.push("Fijado");
  }
  if (expired) meta.unshift("Caducado");

  const soonExpiry =
    daysLeft !== null && expired === false && daysLeft <= 7 && hidden === false;
  const soonText =
    daysLeft === 0 ? "Caduca hoy" : `Caduca en ${daysLeft} ${daysLeft === 1 ? "día" : "días"}`;

  return (
    <li
      className="relative"
      onPointerDown={startSwipe}
      onPointerMove={moveSwipe}
      onPointerUp={endSwipe}
      onPointerCancel={endSwipe}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setHovered(false);
      }}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      {/* Aviso de borrado al deslizar (táctil, como en las listas). */}
      {swipeX < -8 ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4 text-danger"
        >
          <Icon icon={Trash2} size={20} />
        </span>
      ) : null}
      <div
        className={cn(
          "flex min-h-12 w-full items-start gap-3 rounded-xl bg-surface-soft px-3 py-3 text-left",
          "touch-pan-y",
          swipeX === 0 ? "transition-transform" : "",
          hovered ? "ring-1 ring-accent/40" : "",
        )}
        style={swipeX !== 0 ? { transform: `translateX(${swipeX}px)` } : undefined}
      >
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-title">
          {memoryCategoryEmoji(memory.category)}
        </span>
        {/* El texto es el botón (así no hay botones anidados): en un sensible
            abre la confirmación y en el resto edita. */}
        <button
          type="button"
          aria-label={`${memoryCategoryLabel(memory.category)}. ${
            hidden ? "Recuerdo sensible oculto" : memory.content
          }`}
          onKeyDown={handleKey}
          onDoubleClick={() => {
            if (hidden === false) onEdit(memory);
          }}
          onClick={() => {
            if (hidden) handleReveal();
            else onEdit(memory);
          }}
          className="min-w-0 flex-1 text-left outline-none"
        >
          {memory.sensitive ? (
            <span className="mb-1 flex items-center gap-1 text-meta leading-4 text-muted-foreground">
              <Icon icon={Lock} size={20} aria-hidden="true" />
              {hidden ? maskedMemoryText(memory.category) : "Visible"}
            </span>
          ) : null}
          {/* Tapado de verdad: `aria-hidden` para lectores de pantalla y blur
              para el ojo (el texto sigue en el DOM, como en un campo de
              contraseña, y por eso tampoco se copia con Ctrl+C). */}
          <span
            className={cn(
              "block text-body-sm leading-5 text-foreground",
              hidden ? "select-none" : "",
            )}
            style={hidden ? { filter: "blur(6px)" } : undefined}
            aria-hidden={hidden}
          >
            {memory.content}
          </span>
          <span className="block text-meta leading-4 text-muted-foreground">
            {meta.join(" · ")}
          </span>
          {soonExpiry ? (
            <span className="block text-meta leading-4 text-warning">{soonText}</span>
          ) : null}
        </button>
        {confirming && hidden ? (
          <span className="absolute inset-x-3 bottom-2 flex items-center gap-1 rounded-lg bg-background px-2 py-1 text-body-sm leading-5 text-foreground shadow-float">
            <span className="min-w-0 flex-1">¿Mostrar este recuerdo?</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleReveal();
              }}
              className="min-h-11 rounded-full px-3 font-semibold text-accent outline-none interactive"
            >
              Sí
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setConfirming(false);
              }}
              className="min-h-11 rounded-full px-3 font-semibold text-muted-foreground outline-none interactive"
            >
              No
            </button>
          </span>
        ) : null}
        {/* Acciones: siempre en táctil (fila) y al hover/foco en escritorio. */}
        <span
          className={cn(
            "flex shrink-0 items-center opacity-100",
            "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity",
            hovered ? "[@media(hover:hover)]:opacity-100" : "",
          )}
        >
          {memory.sensitive && hidden ? (
            <IconButton
              variant="ghost"
              aria-label="Mostrar recuerdo sensible"
              onClick={(event) => {
                event.stopPropagation();
                handleReveal();
              }}
            >
              <Icon icon={confirming ? EyeOff : Eye} size={20} />
            </IconButton>
          ) : null}
          {memory.sensitive && revealed ? (
            <IconButton
              variant="ghost"
              aria-label="Ocultar recuerdo sensible"
              onClick={(event) => {
                event.stopPropagation();
                setRevealed(false);
              }}
            >
              <Icon icon={EyeOff} size={20} />
            </IconButton>
          ) : null}
          {canManage && memory.sensitive === false ? (
            <IconButton
              variant="ghost"
              aria-label={memory.pinned ? "No fijar" : "Fijar"}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(memory);
              }}
            >
              <Icon icon={memory.pinned ? PinOff : Pin} size={20} />
            </IconButton>
          ) : null}
          {canManage && isMine && memory.visibility === "privado" ? (
            <IconButton
              variant="ghost"
              aria-label="Compartir con el espacio"
              onClick={(event) => {
                event.stopPropagation();
                onShare(memory);
              }}
            >
              <Icon icon={Share2} size={20} />
            </IconButton>
          ) : null}
          {canManage ? (
            <IconButton
              variant="ghost"
              aria-label="Editar recuerdo"
              onClick={(event) => {
                event.stopPropagation();
                onEdit(memory);
              }}
            >
              <Icon icon={Pencil} size={20} />
            </IconButton>
          ) : null}
          {canManage ? (
            <IconButton
              variant="ghost"
              aria-label="Borrar recuerdo"
              className="text-danger"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(memory);
              }}
            >
              <Icon icon={Trash2} size={20} />
            </IconButton>
          ) : null}
        </span>
      </div>
    </li>
  );
}