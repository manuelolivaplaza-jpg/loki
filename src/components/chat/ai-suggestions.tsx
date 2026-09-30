"use client";

import { AI_SUGGESTIONS } from "@/lib/ai/constants";

type AiSuggestionsProps = {
  /**
   * Al tocar un chip se envía SU TEXTO como mensaje del usuario (mismo
   * camino que escribirlo y pulsar Enter), sin menciones.
   */
  onPick: (text: string) => void;
};

/**
 * T18: sugerencias iniciales de `/chat/loki-ia`.
 *
 * Solo se muestran cuando el chat con Loki está vacío (sin chips flotando
 * sobre la conversación). Tono neutro del sistema: pastilla con borde
 * `divider` y fondo `surface-soft`, la misma en claro y en oscuro.
 */
export function AiSuggestions({ onPick }: AiSuggestionsProps): React.JSX.Element {
  return (
    <ul
      aria-label="Sugerencias para Loki"
      className="flex flex-wrap items-center justify-center gap-2 pb-2"
    >
      {AI_SUGGESTIONS.map((label) => (
        <li key={label}>
          <button
            type="button"
            onClick={() => onPick(label)}
            className="rounded-full border border-divider bg-surface-soft px-3.5 py-2 text-body-sm leading-5 text-foreground outline-none interactive"
          >
            {label}
          </button>
        </li>
      ))}
    </ul>
  );
}
