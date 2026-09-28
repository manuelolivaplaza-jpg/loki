"use client";

import { cn } from "@/lib/utils";

type ReactionChipsProps = {
  /** Emoji -> uids que reaccionaron (mapa del documento). */
  reactions: Record<string, string[]>;
  currentUid: string | null;
  /** Toca un chip: alterna mi uid en ese emoji. */
  onToggle: (emoji: string, hasReacted: boolean) => void;
};

/**
 * Chips de reacciones bajo la burbuja: emoji + contador.
 *
 * El chip propio se marca con `aria-pressed` y un borde/accent sutil;
 * tocarlo (propio o ajeno) alterna únicamente mi uid, que es lo que
 * permite la escritura de `toggleReaction` en Firestore.
 */
export function ReactionChips({
  reactions,
  currentUid,
  onToggle,
}: ReactionChipsProps): React.JSX.Element | null {
  const entries = Object.entries(reactions ?? {})
    .filter(([, uids]) => Array.isArray(uids) && uids.length > 0)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;
  return (
    <div aria-label="Reacciones" className="flex max-w-full flex-wrap gap-1 pt-1">
      {entries.map(([emoji, uids]) => {
        const mine = currentUid !== null && uids.includes(currentUid);
        return (
          <button
            key={emoji}
            type="button"
            aria-pressed={mine}
            aria-label={`${emoji}: ${uids.length} ${uids.length === 1 ? "reacción" : "reacciones"}${mine ? ", la tuya. Tocar para quitar" : ". Tocar para añadir"}`}
            onClick={() => onToggle(emoji, mine)}
            className={cn(
              "flex h-6 items-center justify-center gap-1 rounded-full px-2 text-[13px] leading-none outline-none",
              "bg-surface-soft text-foreground interactive",
              mine && "border border-accent/60 bg-accent/10 text-accent",
            )}
          >
            <span aria-hidden="true">{emoji}</span>
            <span className="font-medium tabular-nums">{uids.length}</span>
          </button>
        );
      })}
    </div>
  );
}
