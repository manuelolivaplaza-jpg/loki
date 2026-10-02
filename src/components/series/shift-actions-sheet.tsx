"use client";

/**
 * Acciones de un turno concreto: pedir el cambio ("¿me cambias el turno?"),
 * pasarlo a otra persona (vacaciones o una sola vez) y editar la serie.
 *
 * Todo pasa por las RPC de la base (`request_shift_swap`, `skip_shift`), que
 * vuelven a comprobar quién puede: el intercambio solo lo resuelven los dos
 * involucrados.
 */

import * as React from "react";
import Link from "next/link";
import { CalendarSync, ExternalLink, Repeat, UserRoundPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Avatar } from "@/components/ui/avatar";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { useAuthorAvatarColor } from "@/hooks/use-avatar-color";
import { useMembers } from "@/hooks/use-chat";
import { useRequestSwap, useSkipShift } from "@/hooks/use-series";
import { describeRule, toDateKey } from "@/lib/recurring/recurrence";
import type { SeriesItem } from "@/types/recurring";
import { cn } from "@/lib/utils";

type Mode = "swap" | "skip";

export function ShiftActionsSheet({
  open,
  wsId,
  uid,
  series,
  /** Tarea de la ocurrencia (null = solo vista previa). */
  taskId,
  dateKey,
  assigneeId,
  onClose,
  onEditSeries,
}: {
  open: boolean;
  wsId: string;
  uid: string;
  series: SeriesItem | null;
  taskId: string | null;
  /** Fecha de la ocurrencia ("YYYY-MM-DD"). */
  dateKey: string;
  /** Quién lo tiene ahora. */
  assigneeId: string;
  onClose: () => void;
  onEditSeries: (series: SeriesItem) => void;
}): React.JSX.Element | null {
  const membersQuery = useMembers(wsId);
  const requestSwap = useRequestSwap();
  const skipShift = useSkipShift();
  const [mode, setMode] = React.useState<Mode>("swap");
  const [target, setTarget] = React.useState("");
  const [note, setNote] = React.useState("");
  const [from, setFrom] = React.useState(dateKey);
  const [to, setTo] = React.useState(dateKey);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setMode("swap");
    setTarget("");
    setNote("");
    setFrom(dateKey);
    setTo(dateKey);
    setError(null);
    setDone(null);
  }, [open, dateKey]);

  const members = membersQuery.data ?? [];
  const candidates = members.filter(
    (member) =>
      series !== null &&
      series.rotation.includes(member.uid) &&
      member.uid !== assigneeId &&
      member.uid !== uid,
  );

  if (!open) return null;

  async function submit(): Promise<void> {
    if (series === null) return;
    if (target === "") {
      setError("Elige con quién.");
      return;
    }
    setError(null);
    try {
      if (mode === "swap") {
        if (taskId === null) {
          setError("Ese turno todavía no tiene tarea: vuelve a preguntarlo cuando exista.");
          return;
        }
        await requestSwap.mutateAsync({ taskId, toUserId: target, note });
        setDone("Listo: le preguntaste. Te avisa cuando responda.");
      } else {
        const moved = await skipShift.mutateAsync({
          seriesId: series.id,
          userId: target,
          from,
          to: to === "" ? from : to,
          reason: note,
        });
        setDone(
          moved === 0
            ? "Listo: esa persona no tiene turnos abiertos en esas fechas."
            : `Listo: ${moved === 1 ? "pasamos 1 turno" : `pasamos ${moved} turnos`} a quien toque.`,
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo hacer el cambio.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label="Turno">
        <DialogTitle>Turno</DialogTitle>
        <DialogDescription>
          {series === null
            ? "Esta serie ya no está en la rotación."
            : `${series.title} · ${describeRule(series.rule)}`}
        </DialogDescription>
        <div className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
          {done !== null ? (
            <p role="status" className="text-body-sm text-success">
              {done}
            </p>
          ) : (
            <>
              <div role="radiogroup" aria-label="Qué hacer con el turno" className="flex rounded-full bg-surface-soft p-1">
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "swap"}
                  onClick={() => setMode("swap")}
                  className={cn(
                    "h-10 flex-1 rounded-full text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                    mode === "swap"
                      ? "bg-background text-foreground shadow-float dark:bg-divider dark:text-white"
                      : "text-muted-foreground",
                  )}
                >
                  Me lo cambias
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "skip"}
                  onClick={() => setMode("skip")}
                  className={cn(
                    "h-10 flex-1 rounded-full text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                    mode === "skip"
                      ? "bg-background text-foreground shadow-float dark:bg-divider dark:text-white"
                      : "text-muted-foreground",
                  )}
                >
                  Falta / vacaciones
                </button>
              </div>

              <p className="text-body-sm text-muted-foreground">
                {mode === "swap"
                  ? "Si acepta, este turno pasa a esa persona y la rotación avanza un puesto."
                  : "Esa persona queda fuera de la rotación en esas fechas y sus turnos abiertos pasan al siguiente."}
              </p>

              <div>
                <span className={labelClassName}>Con quién</span>
                <div role="group" aria-label="Personas de la rotación" className="mt-1 flex flex-col">
                  {candidates.length === 0 ? (
                    <p className="text-body-sm text-muted-foreground">
                      No hay nadie más en la rotación de esta serie.
                    </p>
                  ) : (
                    candidates.map((member) => (
                      <button
                        key={member.uid}
                        type="button"
                        onClick={() => setTarget(member.uid)}
                        aria-pressed={target === member.uid}
                        className={cn(
                          "flex min-h-11 items-center gap-3 rounded-sm px-2 text-left outline-none interactive",
                          target === member.uid ? "bg-surface-soft" : "",
                        )}
                      >
                        <MemberAvatar uid={member.uid} name={member.displayName} />
                        <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
                          {member.displayName}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>

              {mode === "skip" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="shift-skip-from" className={labelClassName}>
                      Desde
                    </label>
                    <input
                      id="shift-skip-from"
                      type="date"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                      className={inputClassName}
                    />
                  </div>
                  <div>
                    <label htmlFor="shift-skip-to" className={labelClassName}>
                      Hasta
                    </label>
                    <input
                      id="shift-skip-to"
                      type="date"
                      value={to}
                      min={from}
                      onChange={(event) => setTo(event.target.value)}
                      className={inputClassName}
                    />
                  </div>
                </div>
              ) : null}

              <div>
                <label htmlFor="shift-note" className={labelClassName}>
                  Mensaje (opcional)
                </label>
                <input
                  id="shift-note"
                  type="text"
                  maxLength={200}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={mode === "swap" ? "¿Me lo cambias?" : "Vacaciones"}
                  className={inputClassName}
                />
              </div>

              {error !== null ? (
                <p role="alert" className="text-meta text-danger">
                  {error}
                </p>
              ) : null}

              <button
                type="button"
                disabled={requestSwap.isPending || skipShift.isPending}
                onClick={() => void submit()}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
              >
                <Icon icon={mode === "swap" ? CalendarSync : UserRoundPlus} size={20} />
                {mode === "swap" ? "Preguntar" : "Pasar el turno"}
              </button>
            </>
          )}

          <div className="flex flex-col gap-1">
            {taskId !== null && series !== null ? (
              <Link
                href={`/proyectos?project=${encodeURIComponent(series.projectId)}&task=${encodeURIComponent(taskId)}`}
                className="flex min-h-11 items-center gap-2 rounded-sm px-2 text-body-sm font-medium text-mention outline-none interactive"
                onClick={onClose}
              >
                <Icon icon={ExternalLink} size={20} />
                Abrir la tarea
              </Link>
            ) : null}
            {series !== null ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onEditSeries(series);
                }}
                className="flex min-h-11 items-center gap-2 rounded-sm px-2 text-left text-body-sm font-medium text-foreground outline-none interactive"
              >
                <Icon icon={Repeat} size={20} />
                Editar la repetición
              </button>
            ) : null}
          </div>
          <p className="text-meta text-muted-foreground">
            Turno del {dateKey || toDateKey(new Date())}: si el turno ya tiene tarea,
            tocarla abre esa tarea.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MemberAvatar({ uid, name }: { uid: string; name: string }): React.JSX.Element {
  const color = useAuthorAvatarColor(uid);
  return (
    <Avatar
      size={32}
      color={color}
      initial={(name.trim().charAt(0) || "?").toUpperCase()}
    />
  );
}