"use client";

import * as React from "react";
import { EXTENDED_REACTIONS, QUICK_REACTIONS } from "@/lib/chat/reactions";
import { MenuCard } from "@/components/ui/menu-card";
import { cn } from "@/lib/utils";

type ReactionBarProps = {
  /** Alinea la barra al borde exterior de la burbuja (evita recorte). */
  isMine: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
};

/**
 * Barra flotante de reacciones (T16): 6 emojis rápidos + "+" que abre
 * el picker grid de 24 (EXTENDED_REACTIONS).
 *
 * Accesible: role=toolbar con aria-label por emoji ("Reaccionar con X"),
 * Escape y click afuera cierran, el "+" anuncia su estado con
 * aria-expanded. No toca nada de Firestore: solo avisa el emoji.
 */
export function ReactionBar({
  isMine,
  onSelect,
  onClose,
}: ReactionBarProps): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

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

  return (
    <div
      ref={ref}
      data-floating="true"
      className={cn(
        "absolute bottom-full z-30 mb-2 max-w-[calc(100vw-24px)]",
        isMine ? "right-0" : "left-0",
      )}
    >
      <MenuCard
        role="toolbar"
        aria-label="Reacciones rápidas"
        aria-orientation="horizontal"
        className="flex items-center gap-1 p-1.5"
      >
        {QUICK_REACTIONS.map((item) => (
          <button
            key={item.codepoints}
            type="button"
            aria-label={`Reaccionar con ${item.name}`}
            title={item.name}
            onClick={() => onSelect(item.emoji)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[20px] leading-none outline-none interactive active:bg-surface-soft"
          >
            <span aria-hidden="true">{item.emoji}</span>
          </button>
        ))}
        <button
          type="button"
          aria-label={pickerOpen ? "Cerrar lista de emojis" : "Más emojis"}
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[20px] leading-none text-muted-foreground outline-none interactive active:bg-surface-soft"
        >
          <span aria-hidden="true">+</span>
        </button>
      </MenuCard>
      {pickerOpen ? (
        <MenuCard
          role="dialog"
          aria-label="Elegir emoji"
          className="mt-1 grid w-60 grid-cols-6 gap-0.5 p-2"
        >
          {EXTENDED_REACTIONS.map((item) => (
            <button
              key={`picker-${item.codepoints}`}
              type="button"
              aria-label={`Reaccionar con ${item.name}`}
              title={item.name}
              onClick={() => onSelect(item.emoji)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[20px] leading-none outline-none interactive active:bg-surface-soft"
            >
              <span aria-hidden="true">{item.emoji}</span>
            </button>
          ))}
        </MenuCard>
      ) : null}
    </div>
  );
}
