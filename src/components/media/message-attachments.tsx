"use client";

import { AttachmentsGrid } from "@/components/media/attachments-grid";
import { FileCard } from "@/components/media/file-card";
import { VoiceMessage } from "@/components/media/voice-message";
import type { MessageAttachment } from "@/types/chat";
import { cn } from "@/lib/utils";

export type AttachmentsTone = "mine" | "other" | "flat";

/**
 * Render de adjuntos de un mensaje: imágenes/video en mosaico, audios como
 * notas de voz y el resto como tarjetas de archivo. Lo usan la burbuja del
 * chat y la fila plana de Publicaciones (mismo componente en los dos).
 */
export function MessageAttachments({
  attachments,
  tone = "other",
}: {
  attachments: readonly MessageAttachment[];
  tone?: AttachmentsTone;
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
        </div>
      ))}
      {files.map((item, index) => (
        <FileCard key={`${item.url}-${index}`} attachment={item} />
      ))}
    </div>
  );
}
