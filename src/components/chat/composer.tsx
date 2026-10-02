"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUp, FileAudio, File as FileIcon, ImageIcon, Mic, Plus, Sparkles, X } from "lucide-react";
import { AttachMenu, type AttachOption } from "@/components/chat/attach-menu";
import { UploadProgress } from "@/components/media/upload-progress";
import { VoiceRecorder } from "@/components/media/voice-recorder";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { MenuCard } from "@/components/ui/menu-card";
import {
  POSTS_MEDIA_LABEL,
  POSTS_PLACEHOLDER,
  POSTS_PUBLISH_LABEL,
} from "@/lib/chat/posts";
import {
  LOKI_CANDIDATE,
  buildMentionToken,
  filterMentionCandidates,
  getMentionQuery,
  resolveMentionIds,
  type MentionCandidate,
} from "@/lib/chat/mentions";
import { compressImage } from "@/lib/media/compress-image";
import {
  formatDuration,
  voiceExtension,
} from "@/lib/media/audio";
import {
  kindFromFile,
  uploadAttachment,
  validateFileSize,
  type MediaBucket,
  type UploadedAttachment,
} from "@/lib/media/upload";
import { useAuthorAvatarColor } from "@/hooks/use-avatar-color";
import { AI_PLACEHOLDER } from "@/lib/ai/constants";
import { spring } from "@/lib/motion";
import { validMessageText } from "@/lib/validators";
import type { AttachmentKind, MessageAttachment, MessageReplyRef } from "@/types/chat";
import { cn } from "@/lib/utils";

type ComposerProps = {
  chatName: string;
  isLoki: boolean;
  sending: boolean;
  /** Miembros del espacio como candidatos (la entrada fija @Loki se agrega aquí). */
  members: MentionCandidate[];
  /** Texto + uids mencionados + adjuntos ya subidos a Storage. */
  onSend: (text: string, mentions: string[], attachments?: MessageAttachment[]) => void;
  /** Espacio donde se suben los adjuntos (ruta `{wsId}/…`). Sin él, adjuntar avisa. */
  wsId?: string | null;
  /** Bucket de Storage (chat en `chat-media`, publicaciones en `post-media`). */
  mediaBucket?: MediaBucket;
  /** Avisa cada cambio del input (para typing T14). */
  onValueChange?: (value: string) => void;
  /** Texto a editar (T16): el composer entra en modo edición con Enter = guardar. */
  edit?: { id: string; text: string } | null;
  /** Guarda la edición con `editMessage` (texto + uids mencionados). */
  onSaveEdit?: (text: string, mentions: string[]) => void;
  onCancelEdit?: () => void;
  /** Mensaje citado (T16): barra de cita sobre el input. */
  replyTo?: MessageReplyRef | null;
  onCancelReply?: () => void;
  /** Placeholder propio (el hilo usa "Responder en el hilo"). */
  placeholder?: string;
  /** Deshabilita escritura y envío (Loki IA sin configurar). */
  disabled?: boolean;
  /**
   * T17: `post` convierte la barra en el composer superior de Publicaciones
   * (botón de imagen en vez de `+` adjuntos, botón "Publicar" en vez de la
   * flecha, sin menú de menciones ni pastilla de mic). El resto (autogrow
   * 1–6 líneas, Enter con puntero fino, `visualViewport`) es el mismo.
   */
  mode?: "chat" | "post";
  /**
   * En el chat con Loki el micrófono NO manda una nota de voz (ahí no hay
   * adjuntos): abre "Dictar a Loki" (grabar → transcribir → el texto entra al
   * mismo flujo). En los chats de espacio el micrófono manda la nota de voz
   * de siempre, y esto queda en null.
   */
  onDictate?: (() => void) | null;
  /** El dictado está abierto: el botón queda marcado. */
  dictating?: boolean;
  /**
   * Abre la hoja de encuesta (`+` → Encuesta). Sin esto, el `+` no ofrece
   * encuestas: es una función de los chats de espacio, no del chat con Loki
   * ni del feed de Publicaciones.
   */
  onCreatePoll?: (() => void) | null;
};

