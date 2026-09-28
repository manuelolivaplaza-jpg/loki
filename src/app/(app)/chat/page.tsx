import { ListRow } from "@/components/ui/list-row";
import { EXAMPLE_CHATS } from "@/lib/data/chats";

// TODO(fase-2): lista de ejemplo; traer conversaciones reales de Firestore.
export default function ChatPage(): React.JSX.Element {
  return (
    <ul className="px-2 py-2 md:px-4">
      {EXAMPLE_CHATS.map((chat) => (
        <li key={chat.id}>
          <ListRow
            href={`/chat/${chat.id}`}
            title={chat.name}
            subtitle={chat.preview}
            meta={chat.time}
            unread={chat.unread}
            initial={chat.name.charAt(0)}
            color={chat.color}
          />
        </li>
      ))}
    </ul>
  );
}
