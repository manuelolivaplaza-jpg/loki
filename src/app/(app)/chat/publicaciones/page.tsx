import { ChatList } from "@/components/chat/chat-list";
import { PostsView } from "@/components/chat/posts-view";

/**
 * Publicaciones (T17): feed real de posts del espacio, con la lista de
 * chats a la izquierda en escritorio (igual que /chat/c y /chat/loki-ia).
 */
export default function PublicacionesPage(): React.JSX.Element {
  return (
    <div className="md:flex md:items-stretch">
      <div className="hidden min-w-0 md:block md:w-[340px] md:max-w-[340px] md:shrink-0 md:border-r md:border-divider">
        <ChatList />
      </div>
      <div className="min-w-0 flex-1">
        <PostsView />
      </div>
    </div>
  );
}