type MentionState = {
  /** Índice del "@" que abrió el menú. */
  start: number;
  /** Caret al detectar el query (fin del reemplazo al insertar). */
  caret: number;
  query: string;
  active: number;
};

type PendingAttachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Vista previa local (solo imagen/video), se libera al enviar o quitar. */
  previewUrl: string | null;
  duration?: number;
  status: "uploading" | "ready" | "error";
  progress: number;
  result: UploadedAttachment | null;
  error: string | null;
};

/** Texto de una cita en una línea (hasta 80 caracteres). */
function quoteLine(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

/**
 * Opción del menú de menciones. Cada fila resuelve su propio color de
 * avatar con `useAuthorAvatarColor` (determinista por uid, o el del
 * perfil si la fila soy yo), así que no puede vivir dentro de un `.map`
 * del Composer.
 */
function MentionOption({
  candidate,
  active,
  onSelect,
  onHover,
}: {
  candidate: MentionCandidate;
  active: boolean;
  onSelect: (candidate: MentionCandidate) => void;
  onHover: () => void;
}): React.JSX.Element {
  const isLoki = candidate.id === LOKI_CANDIDATE.id || candidate.kind === "loki";
  const isAgent = candidate.kind === "agent";
  const color = useAuthorAvatarColor(candidate.id);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect(candidate);
      }}
      onMouseEnter={onHover}
      className={cn(
        "flex h-12 w-full items-center gap-3 rounded-sm px-3 text-left text-body outline-none",
        active ? "bg-surface" : "bg-transparent",
      )}
    >
      {isLoki ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background dark:bg-white dark:text-black">
          <Icon icon={Sparkles} size={20} />
        </span>
      ) : isAgent ? (
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-[16px] leading-none"
        >
          {candidate.avatarEmoji ?? "🤖"}
        </span>
      ) : (
        <Avatar
          initial={candidate.displayName.charAt(0).toUpperCase()}
          color={color}
          size={28}
        />
      )}
      <span className="min-w-0 flex-1 truncate font-medium">
        @{candidate.displayName}
      </span>
      {isLoki ? (
        <span className="shrink-0 text-meta leading-5 text-muted-foreground">
          @ai · asistente
        </span>
      ) : isAgent ? (
        <span className="shrink-0 text-meta leading-5 text-muted-foreground">
          bot{(candidate.ownerName ?? "") !== "" ? ` · de ${candidate.ownerName}` : ""}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Barra de escritura estilo Grok: botón + circular separado + pastilla
 * con textarea auto-creciente (1-6 líneas), micrófono y enviar.
 * - Enter envía solo con puntero fino; en táctil Enter salta de línea.
 * - "@" abre un menú flotante (MenuCard) con @Loki + miembros del
 *   espacio; filtra por el texto tras @. Flechas + Enter / click insertan
 *   "@Nombre" (el uid se guarda en mentions[] al enviar). Escape cierra.
 * - La barra se mantiene sobre el teclado con window.visualViewport.
 * - T16: si recibe `edit` precarga el texto y Enter guarda la edición;
 *   si recibe `replyTo` muestra la barra de cita con su X.
 * - Adjuntos: el menú + ofrece foto/video, cámara, archivo y nota de voz.
 *   Cada archivo se comprime (si es imagen), se sube a Storage con progreso
 *   real y cancelación, y viaja en `attachments` al enviar.
 */
export function Composer({
  chatName,
  isLoki,
  sending,
  members,
  onSend,
  wsId = null,
  mediaBucket,
  onValueChange,
  edit = null,
  onSaveEdit,
  onCancelEdit,
  replyTo = null,
  onCancelReply,
  placeholder: placeholderOverride,
  mode = "chat",
  disabled = false,
  onDictate = null,
  dictating = false,
  onCreatePoll = null,
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = React.useState("");
  const [attachOpen, setAttachOpen] = React.useState(false);
  const [mention, setMention] = React.useState<MentionState | null>(null);
  const [pendings, setPendings] = React.useState<PendingAttachment[]>([]);
  const [recording, setRecording] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const reduceMotion = useReducedMotion();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const photoRef = React.useRef<HTMLInputElement>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const controllers = React.useRef(new Map<string, AbortController>());
  const hasText = value.trim() !== "";
  const editingId = edit?.id ?? null;
  const editingText = edit?.text ?? "";
  // T17: en el feed de Publicaciones el composer va arriba, no es una barra
  // pegada abajo, y no lleva menciones (no hay menú @ ni @Loki).
  const isPost = mode === "post";
  const bucket: MediaBucket = mediaBucket ?? (isPost ? "post-media" : "chat-media");

  const placeholder =
    placeholderOverride ??
    (isPost
      ? POSTS_PLACEHOLDER
      : replyTo !== null
        ? `Responder a ${replyTo.authorName}`
        : isLoki
          ? AI_PLACEHOLDER
          : `Mensaje para ${chatName}`);

  // Al entrar en modo edición el input se llena con el texto original.
  React.useEffect(() => {
    if (editingId === null) return;
    setValue(editingText);
    setMention(null);
    onValueChange?.("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [editingId, editingText, onValueChange]);

  // Al desmontar se cancelan las subidas en curso (evita fugas de red).
  React.useEffect(() => {
    const live = controllers.current;
    return () => {
      live.forEach((controller) => controller.abort());
      live.clear();
    };
  }, []);

  const removePending = React.useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setPendings((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl !== null && target?.previewUrl !== undefined) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  /** Comprueba tamaño, comprime (si es imagen) y sube cada archivo. */
  const addFiles = React.useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (wsId === null || wsId.trim() === "") {
        setNotice("Elige un espacio para adjuntar archivos.");
        return;
      }
      const spaceId: string = wsId;
      setNotice(null);
      for (const original of files) {
        const tooBig = validateFileSize(original);
        if (tooBig !== null) {
          setNotice(tooBig);
          continue;
        }
        const id = crypto.randomUUID();
        const controller = new AbortController();
        controllers.current.set(id, controller);
        const kind = kindFromFile(original);
        const previewUrl =
          kind === "image" || kind === "video" ? URL.createObjectURL(original) : null;
        setPendings((prev) => [
          ...prev,
          {
            id,
            name: original.name !== "" ? original.name : "archivo",
            kind,
            previewUrl,
            status: "uploading",
            progress: 0,
            result: null,
            error: null,
          },
        ]);
        void (async () => {
          try {
            const file = kind === "image" ? await compressImage(original) : original;
            if (controller.signal.aborted) return;
            const uploaded = await uploadAttachment(spaceId, file, {
              bucket,
              signal: controller.signal,
              onProgress: (percent) => {
                setPendings((prev) =>
                  prev.map((item) =>
                    item.id === id ? { ...item, progress: percent } : item,
                  ),
                );
              },
            });
            setPendings((prev) =>
              prev.map((item) =>
                item.id === id
                  ? {
                      ...item,
                      name: uploaded.name,
                      kind: uploaded.kind,
                      duration: uploaded.duration,
                      status: "ready",
                      progress: 100,
                      result: uploaded,
                    }
                  : item,
              ),
            );
          } catch (error: unknown) {
            // Cancelar quita la fila en silencio; el error real se muestra.
            if (error instanceof DOMException && error.name === "AbortError") {
              setPendings((prev) => prev.filter((item) => item.id !== id));
            } else {
              setPendings((prev) =>
                prev.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        status: "error",
                        error:
                          error instanceof Error ? error.message : "No se pudo subir.",
                      }
                    : item,
                ),
              );
            }
          } finally {
            controllers.current.delete(id);
          }
        })();
      }
    },
    [wsId, bucket],
  );

  const handleAttachOption = React.useCallback(
    (option: AttachOption) => {
      if (option === "photo") photoRef.current?.click();
      else if (option === "camera") cameraRef.current?.click();
      else if (option === "file") fileRef.current?.click();
      // La encuesta vive en un mensaje del chat: la abre el padre (hoja).
      else if (option === "poll") onCreatePoll?.();
      // En el chat con Loki el micrófono dicta en vez de mandar un adjunto.
      else if (onDictate !== null) onDictate();
      else setRecording(true);
    },
    [onCreatePoll, onDictate],
  );

  const handleVoiceSend = React.useCallback(
    (blob: Blob) => {
      setRecording(false);
      if (blob.size === 0) return;
      const ext = voiceExtension(blob.type);
      const file = new File([blob], `nota-de-voz.${ext}`, {
        type: blob.type !== "" ? blob.type : "audio/webm",
      });
      addFiles([file]);
    },
    [addFiles],
  );

  const allCandidates = React.useMemo<MentionCandidate[]>(
    () => [LOKI_CANDIDATE, ...members],
    [members],
  );

  const filtered = React.useMemo<MentionCandidate[]>(
    () => (mention === null ? [] : filterMentionCandidates(allCandidates, mention.query)),
    [allCandidates, mention],
  );

  // Sin resultados el menú se cierra (no se muestra vacío).
  const open = !isPost && mention !== null && filtered.length > 0;
  const activeIndex =
    mention === null
      ? 0
      : Math.min(mention.active, Math.max(0, filtered.length - 1));

  const readyAttachments = React.useMemo(
    () =>
      pendings.filter(
        (item): item is PendingAttachment & { result: UploadedAttachment } =>
          item.status === "ready" && item.result !== null,
      ),
    [pendings],
  );
  const uploading = pendings.some((item) => item.status === "uploading");
  // Se puede enviar con texto, con adjuntos ya subidos, o con ambos. Mientras
  // algo sube o se graba, el envío espera (evita mandar el texto sin su foto).
  const canSend =
    (hasText || readyAttachments.length > 0) &&
    !sending &&
    !disabled &&
    !uploading &&
    !recording;

  const autoGrow = React.useCallback(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    const lineHeight = 20;
    const maxHeight = lineHeight * 6;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  React.useEffect(() => {
    autoGrow();
  }, [value, autoGrow]);

  // Mantiene la barra visible sobre el teclado móvil.
  React.useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null || viewport === undefined) return;
    const update = (): void => {
      const offset = Math.max(0, window.innerHeight - viewport.height);
      wrapRef.current?.style.setProperty("--kb", `${offset}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  const updateMention = React.useCallback((next: string, caret: number) => {
    if (isPost) {
      setMention(null);
      return;
    }
    const found = getMentionQuery(next, caret);
    if (found === null) {
      setMention(null);
      return;
    }
    setMention((prev) =>
      prev !== null && prev.start === found.start && prev.query === found.query
        ? { ...prev, caret }
        : { start: found.start, caret, query: found.query, active: 0 },
    );
  }, [isPost]);

  const insertMention = React.useCallback(
    (candidate: MentionCandidate) => {
      if (mention === null) return;
      const token = buildMentionToken(candidate);
      const next = `${value.slice(0, mention.start)}${token} ${value.slice(mention.caret)}`;
      const caret = mention.start + token.length + 1;
      setValue(next);
      setMention(null);
      onValueChange?.(next);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el !== null) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
      });
    },
    [mention, value, onValueChange],
  );
  const send = React.useCallback(() => {
    if (disabled || sending) return;
    // Límites estrictos espejo de la Edge (`src/lib/validators.ts`).
    const text = validMessageText(value) ?? (value.trim() === "" ? "" : null);
    const ready = readyAttachments;
    if (text === "" && ready.length === 0) {
      // Solo espacios: se limpia sin enviar.
      setValue("");
      return;
    }
    if (text === null) {
      setNotice("El mensaje no puede superar los 4000 caracteres.");
      return;
    }
    // T17: sin menciones en el feed de posts.
    const mentions = isPost ? [] : resolveMentionIds(value, allCandidates);
    // En modo edición se guarda solo el texto (los adjuntos no se editan y
    // se quedan pendientes para el próximo envío).
    const attachments: MessageAttachment[] | undefined =
      editingId === null && ready.length > 0
        ? ready.map((item) => item.result)
        : undefined;
    // En modo edición el mismo Enter guarda con editMessage (sin adjuntos).
    if (editingId !== null) onSaveEdit?.(text, mentions);
    else onSend(text, mentions, attachments);
    setValue("");
    setMention(null);
    setNotice(null);
    // Los enviados liberan su vista previa; los que fallaron se quedan.
    // En edición no se toca nada (los pendientes siguen suyos).
    if (editingId === null) {
      setPendings((prev) => {
        for (const item of prev) {
          if (item.status === "ready" && item.previewUrl !== null) {
            URL.revokeObjectURL(item.previewUrl);
          }
        }
        return prev.filter((item) => item.status !== "ready");
      });
    }
    onValueChange?.("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [value, sending, editingId, isPost, onSaveEdit, onSend, readyAttachments, allCandidates, onValueChange, disabled]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open && mention !== null) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMention({ ...mention, active: (mention.active + 1) % filtered.length });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMention({
          ...mention,
          active: (mention.active - 1 + filtered.length) % filtered.length,
        });
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const candidate = filtered[activeIndex];
        if (candidate !== undefined) {
          event.preventDefault();
          insertMention(candidate);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    const finePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: fine)").matches;
    if (!finePointer) return;
    event.preventDefault();
    send();
  };

  return (
    <div
      ref={wrapRef}
      className={cn(
        "px-3 pt-2",
        // T17: el feed de posts separa el composer de la lista con un
        // divisor y no deja la barra pegada al borde inferior.
        isPost && "border-b border-divider pb-3",
      )}
      style={
        isPost
          ? undefined
          : { paddingBottom: "calc(12px + env(safe-area-inset-bottom) + var(--kb, 0px))" }
      }
    >
      <div className="mx-auto w-full max-w-[760px]">
        {editingId !== null ? (
          <div
            aria-label="Editando mensaje"
            className="mb-2 flex items-center gap-2 rounded-xl bg-surface-soft px-3 py-2"
          >
            <span className="min-w-0 flex-1 border-l-2 border-accent pl-2">
              <span className="block truncate text-meta font-semibold leading-4 text-accent">
                Editando mensaje
              </span>
              <span className="block truncate text-meta leading-4 text-muted-foreground">
                {quoteLine(editingText)}
              </span>
            </span>
            <button
              type="button"
              onClick={onCancelEdit}
              aria-label="Cancelar edición"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground outline-none interactive active:bg-surface"
            >
              <Icon icon={X} size={20} />
            </button>
          </div>
        ) : replyTo !== null ? (
          <div
            aria-label="Respondiendo a un mensaje"
            className="mb-2 flex items-center gap-2 rounded-xl bg-surface-soft px-3 py-2"
          >
            <span className="min-w-0 flex-1 border-l-2 border-accent pl-2">
              <span className="block truncate text-meta font-semibold leading-4 text-accent">
                {replyTo.authorName}
              </span>
              <span className="block truncate text-meta leading-4 text-muted-foreground">
                {quoteLine(replyTo.text)}
              </span>
            </span>
            <button
              type="button"
              onClick={onCancelReply}
              aria-label="Cancelar respuesta"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground outline-none interactive active:bg-surface"
            >
              <Icon icon={X} size={20} />
            </button>
          </div>
        ) : null}
        {/* Adjuntos en curso + grabadora, sobre la pastilla de texto. */}
        {pendings.length > 0 || recording ? (
          <div className="mb-2 flex flex-col gap-2" aria-label="Adjuntos">
            {pendings.map((item) =>
              item.status === "uploading" ? (
                <UploadProgress
                  key={item.id}
                  fileName={item.name}
                  progress={item.progress}
                  onCancel={() => removePending(item.id)}
                />
              ) : item.status === "error" ? (
                <div
                  key={item.id}
                  role="alert"
                  className="flex items-center gap-2 rounded-2xl border border-danger/40 bg-surface-soft px-3 py-2"
                >
                  <p className="min-w-0 flex-1 truncate text-body-sm text-danger">
                    {item.error ?? "No se pudo subir."}
                  </p>
                  <button
                    type="button"
                    onClick={() => removePending(item.id)}
                    aria-label={`Quitar ${item.name}`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface"
                  >
                    <Icon icon={X} size={20} />
                  </button>
                </div>
              ) : (
                <div
                  key={item.id}
                  className="flex items-center gap-2 rounded-2xl border border-divider bg-surface-soft px-2 py-1.5"
                >
                  {item.previewUrl !== null ? (
                    item.kind === "video" ? (
                      <video
                        src={item.previewUrl}
                        preload="metadata"
                        playsInline
                        className="h-11 w-11 shrink-0 rounded-xl bg-black object-cover"
                      />
                    ) : (
                      <img
                        src={item.previewUrl}
                        alt={item.name}
                        className="h-11 w-11 shrink-0 rounded-xl bg-surface object-cover"
                      />
                    )
                  ) : (
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface text-muted-foreground">
                      <Icon icon={item.kind === "audio" ? FileAudio : FileIcon} size={22} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm font-medium leading-5 text-foreground">
                      {item.name}
                    </span>
                    <span className="block text-meta leading-4 text-accent">
                      {item.duration !== undefined
                        ? `Listo · ${formatDuration(item.duration)}`
                        : "Listo para enviar"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removePending(item.id)}
                    aria-label={`Quitar ${item.name}`}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface"
                  >
                    <Icon icon={X} size={20} />
                  </button>
                </div>
              ),
            )}
            {recording ? (
              <VoiceRecorder
                onCancel={() => setRecording(false)}
                onSend={handleVoiceSend}
              />
            ) : null}
          </div>
        ) : null}
        {notice !== null ? (
          <p role="alert" className="mb-2 text-center text-body-sm text-danger">
            {notice}
          </p>
        ) : null}
        {/* Inputs ocultos: galería, cámara y archivo genérico. */}
        <input
          ref={photoRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <div className="flex items-end gap-2">
          {isPost ? (
            // Publicaciones: el botón de imagen abre la galería (mismo flujo).
            <button
              type="button"
              onClick={() => photoRef.current?.click()}
              title={POSTS_MEDIA_LABEL}
              aria-label={POSTS_MEDIA_LABEL}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground outline-none interactive active:bg-surface-soft"
            >
              <Icon icon={ImageIcon} size={22} />
            </button>
          ) : onDictate !== null ? (
            // Chat con Loki: no hay adjuntos (el dictado es el micrófono de
            // la pastilla), así que el botón + no aparece.
            null
          ) : (
            <div className="relative shrink-0">
              <AnimatePresence>
                {attachOpen ? (
                  <AttachMenu
                    onClose={() => setAttachOpen(false)}
                    onSelect={handleAttachOption}
                    showPoll={onCreatePoll !== null}
                  />
                ) : null}
              </AnimatePresence>
              <IconButton
                variant="floating"
                aria-label={attachOpen ? "Cerrar adjuntos" : "Adjuntar"}
                aria-expanded={attachOpen}
                aria-haspopup="menu"
                onClick={() => setAttachOpen((openAttach) => !openAttach)}
                className="dark:border dark:border-white/10"
              >
                <motion.span
                  animate={{ rotate: attachOpen ? 45 : 0 }}
                  transition={spring}
                  className="flex items-center justify-center"
                >
                  <Icon icon={Plus} size={24} />
                </motion.span>
              </IconButton>
            </div>
          )}

          <div
            className={cn(
              "relative flex min-h-11 min-w-0 flex-1 items-end gap-1 bg-surface-soft py-1",
              // El chat es una pastilla redondeada; el post, un bloque con
              // esquinas suaves (estilo X) para que se lea como composer.
              isPost ? "rounded-2xl pl-3 pr-1.5" : "rounded-full pl-4 pr-1",
            )}
          >
            {open ? (
              <div className="absolute inset-x-0 bottom-full z-20 mb-2">
                <MenuCard
                  id="mention-menu"
                  role="listbox"
                  aria-label="Mencionar"
                  className="max-h-60 overflow-y-auto"
                >
                  {filtered.map((candidate, index) => (
                    <MentionOption
                      key={candidate.id}
                      candidate={candidate}
                      active={index === activeIndex}
                      onSelect={insertMention}
                      onHover={() => {
                        setMention((current) =>
                          current === null ? current : { ...current, active: index },
                        );
                      }}
                    />
                  ))}
                </MenuCard>
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              rows={1}
              value={value}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value;
                setValue(next);
                updateMention(next, event.target.selectionStart ?? next.length);
                onValueChange?.(next);
              }}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              aria-label={placeholder}
              className={cn(
                "min-w-0 flex-1 resize-none bg-transparent py-2 text-body-sm leading-5 text-foreground outline-none",
                "placeholder:text-muted-foreground",
              )}
              style={{ maxHeight: 120 }}
            />
            {!isPost && (onDictate !== null || (!hasText && readyAttachments.length === 0)) ? (
              <button
                type="button"
                onClick={() => {
                  // Loki: dictado a voz (el audio se transcribe y el texto
                  // entra al chat). Chats de espacio: nota de voz de siempre.
                  if (onDictate !== null) onDictate();
                  else setRecording((active) => !active);
                }}
                title={onDictate !== null ? "Dictar a Loki" : "Nota de voz"}
                aria-label={
                  onDictate !== null
                    ? dictating
                      ? "Cerrar dictado a Loki"
                      : "Dictar a Loki"
                    : recording
                      ? "Cerrar grabadora"
                      : "Grabar nota de voz"
                }
                aria-expanded={onDictate !== null ? dictating : recording}
                aria-keyshortcuts={onDictate !== null ? "Control+Shift+D Meta+Shift+D" : undefined}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface"
              >
                <Icon icon={Mic} size={20} />
              </button>
            ) : null}
            {isPost ? (
              // Botón "Publicar": siempre visible, deshabilitado sin texto ni imagen.
              <Button
                type="button"
                size="sm"
                onClick={send}
                disabled={!canSend}
                aria-label={POSTS_PUBLISH_LABEL}
                className="shrink-0"
              >
                {POSTS_PUBLISH_LABEL}
              </Button>
            ) : (
              <AnimatePresence initial={false}>
                {hasText || readyAttachments.length > 0 ? (
                  <motion.button
                    key="send"
                    type="button"
                    onClick={send}
                    disabled={!canSend}
                    aria-label={editingId !== null ? "Guardar cambios" : "Enviar mensaje"}
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                    animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                    transition={spring}
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full outline-none interactive-solid",
                      "bg-foreground text-background dark:bg-white dark:text-black",
                      !canSend && "opacity-40",
                    )}
                  >
                    <Icon icon={ArrowUp} size={20} />
                  </motion.button>
                ) : null}
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
