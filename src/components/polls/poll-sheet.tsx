"use client";

import * as React from "react";
import { CalendarClock, Plus, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { useChats } from "@/hooks/use-chat";
import { useCreatePoll } from "@/hooks/use-polls";
import {
  defaultPollSettings,
  defaultOptionEnd,
  POLL_CLOSE_WINDOWS,
  POLL_KINDS,
  POLL_MAX_OPTIONS,
  splitOptionLines,
  validatePollDraft,
  type PollDraft,
} from "@/lib/polls/poll";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import type { NewPollInput, PollKind, PollSettings } from "@/types/organizer";
import { cn } from "@/lib/utils";

/** Fecha en el formato de `<input type="datetime-local">` (hora local). */
function toLocalInput(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): Date | null {
  if (value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Próximo múltiplo de media hora desde ahora (arranque cómodo de franja). */
function defaultStart(): string {
  const base = new Date();
  base.setMinutes(base.getMinutes() > 30 ? 60 : 30, 0, 0);
  return toLocalInput(base);
}

type OptionDraft = { text: string; start: string };

function emptyOption(kind: PollKind, index: number): OptionDraft {
  if (kind !== "date") return { text: "", start: "" };
  const base = new Date();
  base.setDate(base.getDate() + index);
  return { text: "", start: defaultStart() };
}

/**
 * Crear encuesta en un chat: hoja inferior en móvil (el mismo `Dialog`, que
 * ya se ancla abajo en pantallas chicas) y diálogo centrado en escritorio.
 *
 * Móvil: se agregan opciones con el Enter del teclado (en el último input
 * vacío) y el selector de fecha es el nativo del sistema. Escritorio: mismo
 * formulario, con más alto por fila y foco en la pregunta al abrir.
 *
 * Si no se pasa `chatId` (acción rápida) se elige el chat destino: la
 * encuesta es un mensaje del chat, así que necesita uno.
 */
export function PollSheet({
  open,
  wsId,
  chatId = null,
  onClose,
  onCreated,
}: {
  open: boolean;
  wsId: string;
  /** Chat donde se publica; si falta, se elige aquí. */
  chatId?: string | null;
  onClose: () => void;
  onCreated?: (created: { messageId: string; pollId: string; chatId: string }) => void;
}): React.JSX.Element | null {
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const sessionName = useSessionStore((state) => state.user?.displayName ?? "");
  const profileName = useProfileStore((state) => state.profile?.displayName ?? "");
  const authorName =
    profileName.trim() !== "" ? profileName : sessionName.trim() !== "" ? sessionName : "Miembro";
  const chatsQuery = useChats(wsId === "" ? null : wsId);
  const create = useCreatePoll(wsId === "" ? null : wsId);

  const [question, setQuestion] = React.useState("");
  const [kind, setKind] = React.useState<PollKind>("single");
  const [options, setOptions] = React.useState<OptionDraft[]>([
    { text: "", start: defaultStart() },
    { text: "", start: defaultStart() },
  ]);
  const [settings, setSettings] = React.useState<PollSettings>(defaultPollSettings());
  const [closeIn, setCloseIn] = React.useState<number | null>(24);
  const [targetChat, setTargetChat] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const optionRefs = React.useRef<(HTMLInputElement | null)[]>([]);
  const questionRef = React.useRef<HTMLInputElement>(null);

  const needsChatPicker = chatId === null;
  const destination = chatId ?? targetChat;

  React.useEffect(() => {
    if (!open) return;
    setQuestion("");
    setKind("single");
    setOptions([
      { text: "", start: defaultStart() },
      { text: "", start: defaultStart() },
    ]);
    setSettings(defaultPollSettings());
    setCloseIn(24);
    setTargetChat("");
    setError(null);
    requestAnimationFrame(() => {
      questionRef.current?.focus();
    });
  }, [open]);

  // Los chats del espacio (grupales y Publicaciones; un DM también sirve).
  const chats = React.useMemo(
    () => (chatsQuery.data ?? []).filter((chat) => chat.type !== "ai"),
    [chatsQuery.data],
  );

  const setOption = React.useCallback((index: number, patch: Partial<OptionDraft>): void => {
    setOptions((prev) =>
      prev.map((option, i) => (i === index ? { ...option, ...patch } : option)),
    );
  }, []);

  const addOption = React.useCallback(
    (afterIndex?: number): void => {
      setOptions((prev) => {
        if (prev.length >= POLL_MAX_OPTIONS) return prev;
        const at = afterIndex === undefined ? prev.length : afterIndex + 1;
        const next = [...prev];
        next.splice(at, 0, emptyOption(kind, next.length));
        return next;
      });
      const focusAt = afterIndex === undefined ? options.length : afterIndex + 1;
      requestAnimationFrame(() => {
        optionRefs.current[focusAt]?.focus();
      });
    },
    [kind, options.length],
  );

  const removeOption = React.useCallback((index: number): void => {
    setOptions((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== index)));
  }, []);

  /** Enter en la última opción = agregar otra (móvil, sin ratón). */
  const onOptionKeyDown = React.useCallback(
    (index: number): React.KeyboardEventHandler<HTMLInputElement> =>
      (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (index !== options.length - 1) return;
        if ((options[index]?.text ?? "").trim() === "") return;
        addOption(index);
      },
    [addOption, options],
  );

  function patchSetting(patch: Partial<PollSettings>): void {
    setSettings((prev) => ({ ...prev, ...patch }));
  }

  async function handleSubmit(): Promise<void> {
    if (uid === null) {
      setError("Inicia sesión para crear una encuesta.");
      return;
    }
    if (destination === null || destination === "") {
      setError("Elige el chat donde va la encuesta.");
      return;
    }
    const closesAt =
      closeIn === null ? null : new Date(Date.now() + closeIn * 3_600_000);
    const draft: PollDraft = {
      question,
      kind,
      settings,
      closesAt,
      options:
        kind === "yesno"
          ? []
          : options
              .filter((option) => option.text.trim() !== "")
              .map((option) => {
                const start = fromLocalInput(option.start);
                return {
                  text: option.text.trim(),
                  startsAt: start,
                  endsAt: start === null ? null : defaultOptionEnd(start),
                };
              }),
    };
    const validation = validatePollDraft(draft);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setError(null);
    const input: NewPollInput = {
      question: draft.question,
      kind: draft.kind,
      settings: draft.settings,
      closesAt: draft.closesAt,
      options: draft.options,
    };
    try {
      const created = await create.mutateAsync({ input, authorName, chatId: destination });
      onCreated?.({ ...created, chatId: destination });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo crear la encuesta.");
    }
  }

  if (!open) return null;

  const showOptions = kind !== "yesno";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[92dvh] gap-3 overflow-y-auto p-4 sm:p-5">
        <DialogTitle>Nueva encuesta</DialogTitle>
        <DialogDescription>
          Pregunta al grupo y mira las barras en vivo. Nadie ve quién votó si es anónima.
        </DialogDescription>

        <label className="flex flex-col gap-1">
          <span className="text-meta font-medium text-muted-foreground">Pregunta</span>
          <input
            ref={questionRef}
            type="text"
            aria-label="Pregunta de la encuesta"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={200}
            placeholder="¿Pizza o sushi?"
            className="h-11 w-full rounded-sm border-0 bg-surface-soft px-3 text-body-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>

        {/* Tipo: un toque por opción, con su explicación corta. */}
        <div role="radiogroup" aria-label="Tipo de encuesta" className="flex flex-wrap gap-2">
          {POLL_KINDS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              role="radio"
              aria-checked={kind === entry.kind}
              onClick={() => {
                setKind(entry.kind);
                if (entry.kind === "date") {
                  setOptions((prev) =>
                    prev.map((option) =>
                      option.start === "" ? { ...option, start: defaultStart() } : option,
                    ),
                  );
                }
              }}
              className={cn(
                "flex min-h-11 flex-col items-start rounded-full border px-3 text-left outline-none interactive",
                kind === entry.kind
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-divider text-muted-foreground",
              )}
            >
              <span className="text-body-sm font-semibold leading-4">{entry.label}</span>
              <span className="text-meta leading-4">{entry.detail}</span>
            </button>
          ))}
        </div>

        {needsChatPicker ? (
          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-muted-foreground">Chat</span>
            <select
              aria-label="Chat donde va la encuesta"
              value={targetChat}
              onChange={(event) => setTargetChat(event.target.value)}
              className="h-11 w-full rounded-sm border-0 bg-surface-soft px-3 text-body-sm text-foreground outline-none"
            >
              <option value="">Elige un chat…</option>
              {chats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {chat.emoji ?? ""} {chat.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {showOptions ? (
          <div className="flex flex-col gap-2">
            <span className="text-meta font-medium text-muted-foreground">Opciones</span>
            <ul className="flex flex-col gap-2">
              {options.map((option, index) => (
                <li key={index} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <input
                      ref={(el) => {
                        optionRefs.current[index] = el;
                      }}
                      type="text"
                      aria-label={`Opción ${index + 1}`}
                      value={option.text}
                      onChange={(event) => setOption(index, { text: event.target.value })}
                      onKeyDown={onOptionKeyDown(index)}
                      maxLength={200}
                      placeholder={index === 0 ? "Pizza" : "Sushi"}
                      className="h-11 min-w-0 flex-1 rounded-sm border-0 bg-surface-soft px-3 text-body-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    />
                    {options.length > 2 ? (
                      <button
                        type="button"
                        aria-label={`Quitar la opción ${index + 1}`}
                        onClick={() => removeOption(index)}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface"
                      >
                        <Icon icon={Trash2} size={20} />
                      </button>
                    ) : null}
                  </div>
                  {kind === "date" ? (
                    <label className="flex min-h-11 items-center gap-2 rounded-sm bg-surface-soft px-3">
                      <Icon icon={CalendarClock} size={20} className="text-muted-foreground" />
                      <input
                        type="datetime-local"
                        aria-label={`Fecha y hora de la opción ${index + 1}`}
                        value={option.start}
                        onChange={(event) => setOption(index, { start: event.target.value })}
                        className="h-11 min-w-0 flex-1 bg-transparent text-body-sm text-foreground outline-none"
                      />
                    </label>
                  ) : null}
                </li>
              ))}
            </ul>
            {options.length < POLL_MAX_OPTIONS ? (
              <button
                type="button"
                onClick={() => addOption()}
                className="flex min-h-11 items-center gap-1 self-start rounded-full bg-surface-soft px-3 text-body-sm font-medium text-foreground outline-none interactive"
              >
                <Icon icon={Plus} size={20} />
                Agregar opción
              </button>
            ) : null}
            <p className="text-meta leading-4 text-muted-foreground">
              Enter en la última opción agrega otra. Si ya pegaste una lista
              separada por saltos de línea:{" "}
              <button
                type="button"
                onClick={() => {
                  const lines = splitOptionLines(options.map((option) => option.text).join("\n"));
                  if (lines.length <= options.length) return;
                  setOptions(
                    lines.slice(0, POLL_MAX_OPTIONS).map((text, index) => {
                      const existing = options[index];
                      return existing === undefined
                        ? { text, start: kind === "date" ? defaultStart() : "" }
                        : { ...existing, text };
                    }),
                  );
                }}
                className="font-semibold text-accent outline-none interactive"
              >
                tomar las líneas como opciones
              </button>
              .
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 rounded-sm bg-surface-soft p-3">
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">
              Anónima
              <span className="block text-meta leading-4 text-muted-foreground">
                Las barras se ven igual, pero nunca quién votó.
              </span>
            </span>
            <Switch
              checked={settings.anonymous}
              onCheckedChange={(checked) => patchSetting({ anonymous: checked })}
              label="Encuesta anónima"
            />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">
              Que agreguen opciones
              <span className="block text-meta leading-4 text-muted-foreground">
                El grupo puede sumar alternativas mientras esté abierta.
              </span>
            </span>
            <Switch
              checked={settings.allowSuggestions}
              onCheckedChange={(checked) => patchSetting({ allowSuggestions: checked })}
              label="Permitir agregar opciones"
            />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">
              Avisar si faltan votos
              <span className="block text-meta leading-4 text-muted-foreground">
                Un solo aviso a quien no votó antes del cierre.
              </span>
            </span>
            <Switch
              checked={settings.remindMissing}
              onCheckedChange={(checked) => patchSetting({ remindMissing: checked })}
              label="Recordar a quien no votó"
            />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">
              Quién puede cerrarla
            </span>
            <select
              aria-label="Quién puede cerrar la encuesta"
              value={settings.closeBy}
              onChange={(event) =>
                patchSetting({ closeBy: event.target.value === "anyone" ? "anyone" : "creator" })
              }
              className="h-11 shrink-0 rounded-sm bg-background px-2 text-body-sm text-foreground outline-none"
            >
              <option value="creator">Solo quien la creó</option>
              <option value="anyone">Cualquiera del chat</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">Cierra</span>
            <select
              aria-label="Cuándo se cierra la encuesta"
              value={closeIn === null ? "none" : String(closeIn)}
              onChange={(event) => {
                const raw = event.target.value;
                setCloseIn(raw === "none" ? null : Number(raw));
              }}
              className="h-11 shrink-0 rounded-sm bg-background px-2 text-body-sm text-foreground outline-none"
            >
              {POLL_CLOSE_WINDOWS.map((window) => (
                <option key={window.hours} value={window.hours}>
                  {window.label}
                </option>
              ))}
              <option value="none">Cuando cierre a mano</option>
            </select>
          </label>
        </div>

        {error !== null ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={create.isPending}
            className="min-h-11 flex-1 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {create.isPending ? "Publicando…" : "Publicar encuesta"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar sin crear"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground outline-none interactive"
          >
            <Icon icon={X} size={20} />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
