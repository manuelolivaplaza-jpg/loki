"use client";

import { formatTypingText } from "@/lib/chat/format";

type TypingIndicatorProps = {
  /** Nombres de quién está escribiendo (sin mí). */
  names: readonly string[];
};

/**
 * Aviso "X está escribiendo…" debajo de los mensajes (T14).
 * Nada si no hay nadie escribiendo.
 */
export function TypingIndicator({ names }: TypingIndicatorProps): React.JSX.Element | null {
  const text = formatTypingText(names);
  if (text === null) return null;
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-1">
      <p aria-live="polite" className="text-meta leading-5 text-muted-foreground">
        {text}
      </p>
    </div>
  );
}
