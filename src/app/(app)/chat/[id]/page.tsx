"use client";

import { useParams } from "next/navigation";
import { ArrowUp, Mic, Plus } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { EXAMPLE_MESSAGES, getChatById } from "@/lib/data/chats";
import { cn } from "@/lib/utils";

// TODO(fase-2): vista de ejemplo; mensajes reales y envío en fase 2.
export default function ConversationPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const chat = getChatById(params.id);

  return (
    <div className="flex min-h-[calc(100dvh-68px)] flex-col md:min-h-[calc(100dvh-48px)]">
      <span className="sr-only">
        Conversación con {chat?.name ?? "chat"}
      </span>
      <ul className="flex flex-1 flex-col justify-end gap-2 px-4 py-4 md:mx-auto md:w-full md:max-w-2xl">
        {EXAMPLE_MESSAGES.map((message) => {
          const mine = message.from === "me";
          return (
            <li
              key={message.id}
              className={cn("flex", mine ? "justify-end" : "justify-start")}
            >
              <p
                className={cn(
                  "max-w-[80%] rounded-lg px-4 py-2 text-body-sm leading-6",
                  mine
                    ? "bg-foreground text-background dark:bg-white dark:text-black"
                    : "bg-surface-soft text-foreground",
                )}
              >
                {message.text}
              </p>
            </li>
          );
        })}
      </ul>

      <div className="sticky bottom-0 bg-gradient-to-t from-background via-background/85 to-transparent px-3 pb-[calc(12px+env(safe-area-inset-bottom))] pt-6 md:pb-6">
        <div className="flex items-center gap-2 md:mx-auto md:max-w-2xl">
          <IconButton variant="floating" aria-label="Adjuntar" title="Próximamente">
            <Icon icon={Plus} size={24} />
          </IconButton>
          <div className="flex h-12 min-w-0 flex-1 items-center gap-1 rounded-full bg-surface-soft py-2 pl-4 pr-2">
            <input
              readOnly
              placeholder="Escribe un mensaje"
              aria-label="Escribe un mensaje"
              className="min-w-0 flex-1 bg-transparent text-body-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <IconButton variant="ghost" aria-label="Dictar por voz" title="Próximamente" className="h-10 w-10">
              <Icon icon={Mic} size={20} />
            </IconButton>
            <IconButton variant="solid" aria-label="Enviar mensaje" title="Próximamente" className="h-10 w-10">
              <Icon icon={ArrowUp} size={20} />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}
