import { ChatList } from "@/components/chat/chat-list";
import { ConversationView } from "@/components/chat/conversation-view";

/**
 * T18: conversación con Loki IA.
 *
 * La lista de la izquierda es la de siempre (el chat de IA está fijado) y a
 * la derecha la conversación real: mensajes de Firestore en
 * `users/{uid}/aiChats/loki-ia/messages`, respuesta de la IA sin burbuja y
 * chips de arranque cuando el chat está vacío. Con la IA apagada
 * (`NEXT_PUBLIC_AI_ENABLED !== "true"`, el default de fase 1-2) la respuesta
 * es un MOCK escrito por la app y revelado palabra a palabra.
 */
export default function LokiIaPage(): React.JSX.Element {
  return (
    <div className="md:flex md:items-stretch">
      <div className="hidden min-w-0 md:block md:w-[340px] md:max-w-[340px] md:shrink-0 md:border-r md:border-divider">
        <ChatList />
      </div>
      <div className="min-w-0 flex-1">
        <ConversationView chatId="loki-ia" />
      </div>
    </div>
  );
}
