"use client";

import { FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, File as FileIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { formatFileSize } from "@/lib/media/audio";
import type { MessageAttachment } from "@/types/chat";

function iconFor(name: string, mime: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].includes(ext)) {
    return FileImage;
  }
  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) {
    return FileVideo;
  }
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "opus"].includes(ext)) {
    return FileAudio;
  }
  if (ext === "pdf") return FileText;
  if (["doc", "docx", "txt", "md", "rtf", "odt"].includes(ext)) return FileText;
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return FileSpreadsheet;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return FileArchive;
  return FileIcon;
}

/**
 * Tarjeta de archivo genérico: icono por extensión, nombre, tamaño legible
 * y botón de descarga. Se usa en el chat y en las publicaciones.
 */
export function FileCard({ attachment }: { attachment: MessageAttachment }): React.JSX.Element {
  const FileTypeIcon = iconFor(attachment.name, attachment.mime);
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-divider bg-surface-soft px-3 py-2.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface text-muted-foreground">
        <Icon icon={FileTypeIcon} size={22} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm font-medium leading-5 text-foreground">
          {attachment.name}
        </span>
        <span className="block text-meta leading-4 text-muted-foreground">
          {formatFileSize(attachment.size)}
        </span>
      </span>
      <a
        href={attachment.url}
        download={attachment.name}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Descargar ${attachment.name}`}
        className="flex h-9 shrink-0 items-center rounded-full px-3 text-body-sm font-semibold text-accent outline-none interactive active:bg-surface"
      >
        Descargar
      </a>
    </div>
  );
}
