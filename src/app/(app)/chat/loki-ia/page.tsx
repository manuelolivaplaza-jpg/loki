import { ChatList } from "@/components/chat/chat-list";
import { ConversationView } from "@/components/chat/conversation-view";

/**
 * Conversación con Loki IA.
 *
 * La lista de la izquierda es la de siempre (el chat de IA está fijado) y a
 * la derecha la conversación real: mensajes de `ai_messages` y respuesta de
 * la Edge Function `loki-chat` con streaming en vivo. Sin proveedor
 * configurado se muestra "Loki IA sin configurar" y el composer se
 * deshabilita (no hay mock ni "[Simulado]").
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
