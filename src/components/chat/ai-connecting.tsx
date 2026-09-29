"use client";

import { Sparkles } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { AI_CONNECTING_TEXT } from "@/lib/chat/ai-mock";

/**
 * T18: "Conectando con Loki…".
 *
 * Aparece SOLO con `NEXT_PUBLIC_AI_ENABLED === "true"`, mientras se espera
 * la respuesta de la callable `aiChat` (que todavía no se llama desde el
 * cliente). Con la IA apagada no se muestra: la respuesta simulada aparece
 * directamente con su prefijo "[Simulado] " (ver `conversation-view.tsx`).
 */
export function AiConnecting(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-1">
      <p
        aria-live="polite"
        className="flex items-center gap-1.5 text-meta leading-5 text-muted-foreground"
      >
        <Icon icon={Sparkles} size={20} />
        {AI_CONNECTING_TEXT}
      </p>
    </div>
  );
}
