"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Play } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import type { MessageAttachment } from "@/types/chat";
import { cn } from "@/lib/utils";

/**
 * Visor de adjuntos por code splitting: pesa (gestos + zoom) y solo se
 * descarga al abrir el primer adjunto.
 */
const AttachmentViewer = dynamic(
  () => import("@/components/media/attachment-viewer").then((mod) => mod.AttachmentViewer),
  { ssr: false },
);

type MediaItem = MessageAttachment & { kind: "image" | "video" };

/**
 * Mosaico de 1-4 imágenes/videos (1 = grande, 2 = lado a lado, 3 = una alta
 * + dos apiladas, 4 = 2x2 con "+N" si hay más). Tocar abre el visor a pantalla
 * completa. Se usa en el chat y en las publicaciones.
 */
export function AttachmentsGrid({ items }: { items: MediaItem[] }): React.JSX.Element {
  const [viewerIndex, setViewerIndex] = React.useState<number | null>(null);
  if (items.length === 0) return <></>;

  const visible = items.slice(0, 4);
  const extra = items.length - visible.length;

  const openViewer = (index: number): void => setViewerIndex(index);

  if (visible.length === 1) {
    const item = visible[0] as MediaItem;
    return (
      <>
        <button
          type="button"
          onClick={() => openViewer(0)}
          aria-label="Abrir adjunto a pantalla completa"
          className="block w-full overflow-hidden rounded-2xl outline-none interactive"
        >
          <MediaThumb item={item} large />
        </button>
        {viewerIndex !== null ? (
          <AttachmentViewer
            items={items}
            index={viewerIndex}
            onClose={() => setViewerIndex(null)}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          "grid w-full gap-1 overflow-hidden rounded-2xl",
          visible.length === 2 && "grid-cols-2",
          visible.length === 3 && "grid-cols-2 grid-rows-2",
          visible.length >= 4 && "grid-cols-2",
        )}
      >
        {visible.map((item, index) => (
          <button
            key={`${item.url}-${index}`}
            type="button"
            onClick={() => openViewer(index)}
            aria-label={`Abrir adjunto ${index + 1} de ${items.length}`}
            className={cn(
              "relative block min-h-0 w-full overflow-hidden outline-none interactive",
              visible.length === 3 && index === 0 && "row-span-2 h-full min-h-40",
              "h-32",
              visible.length === 1 && "h-auto",
            )}
          >
            <MediaThumb item={item} />
            {index === visible.length - 1 && extra > 0 ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-title font-bold text-white">
                +{extra}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {viewerIndex !== null ? (
        <AttachmentViewer
          items={items}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </>
  );
}

function MediaThumb({ item, large = false }: { item: MediaItem; large?: boolean }): React.JSX.Element {
  if (item.kind === "video") {
    return (
      <span className={cn("relative block w-full bg-black", large ? "max-h-72" : "h-full")}>
        <video
          src={item.url}
          preload="metadata"
          playsInline
          className={cn("w-full object-cover", large ? "max-h-72" : "h-32")}
        />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white">
            <Icon icon={Play} size={22} />
          </span>
        </span>
      </span>
    );
  }
  return (
    <img
      src={item.url}
      alt={item.name}
      loading="lazy"
      className={cn("w-full bg-surface object-cover", large ? "max-h-72" : "h-32")}
    />
  );
}
