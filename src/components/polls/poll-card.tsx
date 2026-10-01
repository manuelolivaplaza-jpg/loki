"use client";

import * as React from "react";
import { BarChart3, Check, Plus, Sparkles } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { Avatar } from "@/components/ui/avatar";
import {
  busyLabel,
  closesLabel,
  isMultiple,
  optionRangeLabel,
  pollKindLabel,
  resultLabel,
  sharePercent,
  POLL_MAX_OPTIONS,
} from "@/lib/polls/poll";
import {
  useAddPollOption,
  useCastPollVote,
  useClosePoll,
  usePoll,
} from "@/hooks/use-polls";
import { PollResultActions } from "@/components/polls/poll-result-actions";
import { PollSummary } from "@/components/polls/poll-summary";
import { useMembers } from "@/hooks/use-chat";
import { useSessionStore } from "@/stores/session-store";
import type { PollOptionView, PollView } from "@/types/organizer";
import { cn } from "@/lib/utils";

/** Háptico corto al votar (en web no hay: se ignora en silencio). */
async function tap(): Promise<void> {
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Web sin hápticos.
  }
}

function initial(name: string): string {
  const letter = name.trim().charAt(0).toUpperCase();
  return letter === "" ? "?" : letter;
}

/** Fecha en el formato de `<input type="datetime-local">` (hora local). */
function toLocalInput(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): Date | null {
  if (value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Fila de una opción: barra, votos y avatares. Toda la fila es el botón. */
function OptionRow({
  poll,
  option,
  nameOf,
  disabled,
  onVote,
}: {
  poll: PollView;
  option: PollOptionView;
  nameOf: (uid: string) => string;
  disabled: boolean;
  onVote: (optionId: string) => void;
}): React.JSX.Element {
  const percent = sharePercent(option.votes, poll.maxVotes);
  const range = optionRangeLabel(option);
  const busy = busyLabel(option.busy);
  // En las anónimas ni la RLS ni la RPC dan nombres: solo el número.
  const voterNames = poll.anonymous ? [] : option.voters.map((uid) => nameOf(uid));
  const chosen = option.mine;
  const parts = [
    option.text,
    range === "" ? "" : range,
    busy === "" ? "" : busy,
    `${option.votes} ${option.votes === 1 ? "voto" : "votos"}`,
    voterNames.length > 0 ? `votaron ${voterNames.join(", ")}` : "",
  ].filter((part) => part !== "");
  const ariaLabel = `${parts.join(". ")}. ${chosen ? "Elegida" : "Elegir"}`;

  return (
    <li>
      <button
        type="button"
        data-poll-option
        disabled={disabled}
        aria-pressed={chosen}
        aria-label={ariaLabel}
        onClick={() => {
          if (disabled) return;
          onVote(option.id);
        }}
        className={cn(
          "group relative flex min-h-12 w-full flex-col justify-center overflow-hidden rounded-xs px-3 py-2 text-left outline-none",
          disabled ? "cursor-default" : "interactive",
        )}
      >
        {/* La barra es el ancho de los votos; la elegida se tiñe de accent. */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 rounded-xs transition-[width] duration-300",
            chosen ? "bg-accent/20" : "bg-surface-soft",
          )}
          style={{ width: `${Math.max(percent, option.votes > 0 ? 12 : 0)}%` }}
        />
        <span className="relative flex w-full items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2",
              chosen ? "border-accent bg-accent text-background" : "border-divider",
            )}
          >
            {chosen ? <Icon icon={Check} size={16} /> : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body-sm font-medium leading-5 text-foreground">
              {option.text}
            </span>
            {range !== "" || busy !== "" ? (
              <span className="block truncate text-meta leading-4 text-muted-foreground">
                {range === "" ? busy : `${range} · ${busy}`}
              </span>
            ) : null}
            {/* Escritorio: al pasar el puntero aparecen los nombres. */}
            {voterNames.length > 0 ? (
              <span className="hidden truncate text-meta leading-4 text-muted-foreground transition-opacity md:block md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100">
                {voterNames.join(", ")}
              </span>
            ) : null}
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-body-sm font-semibold tabular-nums leading-5 text-foreground">
              {option.votes}
            </span>
            <span className="block text-meta tabular-nums leading-4 text-muted-foreground">
              {percent}%
            </span>
          </span>
        </span>
      </button>
      {/* Avatares de quién votó (solo si no es anónima). */}
      {!poll.anonymous && voterNames.length > 0 ? (
        <span aria-hidden="true" className="flex -mt-1 flex-wrap items-center gap-1 pl-3 pr-3">
          {option.voters.slice(0, 4).map((uid) => (
            <Avatar key={uid} initial={initial(nameOf(uid))} size={28} />
          ))}
          {option.voters.length > 4 ? (
            <span className="flex h-7 items-center text-meta text-muted-foreground">
              +{option.voters.length - 4}
            </span>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Tarjeta de encuesta en el chat (mensaje 'card' con meta.kind = "poll").
 *
 * Es una foto del estado que devuelve `poll_results`: barras en vivo, quién
 * votó (si no es anónima), quién falta y, al cerrar, el resultado fijo con el
 * empate explícito. Toda la fila es el botón de voto (móvil) y con teclado se
 * navega con las flechas; en escritorio el hover enseña los nombres.
 */
export function PollCard({ pollId }: { pollId: string }): React.JSX.Element {
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const state = usePoll(pollId);
  const membersQuery = useMembers(state.poll?.workspaceId ?? null);
  const vote = useCastPollVote(pollId);
  const close = useClosePoll(pollId);
  const addOption = useAddPollOption(pollId, state.poll?.workspaceId ?? null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const [draft, setDraft] = React.useState("");
  const [draftStart, setDraftStart] = React.useState("");
  const [summaryOpen, setSummaryOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const poll = state.poll;

  const nameOf = React.useCallback(
    (id: string): string => {
      const found = (membersQuery.data ?? []).find((member) => member.uid === id);
      if (found !== undefined) return found.displayName.trim() === "" ? "Alguien" : found.displayName;
      return id === uid ? "ti" : "Alguien";
    },
    [membersQuery.data, uid],
  );

  // Voto: única o múltiple según el tipo. Volver a tocar la elegida la retira.
  const handleVote = React.useCallback(
    (optionId: string) => {
      if (poll === null || !poll.isOpen) return;
      const current = poll.options.filter((option) => option.mine).map((option) => option.id);
      const next = isMultiple(poll.kind)
        ? current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
        : current[0] === optionId
          ? []
          : [optionId];
      setNotice(null);
      void tap();
      vote.mutate(next, {
        onError: (error) => setNotice(error.message),
      });
    },
    [poll, vote],
  );

  /** Flechas (y Home/End) entre opciones: escritorio con teclado. */
  const onListKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLUListElement>) => {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const list = listRef.current;
    if (list === null) return;
    const items = [...list.querySelectorAll<HTMLButtonElement>("button[data-poll-option]")];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }, []);

  const submitOption = React.useCallback(() => {
    const label = draft.trim();
    if (poll === null || label === "") return;
    const start = poll.kind === "date" ? fromLocalInput(draftStart) : null;
    if (poll.kind === "date" && start === null) {
      setNotice("Elige fecha y hora para la opción.");
      return;
    }
    setNotice(null);
    addOption.mutate(
      {
        text: label,
        startsAt: start,
        endsAt: start === null ? null : new Date(start.getTime() + 2 * 3_600_000),
      },
      {
        onSuccess: () => {
          setDraft("");
          setDraftStart("");
        },
        onError: (error) => setNotice(error.message),
      },
    );
  }, [addOption, draft, draftStart, poll]);

  if (state.isPending) {
    return (
      <span
        aria-label="Cargando encuesta"
        className="block h-32 w-[280px] max-w-full animate-pulse rounded-xl bg-surface-soft"
      />
    );
  }
  if (state.error !== null) {
    return (
      <span role="alert" className="text-body-sm text-muted-foreground">
        No se pudo cargar la encuesta.
      </span>
    );
  }
  if (state.isGone || poll === null) {
    return <span className="text-body-sm text-muted-foreground">Esta encuesta ya no está.</span>;
  }

  const result = resultLabel(poll, nameOf);
  const closes = closesLabel(poll.closesAt, poll.closedAt);
  const missingNames = poll.anonymous ? [] : poll.missing.map((id) => nameOf(id));
  const canAdd = poll.isOpen && poll.canSuggest && poll.options.length < POLL_MAX_OPTIONS;

  return (
    <div className="flex w-[280px] max-w-full flex-col gap-2">
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground"
        >
          <Icon icon={BarChart3} size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body-sm font-semibold leading-5 text-foreground">
            {poll.question}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-meta leading-4 text-muted-foreground">
            <span>{pollKindLabel(poll.kind)}</span>
            {poll.anonymous ? <span>· Anónima</span> : null}
            {closes !== "" ? <span>· {closes}</span> : null}
          </span>
        </span>
      </div>

      {result.text !== "" ? (
        <p
          className={cn(
            "rounded-xs px-3 py-2 text-body-sm font-semibold leading-5 text-foreground",
            result.tie ? "bg-warning/20" : "bg-success/15",
          )}
        >
          {result.text}
        </p>
      ) : null}

      <ul
        ref={listRef}
        aria-label="Opciones de la encuesta"
        className="flex flex-col gap-1"
        onKeyDown={onListKeyDown}
      >
        {poll.options.map((option) => (
          <OptionRow
            key={option.id}
            poll={poll}
            option={option}
            nameOf={nameOf}
            disabled={!poll.isOpen}
            onVote={handleVote}
          />
        ))}
      </ul>

      {poll.options.length === 0 ? (
        <p className="text-meta text-muted-foreground">Todavía no hay opciones.</p>
      ) : null}

      {poll.kind === "date" && state.busyError !== null ? (
        <p className="text-meta text-muted-foreground">
          No se pudo cruzar con el calendario.
        </p>
      ) : null}

      {poll.totalVotes > 0 ? (
        <p className="text-meta leading-4 text-muted-foreground">
          {poll.totalVotes} {poll.totalVotes === 1 ? "voto" : "votos"} de {poll.membersCount}
          {poll.missingCount > 0
            ? ` · falta${poll.missingCount === 1 ? "" : "n"} ${poll.missingCount}${
                missingNames.length > 0 ? ` (${missingNames.join(", ")})` : ""
              }`
            : " · todos votes"}
        </p>
      ) : (
        <p className="text-meta leading-4 text-muted-foreground">
          {poll.membersCount <= 1
            ? "Todavía no ha votado nadie"
            : missingNames.length > 0
              ? `Faltan por votar: ${missingNames.join(", ")}`
              : "Todavía no ha votado nadie"}
        </p>
      )}

      {notice !== null ? (
        <p role="alert" className="text-meta leading-4 text-danger">
          {notice}
        </p>
      ) : null}

      {canAdd ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitOption();
          }}
          className="flex flex-col gap-2 rounded-xs bg-surface-soft p-2"
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              aria-label="Agregar opción"
              placeholder="Agregar opción…"
              value={draft}
              maxLength={200}
              onChange={(event) => setDraft(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-xs bg-background px-2 text-body-sm text-foreground outline-none"
            />
            <button
              type="submit"
              aria-label="Agregar opción"
              disabled={draft.trim() === ""}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background outline-none interactive disabled:opacity-40 dark:bg-white dark:text-black"
            >
              <Icon icon={Plus} size={20} />
            </button>
          </div>
          {poll.kind === "date" ? (
            <input
              type="datetime-local"
              aria-label="Fecha y hora de la opción"
              value={draftStart}
              onChange={(event) => setDraftStart(event.target.value)}
              className="h-9 w-full rounded-xs bg-background px-2 text-body-sm text-foreground outline-none"
            />
          ) : null}
        </form>
      ) : null}

      {poll.isOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          {poll.canManage ? (
            <button
              type="button"
              disabled={close.isPending}
              onClick={() => {
                setNotice(null);
                close.mutate(undefined, {
                  onSuccess: () => setNotice("Encuesta cerrada. El resultado queda fijado."),
                  onError: (error) => setNotice(error.message),
                });
              }}
              className="flex min-h-11 items-center gap-1 rounded-full bg-surface-soft px-3 text-body-sm font-medium text-foreground outline-none interactive disabled:opacity-60"
            >
              {close.isPending ? "Cerrando…" : "Cerrar encuesta"}
            </button>
          ) : null}
          {!summaryOpen ? (
            <button
              type="button"
              onClick={() => setSummaryOpen(true)}
              className="flex min-h-11 items-center gap-1 rounded-full px-3 text-body-sm font-medium text-accent outline-none interactive"
            >
              <Icon icon={Sparkles} size={20} />
              Resumir con Loki
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <PollResultActions poll={poll} nameOf={nameOf} />
          {!summaryOpen ? (
            <button
              type="button"
              onClick={() => setSummaryOpen(true)}
              className="flex min-h-11 items-center gap-1 self-start rounded-full px-3 text-body-sm font-medium text-accent outline-none interactive"
            >
              <Icon icon={Sparkles} size={20} />
              Resumir con Loki
            </button>
          ) : null}
        </>
      )}

      {summaryOpen ? (
        <PollSummary pollId={poll.id} onClose={() => setSummaryOpen(false)} />
      ) : null}
    </div>
  );
}
