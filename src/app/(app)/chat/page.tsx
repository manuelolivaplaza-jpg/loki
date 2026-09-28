import Link from "next/link";
import { ChevronRight, Newspaper, Pin, Sparkles } from "lucide-react";
import { Card, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { ListRow } from "@/components/ui/list-row";
import { SectionLabel } from "@/components/ui/section-label";
import { EXAMPLE_CHATS, LOKI_IA_CHAT } from "@/lib/data/chats";

// TODO(fase-2): lista de ejemplo; traer conversaciones reales de Firestore.
export default function ChatPage(): React.JSX.Element {
  return (
    <div className="px-2 py-2 md:px-4">
      <ul>
        <li>
          <Link
            href="/chat/loki-ia"
            className="flex items-center gap-3 rounded-lg px-2 py-4 outline-none interactive"
          >
            <span
              aria-hidden="true"
              className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-foreground text-background dark:bg-white dark:text-black"
            >
              <Icon icon={Sparkles} size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-body font-semibold leading-6 text-foreground">
                  {LOKI_IA_CHAT.name}
                </span>
                <span className="shrink-0 rounded-full bg-surface-soft px-2 py-0.5 text-meta leading-4 text-muted-foreground">
                  Fijado
                </span>
              </span>
              <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                {LOKI_IA_CHAT.preview}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-meta leading-4 text-muted-foreground">
                {LOKI_IA_CHAT.time}
              </span>
              <span className="flex h-4 items-center">
                <Icon icon={Pin} size={20} className="text-muted-foreground" />
              </span>
            </span>
          </Link>
        </li>
      </ul>

      <div className="mt-2 px-2 md:px-0">
        <SectionLabel>Publicaciones del espacio</SectionLabel>
        <Card>
          <Link
            href="/chat/publicaciones"
            aria-label="Ver publicaciones del espacio"
            className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <CardRow minHeight="15">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-background text-foreground dark:bg-surface-2"
              >
                <Icon icon={Newspaper} size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-semibold leading-6 text-foreground">
                  Publicaciones
                </span>
                <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                  Lo compartido en este espacio
                </span>
              </span>
              <Icon icon={ChevronRight} size={20} className="shrink-0 text-muted-foreground" />
            </CardRow>
          </Link>
        </Card>
      </div>

      <div className="mt-2 px-2 md:px-0">
        <SectionLabel>Conversaciones</SectionLabel>
      </div>
      <ul>
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
    </div>
  );
}
