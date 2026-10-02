"use client";

import * as React from "react";
import { Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { useUpdatePoll } from "@/hooks/use-polls";
import type { PollSettings, PollView } from "@/types/organizer";
import { POLL_MAX_QUESTION } from "@/lib/polls/poll";

function toLocalInput(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): Date | null {
  if (value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Ajustes de una encuesta viva: pregunta, fecha de cierre y los tres
 * interruptores (anónima, sugerencias y recordatorio) más quién puede
 * cerrarla. Solo quien puede administrar la encuesta (creador, admin o
 * `closeBy = anyone`) lo ve; la RLS lo hace la puerta de verdad.
 *
 * El tipo y las opciones NO se editan: la encuesta es una foto de lo que se
 * votó (cambiaría el resultado). Para cambiar el tipo se crea otra.
 */
export function PollSettingsDialog({
  open,
  poll,
  onClose,
}: {
  open: boolean;
  poll: PollView;
  onClose: () => void;
}): React.JSX.Element | null {
  const update = useUpdatePoll(poll.id);
  const [question, setQuestion] = React.useState(poll.question);
  const [settings, setSettings] = React.useState<PollSettings>(poll.settings);
  const [closes, setCloses] = React.useState(
    poll.closesAt === null ? "" : toLocalInput(poll.closesAt.toDate()),
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setQuestion(poll.question);
    setSettings(poll.settings);
    setCloses(poll.closesAt === null ? "" : toLocalInput(poll.closesAt.toDate()));
    setError(null);
  }, [open, poll]);

  if (!open) return null;

  function patch(next: Partial<PollSettings>): void {
    setSettings((prev) => ({ ...prev, ...next }));
  }

  async function handleSave(): Promise<void> {
    const clean = question.trim();
    if (clean === "") {
      setError("La pregunta no puede quedar vacía.");
      return;
    }
    if (clean.length > POLL_MAX_QUESTION) {
      setError(`La pregunta no puede superar los ${POLL_MAX_QUESTION} caracteres.`);
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({
        question: clean,
        settings,
        closesAt: fromLocalInput(closes),
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[92dvh] gap-3 overflow-y-auto p-4 sm:p-5">
        <DialogTitle>Ajustes de la encuesta</DialogTitle>
        <DialogDescription>
          El tipo y las opciones no se cambian: el resultado ya está fijándose.
        </DialogDescription>

        <label className="flex flex-col gap-1">
          <span className="text-meta font-medium text-muted-foreground">Pregunta</span>
          <input
            type="text"
            aria-label="Pregunta de la encuesta"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={POLL_MAX_QUESTION}
            className="h-11 w-full rounded-sm border-0 bg-surface-soft px-3 text-body-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-meta font-medium text-muted-foreground">Cierra</span>
          <input
            type="datetime-local"
            aria-label="Fecha de cierre"
            value={closes}
            onChange={(event) => setCloses(event.target.value)}
            className="h-11 w-full rounded-sm border-0 bg-surface-soft px-3 text-body-sm text-foreground outline-none"
          />
        </label>

        <div className="flex flex-col gap-2 rounded-sm bg-surface-soft p-3">
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">Anónima</span>
            <Switch
              checked={settings.anonymous}
              onCheckedChange={(checked) => patch({ anonymous: checked })}
              label="Encuesta anónima"
            />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">Que agreguen opciones</span>
            <Switch
              checked={settings.allowSuggestions}
              onCheckedChange={(checked) => patch({ allowSuggestions: checked })}
              label="Permitir agregar opciones"
            />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">Avisar si faltan votos</span>
            <Switch
              checked={settings.remindMissing}
              onCheckedChange={(checked) => patch({ remindMissing: checked })}
              label="Recordar a quien no votó"
            />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">Quién puede cerrarla</span>
            <select
              aria-label="Quién puede cerrar la encuesta"
              value={settings.closeBy}
              onChange={(event) =>
                patch({ closeBy: event.target.value === "anyone" ? "anyone" : "creator" })
              }
              className="h-11 shrink-0 rounded-sm bg-background px-2 text-body-sm text-foreground outline-none"
            >
              <option value="creator">Solo quien la creó</option>
              <option value="anyone">Cualquiera del chat</option>
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
            onClick={() => void handleSave()}
            disabled={update.isPending}
            className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
          >
            <Icon icon={Pencil} size={20} />
            {update.isPending ? "Guardando…" : "Guardar"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 flex-1 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive"
          >
            Cancelar
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
