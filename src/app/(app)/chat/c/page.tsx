"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { ConversationView } from "@/components/chat/conversation-view";

function ConversationByQuery(): React.JSX.Element {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  return <ConversationView chatId={id} />;
}

export default function ChatConversationPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<div className="min-h-[calc(100dvh-68px)]" />}>
      <ConversationByQuery />
    </React.Suspense>
  );
}
