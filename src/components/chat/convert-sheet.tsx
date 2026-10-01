"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Sparkles } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { TaskSheet } from "@/components/projects/task-sheet";
import { analyzeIntent } from "@/lib/chat/intent";
import { createMessageLink } from "@/lib/data/message-links";
import { suggestConvertTitle } from "@/lib/ai/tools-client";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { MessageDoc } from "@/types/chat";

const EventDialog = dynamic(
  () => import("@/components/calendar/event-dialog").then((mod) => mod.EventDialog),
  { ssr: false },
);

export type ConvertKind = "task" | "event" | "reminder";

export type ConvertMember = { uid: string; name: string };

/** Título con criterio: primera línea útil, recortada a 120. */
function smartTitle(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "") ?? "";
  const clean = line.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}

function parseDate(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Hoja de conversión mensaje -> tarea/evento/recordatorio.
 * Prefill con el analizador determinista (título, fecha, responsable por
 * mención, Bandeja, notas con cita+autor) sobre los formularios existentes.
 * "Mejorar con Loki" propone título/fecha con el modelo barato (opcional).
 *
 * Con `sourceText` (nota de voz) el texto de trabajo es la transcripción y se
 * dice de dónde salió, para que nadie convierta algo sin saber qué se dijo.
 */
export function ConvertSheet({
  message,
  wsId,
  chatId,
  uid,
  authorName,
  kind,
  members,
  onClose,
  sourceText = null,
  sourceLabel = null,
}: {
  message: MessageDoc;
  wsId: string;
  chatId: string;
  uid: string;
  authorName: string;
  kind: ConvertKind;
  members: ConvertMember[];
  onClose: () => void;
  /** Texto a convertir (transcripción de una nota de voz). */
  sourceText?: string | null;
  /** Etiqueta de procedencia, p. ej. "nota de voz". */
  sourceLabel?: string | null;
}): React.JSX.Element {
  const [inboxId, setInboxId] = React.useState<string | null>(null);
  const [announce, setAnnounce] = React.useState(false);
  const [improving, setImproving] = React.useState(false);
  const [improveError, setImproveError] = React.useState<string | null>(null);
  const [suggested, setSuggested] = React.useState<{ title: string; dateISO: string | null } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void getSupabaseClient()
      .rpc("ensure_inbox_project", { p_workspace_id: wsId })
      .then(({ data, error }) => {
        if (!cancelled && error === null && typeof data === "string" && data !== "") {
          setInboxId(data);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  // Nota de voz: el texto de trabajo es la transcripción, no `message.text`.
  const workText = sourceText !== null && sourceText.trim() !== "" ? sourceText : message.text;
  const intent = React.useMemo(() => analyzeIntent(workText), [workText]);
  const baseTitle = smartTitle(workText);
  const title = suggested?.title !== undefined && suggested.title !== ""
    ? suggested.title
    : (intent !== null && intent.title !== "" ? intent.title : baseTitle);
  const dateISO = suggested?.dateISO ?? intent?.dateISO ?? null;
  const date = parseDate(dateISO);
  // Responsable sugerido: el primer mencionado que sea miembro (no yo).
  const suggestedAssignee = React.useMemo(() => {
    const memberIds = new Set(members.map((m) => m.uid));
    const found = (message.mentions ?? []).find((id) => id !== uid && memberIds.has(id));
    return found ?? null;
  }, [message.mentions, members, uid]);
  const notes = `“${baseTitle}” — ${message.authorName}`;

  async function handleImprove(): Promise<void> {
    setImproving(true);
    setImproveError(null);
    try {
      const result = await suggestConvertTitle(workText);
      if (result.title === "" && result.dateISO === null) {
        setImproveError("Loki no encontró nada mejor.");
      } else {
        setSuggested({ title: result.title, dateISO: result.dateISO });
      }
    } catch (error) {
      setImproveError(error instanceof Error ? error.message : "No se pudo mejorar.");
    } finally {
      setImproving(false);
    }
  }

  async function handleLinked(targetKind: "task" | "event", targetId: string): Promise<void> {
    try {
      await createMessageLink({
        workspaceId: wsId,
        messageId: message.id,
        kind: targetKind,
        targetId,
        uid,
      });
    } catch {
      // El vínculo es accesorio: lo creado ya quedó.
    }
    if (announce) {
      const label = targetKind === "task" ? "tarea" : "evento";
      try {
        await getSupabaseClient().from("messages").insert({
          workspace_id: wsId,
          chat_id: chatId,
          author_id: uid,
          author_name: authorName,
          text: `${authorName} convirtió esto en ${label}: ${title.slice(0, 100)}`,
          type: "system",
        });
      } catch {
        // El aviso es accesorio: lo convertido ya quedó.
      }
    }
    onClose();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="mx-auto flex w-full max-w-[760px] flex-wrap items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => void handleImprove()}
          disabled={improving}
          className="flex min-h-11 items-center gap-1.5 rounded-full border border-divider bg-surface-soft px-3.5 text-body-sm font-medium text-foreground outline-none interactive disabled:opacity-60"
        >
          <Icon icon={Sparkles} size={20} />
          {improving ? "Mejorando…" : "Mejorar con Loki"}
        </button>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-body-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={announce}
            onChange={(event) => setAnnounce(event.target.checked)}
            className="h-6 w-6 accent-[var(--accent)]"
          />
          Avisar en el chat
        </label>
        {improveError !== null ? (
          <span role="alert" className="text-body-sm text-danger">
            {improveError}
          </span>
        ) : null}
        {sourceLabel !== null && sourceLabel !== "" ? (
          <span className="text-meta leading-4 text-muted-foreground">
            Convirtiendo la {sourceLabel}
          </span>
        ) : null}
      </div>
      {kind === "event" ? (
        <EventDialog
          open
          event={null}
          presetStart={null}
          preset={{
            title,
            description: notes,
            start: date,
            attendees: suggestedAssignee === null ? [] : [suggestedAssignee],
          }}
          onCreated={(id) => void handleLinked("event", id)}
          onClose={onClose}
        />
      ) : (
        <TaskSheet
          open
          projectId={inboxId ?? ""}
          task={null}
          initial={{
            title,
            notes,
            assigneeIds: suggestedAssignee === null ? [] : [suggestedAssignee],
            ...(kind === "reminder" ? { reminderAt: date } : { dueAt: date }),
          }}
          onCreated={(id) => void handleLinked("task", id)}
          onClose={onClose}
        />
      )}
    </div>
  );
}
