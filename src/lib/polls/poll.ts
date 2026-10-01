/**
 * Encuestas: helpers puros (sin React, sin Supabase, sin IA).
 *
 * Todo lo que se puede decidir con código va aquí: validación del borrador,
 * etiquetas en español, formato de la franja de fecha, el texto del resultado
 * (incluido el empate) y el porcentaje de las barras. La UI solo pinta.
 */

import type { Timestamp } from "@/lib/timestamp";
import type {
  PollDraftOption,
  PollKind,
  PollOptionView,
  PollSettings,
  PollView,
} from "@/types/organizer";

/** Tipos de encuesta con su etiqueta y su explicación corta. */
export const POLL_KINDS: readonly {
  kind: PollKind;
  label: string;
  detail: string;
}[] = [
  { kind: "single", label: "Una opción", detail: "Gana la más votada" },
  { kind: "multiple", label: "Varias", detail: "Puedes elegir más de una" },
  { kind: "yesno", label: "Sí o no", detail: "Para aprobar algo rápido" },
  { kind: "date", label: "Elegir fecha", detail: "Muestra cuánta gente está ocupada" },
];

export const POLL_YES = "Sí";
export const POLL_NO = "No";

/** Máximo de opciones que acepta la base y la UI. */
export const POLL_MAX_OPTIONS = 20;

/** Tope de pregunta (mismo límite que la columna en Postgres). */
export const POLL_MAX_QUESTION = 200;

export function pollKindLabel(kind: PollKind): string {
  return POLL_KINDS.find((entry) => entry.kind === kind)?.label ?? "Una opción";
}

/** Acepta cualquier valor vindo de la base y cae en 'single'. */
export function normalizePollKind(value: unknown): PollKind {
  return value === "multiple" || value === "yesno" || value === "date" ? value : "single";
}

/** Ajustes por defecto: abierta a sugerencias, sin recordatorio, cerrada por el creador. */
export function defaultPollSettings(): PollSettings {
  return {
    anonymous: false,
    allowSuggestions: true,
    remindMissing: false,
    closeBy: "creator",
  };
}

/** ¿Esta opción lleva fecha y hora (kind 'date')? */
export function isDateOption(kind: PollKind): boolean {
  return kind === "date";
}

/** ¿Se puede marcar más de una opción? */
export function isMultiple(kind: PollKind): boolean {
  return kind === "multiple";
}

export type PollDraft = {
  question: string;
  kind: PollKind;
  settings: PollSettings;
  closesAt: Date | null;
  options: PollDraftOption[];
};

export type PollValidation = { ok: true } | { ok: false; message: string };

/**
 * Valida el borrador antes de escribir nada. Devuelve el primer problema en
 * español; el diálogo lo muestra tal cual.
 */
