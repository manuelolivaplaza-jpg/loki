"use client";

import { Sparkles } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { AI_CONNECTING_TEXT } from "@/lib/ai/constants";

/**
 * "Conectando con Loki…".
 *
 * Aparece en `/chat/loki-ia` mientras la Edge Function genera la respuesta
 * (streaming real). Sin proveedor configurado no se muestra: en su lugar va
 * el aviso "Loki IA sin configurar" (ver `conversation-view.tsx`).
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
