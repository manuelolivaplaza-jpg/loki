"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { CalendarPlus, ListPlus } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { optionRangeLabel } from "@/lib/polls/poll";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { PollView } from "@/types/organizer";

// Formularios pesados: solo se descargan cuando la encuesta ya cerró y alguien
// pide crear el evento o la tarea (mismo criterio que `convert-sheet`).
const EventDialog = dynamic(
  () => import("@/components/calendar/event-dialog").then((mod) => mod.EventDialog),
  { ssr: false },
);
const TaskSheet = dynamic(
  () => import("@/components/projects/task-sheet").then((mod) => mod.TaskSheet),
  { ssr: false },
);

type EventDraft = {
  title: string;
  start: Date;
  end: Date;
  attendees: string[];
};

type TaskDraft = {
  title: string;
  notes: string;
};

/**
 * Acciones de una encuesta ya cerrada: llevar el resultado a la agenda o a las
 * tareas. Sin votos no se ofrece nada (y con empate se eligen las opciones
 * empatadas; elcreator decide cuál agenda).
 */
export function PollResultActions({
  poll,
  nameOf,
}: {
  poll: PollView;
  nameOf: (uid: string) => string;
}): React.JSX.Element | null {
  const [eventDraft, setEventDraft] = React.useState<EventDraft | null>(null);
  const [taskDraft, setTaskDraft] = React.useState<TaskDraft | null>(null);
  const [inboxId, setInboxId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // La Bandeja del espacio es el destino de la tarea (nunca "me falta el
  // proyecto"): se resuelve una vez, al abrir el formulario.
  React.useEffect(() => {
    if (taskDraft === null || inboxId !== "") return;
    let cancelled = false;
    void getSupabaseClient()
      .rpc("ensure_inbox_project", { p_workspace_id: poll.workspaceId })
      .then(({ data, error: rpcError }) => {
        if (cancelled) return;
        if (rpcError !== null) {
          setError("No se pudo abrir la Bandeja del espacio.");
          return;
        }
        if (typeof data === "string" && data !== "") setInboxId(data);
      });
    return () => {
      cancelled = true;
    };
  }, [taskDraft, inboxId, poll.workspaceId]);

  if (poll.totalVotes === 0) return null;

  // Ganadoras: la única con más votos; con empate, todas las empatadas.
  const winners =
    poll.winners.length > 0
      ? poll.options.filter((option) => poll.winners.includes(option.id))
      : poll.tied
        ? poll.options.filter((option) => option.votes === poll.maxVotes)
        : [];

  // Encuesta de fecha: un botón por opción ganadora, con la franja ya puesta.
  const dateOptions =
    poll.kind === "date" ? winners.filter((option) => option.startsAt !== null) : [];

  // Aprobación sí/no: la tarea sale hecha si ganó el "Sí".
  const yesVotes = poll.options.find(
    (option) => option.text.trim().toLowerCase() === "sí",
  )?.votes;
  const noVotes = poll.options.find(
    (option) => option.text.trim().toLowerCase() === "no",
  )?.votes;
  const approved =
    poll.kind === "yesno" && (yesVotes ?? 0) > (noVotes ?? 0) && (yesVotes ?? 0) > 0;

  function openEvent(optionId: string): void {
    const option = poll.options.find((entry) => entry.id === optionId);
    if (option === undefined || option.startsAt === null) return;
    setError(null);
    setEventDraft({
      title: `${poll.question} · ${option.text}`.slice(0, 120),
      start: option.startsAt.toDate(),
      end:
        option.endsAt === null
          ? new Date(option.startsAt.toDate().getTime() + 2 * 3_600_000)
          : option.endsAt.toDate(),
      // En las anónimas no sabemos quiénes votaron: el evento se crea sin
      // invitados y quien lo quiera los agrega.
      attendees: poll.anonymous ? [] : [...option.voters],
    });
  }

  function openTask(): void {
    const winner = winners[0];
    if (winner === undefined) return;
    const label = poll.tied
      ? `Empate (${winners.map((option) => option.text).join(" / ")})`
      : `Ganó ${winner.text} con ${winner.votes} votos`;
    setError(null);
    setInboxId("");
    setTaskDraft({
      title: poll.question.slice(0, 200),
      notes: `${label}. ${poll.totalVotes} votos en total.`,
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {poll.tied ? (
        <p className="text-meta leading-4 text-muted-foreground">
          Empate: decide {poll.createdBy === null ? "quien la creó" : nameOf(poll.createdBy)}.
        </p>
      ) : null}

      {dateOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => openEvent(option.id)}
          className="flex min-h-11 items-center gap-1 self-start rounded-full bg-surface-soft px-3 text-body-sm font-medium text-foreground outline-none interactive"
        >
          <Icon icon={CalendarPlus} size={20} />
          Crear evento · {optionRangeLabel(option)}
        </button>
      ))}

      {poll.kind === "yesno" && winners.length > 0 ? (
        <button
          type="button"
          onClick={() => openTask()}
          className="flex min-h-11 items-center gap-1 self-start rounded-full bg-surface-soft px-3 text-body-sm font-medium text-foreground outline-none interactive"
        >
          <Icon icon={ListPlus} size={20} />
          Crear tarea con el resultado
        </button>
      ) : null}

      {taskDraft !== null && inboxId === "" && error === null ? (
        <p className="text-meta text-muted-foreground">Preparando la Bandeja…</p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      ) : null}

      {eventDraft !== null ? (
        <EventDialog
          open
          event={null}
          presetStart={null}
          preset={{
            title: eventDraft.title,
            description: `Ganó en la encuesta “${poll.question}”.`,
            start: eventDraft.start,
            attendees: eventDraft.attendees,
          }}
          onClose={() => setEventDraft(null)}
        />
      ) : null}

      {taskDraft !== null && inboxId !== "" ? (
        <TaskSheet
          open
          projectId={inboxId}
          task={null}
          initial={{
            title: taskDraft.title,
            notes: taskDraft.notes,
            ...(approved ? {} : {}),
          }}
          onClose={() => {
            setTaskDraft(null);
            setError(null);
          }}
        />
      ) : null}
    </div>
  );
}
