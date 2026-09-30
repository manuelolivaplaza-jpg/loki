import { MessageCircle } from "lucide-react";
import { ChatList } from "@/components/chat/chat-list";
import { EmptyState } from "@/components/ui/empty-state";

export default function ChatPage(): React.JSX.Element {
  return (
    <div className="md:flex md:items-stretch md:overflow-hidden">
      <div className="min-w-0 flex-1 md:h-dvh md:w-[340px] md:max-w-[340px] md:shrink-0 md:overflow-y-auto md:border-r md:border-divider">
        <ChatList />
      </div>
      <div className="hidden min-w-0 flex-1 md:flex md:items-center md:justify-center">
        <EmptyState
          icon={MessageCircle}
          title="Elige una conversación"
          description="Selecciona un chat de la lista para ver sus mensajes."
        />
      </div>
    </div>
  );
}
