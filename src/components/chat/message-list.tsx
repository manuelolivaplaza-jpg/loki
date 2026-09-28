"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { DaySeparator } from "@/components/chat/day-separator";
import { MessageBubble } from "@/components/chat/message-bubble";
import { dayKey, formatDayLabel, groupMessages, toDateSafe } from "@/lib/chat/format";
import { spring } from "@/lib/motion";
import type { MessageDoc } from "@/types/chat";
import { cn } from "@/lib/utils";

type MessageListProps = {
  messages: MessageDoc[];
  currentUid: string | null;
  /** Ids que llegaron tras el montaje: se animan con el spring único. */
  animatedIds: Set<string>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  isLoadingOlder: boolean;
  hasMore: boolean;
};

/**
 * Lista de mensajes con rol log: agrupa por autor (<5 min), separa por
 * día y anima solo los mensajes nuevos (fade + translateY 8px).
 */
export function MessageList({
  messages,
  currentUid,
  animatedIds,
  topSentinelRef,
  isLoadingOlder,
  hasMore,
}: MessageListProps): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const groups = React.useMemo(
    () => groupMessages(messages, currentUid),
    [messages, currentUid],
  );

  let lastDay = "";
  const items: React.ReactNode[] = [];
  for (const group of groups) {
    const first = group.messages[0];
    if (first === undefined) continue;
    const key = dayKey(first.createdAt);
    if (key !== lastDay) {
      lastDay = key;
      // Sin fecha (serverTimestamp pendiente) = ahora: separador "Hoy".
      const date = toDateSafe(first.createdAt) ?? new Date();
      items.push(
        <li key={`day-${key}-${first.id}`} aria-hidden="false">
          <DaySeparator label={formatDayLabel(date)} />
        </li>,
      );
    }
    const isAiGroup = first.type === "ai";
    items.push(
      <li
        key={group.key}
        className={cn(group.isMine && !isAiGroup ? "flex justify-end" : "flex justify-start")}
      >
        <div
          className={cn(
            "flex w-full flex-col",
            group.isMine && first.type !== "ai" && first.type !== "system"
              ? "items-end gap-[2px]"
              : "gap-[2px]",
            !group.isMine && first.type !== "ai" && first.type !== "system" && "gap-[2px]",
          )}
        >
          {group.messages.map((message, index) => {
            const animate = animatedIds.has(message.id) && !reduceMotion;
            const bubble = (
              <MessageBubble
                message={message}
                isMine={group.isMine}
                showAuthor={index === 0}
                showTime={index === group.messages.length - 1}
              />
            );
            if (!animate) return <div key={message.id}>{bubble}</div>;
            return (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring}
              >
                {bubble}
              </motion.div>
            );
          })}
        </div>
      </li>,
    );
  }

  return (
    <ul
      role="log"
      aria-live="polite"
      aria-label="Mensajes de la conversación"
      className="flex flex-col gap-3 px-4 py-4"
    >
      <li aria-hidden="true">
        <div ref={topSentinelRef} className="h-1" />
        {isLoadingOlder || (hasMore && messages.length > 0) ? (
          <div className="flex justify-center py-2" aria-hidden="true">
            {isLoadingOlder ? (
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-divider border-t-muted-foreground" />
            ) : (
              <span className="h-1" />
            )}
          </div>
        ) : null}
      </li>
      {items}
    </ul>
  );
}
