"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUp, Mic, Plus } from "lucide-react";
import { AttachMenu } from "@/components/chat/attach-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

type ComposerProps = {
  chatName: string;
  isLoki: boolean;
  sending: boolean;
  onSend: (text: string) => void;
};

/**
 * Barra de escritura estilo Grok: botón + circular separado + pastilla
 * con textarea auto-creciente (1-6 líneas), micrófono y enviar.
 * - Enter envía solo con puntero fino; en táctil Enter salta de línea.
 * - La barra se mantiene sobre el teclado con window.visualViewport.
 */
export function Composer({ chatName, isLoki, sending, onSend }: ComposerProps): React.JSX.Element {
  const [value, setValue] = React.useState("");
  const [attachOpen, setAttachOpen] = React.useState(false);
  const reduceMotion = useReducedMotion();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const hasText = value.trim() !== "";

  const placeholder = isLoki ? "Pregunta a Loki" : `Mensaje para ${chatName}`;

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

  const send = React.useCallback(() => {
    const text = value.trim();
    if (text === "" || sending) return;
    onSend(text);
    setValue("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [value, sending, onSend]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
      <div className="mx-auto flex w-full max-w-[760px] items-end gap-2">
        <div className="relative shrink-0">
          <AnimatePresence>
            {attachOpen ? <AttachMenu onClose={() => setAttachOpen(false)} /> : null}
          </AnimatePresence>
          <IconButton
            variant="floating"
            aria-label={attachOpen ? "Cerrar adjuntos" : "Adjuntar"}
            aria-expanded={attachOpen}
            aria-haspopup="menu"
            onClick={() => setAttachOpen((open) => !open)}
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

        <div className="flex min-h-11 min-w-0 flex-1 items-end gap-1 rounded-full bg-surface-soft py-1 pl-4 pr-1">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
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
                aria-label="Enviar mensaje"
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
  );
}
