"use client";

import * as React from "react";
import { AttachmentsGrid } from "@/components/media/attachments-grid";
import { FileCard } from "@/components/media/file-card";
import { VoiceMessage } from "@/components/media/voice-message";
import { VoiceTranscription } from "@/components/media/transcription-panel";
import type { MessageAttachment } from "@/types/chat";
import { cn } from "@/lib/utils";

export type AttachmentsTone = "mine" | "other" | "flat";

/** Contexto de visibilidad: la transcripción hereda la del mensaje. */
export type VoiceContext = {
  messageId: string;
  chatId: string;
  authorId: string | null;
};

/**
 * Render de adjuntos de un mensaje: imágenes/video en mosaico, audios como
 * notas de voz y el resto como tarjetas de archivo. Lo usan la burbuja del
 * chat y la fila plana de Publicaciones (mismo componente en los dos).
 *
 * Con `voice` (mensaje de un chat de espacio), cada nota de voz además ofrece
 * "Ver transcripción": el texto se pide bajo demanda y hereda la visibilidad
 * del mensaje (en un DM, solo sus miembros).
 */
export function MessageAttachments({
  attachments,
  tone = "other",
  voice = null,
}: {
  attachments: readonly MessageAttachment[];
  tone?: AttachmentsTone;
  voice?: VoiceContext | null;
}): React.JSX.Element | null {
  if (attachments.length === 0) return null;
  const media = attachments.filter(
    (item): item is MessageAttachment & { kind: "image" | "video" } =>
      item.kind === "image" || item.kind === "video",
  );
  const audios = attachments.filter((item) => item.kind === "audio");
  const files = attachments.filter(
    (item) => item.kind !== "image" && item.kind !== "video" && item.kind !== "audio",
  );
  return (
    <div className="flex w-full flex-col gap-1.5">
      {media.length > 0 ? <AttachmentsGrid items={media} /> : null}
      {audios.map((item, index) => (
        <div
          key={`${item.url}-${index}`}
          className={cn(
            "w-full rounded-2xl px-2 py-1.5",
            tone === "mine" && "bg-bubble-mine",
            tone === "other" && "bg-bubble-other",
            tone === "flat" && "bg-surface-soft",
          )}
        >
          <VoiceMessage url={item.url} duration={item.duration} dark={tone === "mine"} />
          {voice !== null ? (
            <VoiceTranscription
              attachment={item}
              messageId={voice.messageId}
              chatId={voice.chatId}
              authorId={voice.authorId}
              dark={tone === "mine"}
            />
          ) : null}
        </div>
      ))}
      {files.map((item, index) => (
        <FileCard key={`${item.url}-${index}`} attachment={item} />
      ))}
    </div>
  );
}