export function validatePollDraft(draft: PollDraft): PollValidation {
  const question = draft.question.trim();
  if (question === "") {
    return { ok: false, message: "Escribe la pregunta de la encuesta." };
  }
  if (question.length > POLL_MAX_QUESTION) {
    return { ok: false, message: `La pregunta no puede superar los ${POLL_MAX_QUESTION} caracteres.` };
  }
  const options = draft.options.filter((option) => option.text.trim() !== "");
  if (draft.kind === "yesno") {
    return { ok: true };
  }
  if (options.length < 2) {
    return { ok: false, message: "Agrega al menos dos opciones." };
  }
  if (options.length > POLL_MAX_OPTIONS) {
    return { ok: false, message: `Máximo ${POLL_MAX_OPTIONS} opciones.` };
  }
  if (isDateOption(draft.kind)) {
    const sinFecha = options.find((option) => option.startsAt === null);
    if (sinFecha !== undefined) {
      return {
        ok: false,
        message: `Ponle fecha y hora a “${sinFecha.text.trim().slice(0, 40)}”.`,
      };
    }
    const sinFin = options.find(
      (option) => option.startsAt !== null && option.endsAt !== null &&
        option.endsAt.getTime() < option.startsAt.getTime(),
    );
    if (sinFin !== undefined) {
      return {
        ok: false,
        message: `En “${sinFin.text.trim().slice(0, 40)}” el fin es antes del inicio.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Parte un bloque de texto en opciones (una por línea). Ignora vacíos y
 * repetidos sin distinguir mayúsculas: la lista de la compra, pero para
 * encuestas.
 */
export function splitOptionLines(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim().slice(0, 200);
    if (text === "") continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= POLL_MAX_OPTIONS) break;
  }
  return out;
}

/** Las dos opciones fijas del sí/no. */
export function yesNoOptions(): PollDraftOption[] {
  return [
    { text: POLL_YES, startsAt: null, endsAt: null },
    { text: POLL_NO, startsAt: null, endsAt: null },
  ];
}

/** Fin por defecto de una franja: dos horas después de empezar. */
export function defaultOptionEnd(start: Date): Date {
  return new Date(start.getTime() + 2 * 3_600_000);
}

/** "vie 13 nov · 21:00" (o "– 01:00" si el fin es otro día). */
export function optionRangeLabel(option: PollOptionView): string {
  if (option.startsAt === null) return "";
  const start = option.startsAt.toDate();
  const day = start.toLocaleDateString("es-CL", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const from = start.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (option.endsAt === null) return `${day} · ${from}`;
  const endDate = option.endsAt.toDate();
  const to = endDate.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = endDate.toDateString() === start.toDateString();
  if (sameDay) return `${day} · ${from}–${to}`;
  const endDay = endDate.toLocaleDateString("es-CL", { weekday: "short", day: "numeric", month: "short" });
  return `${day} · ${from} → ${endDay} ${to}`;
}

/** "2 ocupados" / "1 ocupado" / "Todos libres". */
export function busyLabel(busy: number | null): string {
  if (busy === null) return "";
  if (busy <= 0) return "Todos libres";
  return busy === 1 ? "1 ocupado" : `${busy} ocupados`;
}

/** Porcentaje de la barra, escalado al máximo (no al total): la opción líder llena. */
export function sharePercent(votes: number, maxVotes: number): number {
  if (maxVotes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((votes / maxVotes) * 100)));
}

/**
 * Texto del resultado una vez cerrada. Un empate no se resuelve solo: lo dice
 * y nombra a quien decide (la persona que creó la encuesta).
 */
export function resultLabel(
  poll: PollView,
  nameOf: (uid: string) => string,
): { text: string; tie: boolean } {
  if (poll.isOpen) return { text: "", tie: false };
  if (poll.totalVotes === 0) return { text: "Terminó sin votos", tie: false };
  if (poll.tied) {
    const decider = poll.createdBy === null ? "" : nameOf(poll.createdBy);
    return {
      text:
        decider === ""
          ? "Empate: decide quien la creó"
          : `Empate: decide ${decider}`,
      tie: true,
    };
  }
  const winner = poll.options.find((option) => option.id === poll.winners[0]);
  const votes = winner?.votes ?? 0;
  return {
    text: `Ganó ${winner?.text ?? ""} · ${votes} ${votes === 1 ? "voto" : "votos"}`,
    tie: false,
  };
}

/** "Cierra mañana a las 21:00" / "Cerrada el viernes" / "" si no hay plazo. */
export function closesLabel(closesAt: Timestamp | null, closedAt: Timestamp | null): string {
  if (closedAt !== null) {
    return `Cerrada ${closedAt.toDate().toLocaleDateString("es-CL", {
      day: "numeric",
      month: "short",
    })}`;
  }
  if (closesAt === null) return "";
  const date = closesAt.toDate();
  const day = date.toLocaleDateString("es-CL", { day: "numeric", month: "short" });
  const hour = date.toLocaleTimeString("es-CL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `Cierra el ${day} a las ${hour}`;
}

/** Ventana de cierre que ofrece el diálogo (en horas desde ahora). */
export const POLL_CLOSE_WINDOWS: readonly { hours: number; label: string }[] = [
  { hours: 2, label: "En 2 horas" },
  { hours: 12, label: "Hoy" },
  { hours: 24, label: "Mañana" },
  { hours: 72, label: "En 3 días" },
  { hours: 168, label: "En una semana" },
];
