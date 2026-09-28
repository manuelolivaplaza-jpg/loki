import { ChatList } from "@/components/chat/chat-list";
import { ConversationView } from "@/components/chat/conversation-view";

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
