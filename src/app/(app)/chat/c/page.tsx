"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { ChatList } from "@/components/chat/chat-list";
import { ConversationView } from "@/components/chat/conversation-view";
import { EmptyState } from "@/components/ui/empty-state";

function ConversationByQuery(): React.JSX.Element {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  if (id === "") {
    return (
      <div className="flex h-[calc(100dvh-68px)] items-center justify-center md:h-dvh">
        <EmptyState
          icon={MessageCircle}
          title="Elige una conversación"
          description="Selecciona un chat de la lista para ver sus mensajes."
        />
      </div>
    );
  }
  return <ConversationView chatId={id} />;
}

export default function ChatConversationPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<div className="min-h-[calc(100dvh-68px)]" />}>
      <div className="md:flex md:items-stretch md:overflow-hidden">
        <div className="hidden min-w-0 md:block md:h-dvh md:w-[340px] md:max-w-[340px] md:shrink-0 md:overflow-y-auto md:border-r md:border-divider">
          <ChatList />
        </div>
        <div className="min-w-0 flex-1">
          <ConversationByQuery />
        </div>
      </div>
    </React.Suspense>
  );
}
