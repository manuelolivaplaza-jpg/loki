"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { ChatList } from "@/components/chat/chat-list";
import { ConversationView } from "@/components/chat/conversation-view";

function ConversationByQuery(): React.JSX.Element {
  const searchParams = useSearchParams();
  // "Dictar a Loki" desde Acciones rápidas: abre el chat con el micrófono.
  const dictate = searchParams.get("dictar") === "1";
  return <ConversationView chatId="loki-ia" openDictate={dictate} />;
}

/**
 * Conversación con Loki IA.
 *
 * La lista de la izquierda es la de siempre (el chat de IA está fijado) y a
 * la derecha la conversación real: mensajes de `ai_messages` y respuesta de
 * la Edge Function `loki-chat` con streaming en vivo. Sin proveedor
 * configurado se muestra "Loki IA sin configurar" y el composer se
 * deshabilita (no hay mock ni "[Simulado]").
 *
 * `?dictar=1` abre el micrófono de "Dictar a Loki" al entrar (viene de
 * Acciones rápidas). Se lee en un hijo con Suspense porque el export es
 * estático.
 */
export default function LokiIaPage(): React.JSX.Element {
  return (
    <div className="md:flex md:items-stretch md:overflow-hidden">
      <div className="hidden min-w-0 md:block md:h-dvh md:w-[340px] md:max-w-[340px] md:shrink-0 md:overflow-y-auto md:border-r md:border-divider">
        <ChatList />
      </div>
      <div className="min-w-0 flex-1">
        <React.Suspense fallback={<div className="min-h-[calc(100dvh-68px)]" />}>
          <ConversationByQuery />
        </React.Suspense>
      </div>
    </div>
  );
}
