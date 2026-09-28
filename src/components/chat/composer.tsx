"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUp, Mic, Plus, Sparkles, X } from "lucide-react";
import { AttachMenu } from "@/components/chat/attach-menu";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { MenuCard } from "@/components/ui/menu-card";
import {
  LOKI_CANDIDATE,
  buildMentionToken,
  filterMentionCandidates,
  getMentionQuery,
  resolveMentionIds,
  type MentionCandidate,
} from "@/lib/chat/mentions";
import { useAuthorAvatarColor } from "@/hooks/use-avatar-color";
import { spring } from "@/lib/motion";
import type { MessageReplyRef } from "@/types/chat";
import { cn } from "@/lib/utils";

type ComposerProps = {
  chatName: string;
  isLoki: boolean;
  sending: boolean;
  /** Miembros del espacio como candidatos (la entrada fija @Loki se agrega aquí). */
  members: MentionCandidate[];
  /** Texto + uids mencionados (tokens "@Nombre" que siguen visibles). */
  onSend: (text: string, mentions: string[]) => void;
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
};

type MentionState = {
  /** Índice del "@" que abrió el menú. */
  start: number;
  /** Caret al detectar el query (fin del reemplazo al insertar). */
  caret: number;
  query: string;
  active: number;
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
  const isLoki = candidate.id === LOKI_CANDIDATE.id;
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
 */
export function Composer({
  chatName,
  isLoki,
  sending,
  members,
  onSend,
  onValueChange,
  edit = null,
  onSaveEdit,
  onCancelEdit,
  replyTo = null,
  onCancelReply,
  placeholder: placeholderOverride,
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = React.useState("");
  const [attachOpen, setAttachOpen] = React.useState(false);
  const [mention, setMention] = React.useState<MentionState | null>(null);
  const reduceMotion = useReducedMotion();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const hasText = value.trim() !== "";
  const editingId = edit?.id ?? null;
  const editingText = edit?.text ?? "";

  const placeholder =
    placeholderOverride ??
    (replyTo !== null
      ? `Responder a ${replyTo.authorName}`
      : isLoki
        ? "Pregunta a Loki"
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

  const allCandidates = React.useMemo<MentionCandidate[]>(
    () => [LOKI_CANDIDATE, ...members],
    [members],
  );

  const filtered = React.useMemo<MentionCandidate[]>(
    () => (mention === null ? [] : filterMentionCandidates(allCandidates, mention.query)),
    [allCandidates, mention],
  );

  // Sin resultados el menú se cierra (no se muestra vacío).
  const open = mention !== null && filtered.length > 0;
  const activeIndex =
    mention === null
      ? 0
      : Math.min(mention.active, Math.max(0, filtered.length - 1));

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
  }, []);

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
    const text = value.trim();
    if (text === "" || sending) return;
    const mentions = resolveMentionIds(value, allCandidates);
    // En modo edición el mismo Enter guarda con editMessage.
    if (editingId !== null) onSaveEdit?.(text, mentions);
    else onSend(text, mentions);
    setValue("");
    setMention(null);
    onValueChange?.("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [value, sending, editingId, onSaveEdit, onSend, allCandidates, onValueChange]);

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
      className="px-3 pt-2"
      style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom) + var(--kb, 0px))" }}
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
        <div className="flex items-end gap-2">
          <div className="relative shrink-0">
            <AnimatePresence>
              {attachOpen ? <AttachMenu onClose={() => setAttachOpen(false)} /> : null}
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

          <div className="relative flex min-h-11 min-w-0 flex-1 items-end gap-1 rounded-full bg-surface-soft py-1 pl-4 pr-1">
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
            {!hasText ? (
              <button
                type="button"
                disabled
                title="Próximamente"
                aria-label="Dictar por voz"
                className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-muted-foreground outline-none"
              >
                <Icon icon={Mic} size={20} />
              </button>
            ) : null}
            <AnimatePresence initial={false}>
              {hasText ? (
                <motion.button
                  key="send"
                  type="button"
                  onClick={send}
                  disabled={sending}
                  aria-label={editingId !== null ? "Guardar cambios" : "Enviar mensaje"}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                  transition={spring}
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full outline-none interactive-solid",
                    "bg-foreground text-background dark:bg-white dark:text-black",
                  )}
                >
                  <Icon icon={ArrowUp} size={20} />
                </motion.button>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
