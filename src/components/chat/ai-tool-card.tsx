"use client";

import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  BellRing,
  Brain,
  CalendarPlus,
  CheckCircle2,
  ListPlus,
  Megaphone,
  Pencil,
  Repeat,
  Undo2,
} from "lucide-react";
import type {
  AiPendingAction,
  AiPendingItem,
  LokiConfirmItem,
  UndoItem,
} from "@/lib/ai/tools-client";
import { WEEKDAY_CHIPS } from "@/types/recurring";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/** Chips L M M J V S D (los mismos que en la hoja de repetición). */
const SERIES_WEEKDAY_CHIPS: readonly { value: number; label: string; short: string }[] =
  WEEKDAY_CHIPS.map((chip) => ({
    value: chip.value,
    label:
      chip.value === 0
        ? "domingo"
        : ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][chip.value] ?? "día",
    short: chip.label,
  }));
import {
  deviceCatalogEntry,
  deviceRiskOf,
  deviceSummary,
} from "@/lib/devices/catalog";

export type CardMember = { uid: string; name: string };
export type CardProject = { id: string; name: string; isSystem: boolean };
export type CardWorkspace = { id: string; name: string };

export type CardConfirmPayload = {
  actions?: LokiConfirmItem[];
  params: Record<string, unknown>;
  workspaceId?: string;
};

/** Icono por acción de escritura (solo decorativo). */
function ActionIcon({ action }: { action: string }): React.JSX.Element {
  const className = "h-5 w-5 shrink-0 text-primary";
  if (action === "create_event" || action === "update_event") {
    return <CalendarPlus className={className} aria-hidden="true" />;
  }
  if (action === "create_series") {
    return <Repeat className={className} aria-hidden="true" />;
  }
  if (action === "create_task" || action === "update_task") {
    return <ListPlus className={className} aria-hidden="true" />;
  }
  if (action === "complete_task") return <CheckCircle2 className={className} aria-hidden="true" />;
  if (action === "create_post") return <Megaphone className={className} aria-hidden="true" />;
  if (action === "create_list_item" || action === "add_list_items") {
    return <ListPlus className={className} aria-hidden="true" />;
  }
  if (action === "check_list_item") return <CheckCircle2 className={className} aria-hidden="true" />;
  if (action === "remove_list_item") return <Undo2 className={className} aria-hidden="true" />;
  if (action === "read_list") return <ListPlus className={className} aria-hidden="true" />;
  if (action === "create_poll") return <BarChart3 className={className} aria-hidden="true" />;
  if (action === "remember") return <Brain className={className} aria-hidden="true" />;
  return <BellRing className={className} aria-hidden="true" />;
}

const DATE_KEYS = ["startsAt", "starts_at", "endsAt", "ends_at", "remindAt", "remind_at", "dueAt", "due_at"];

function splitDateTime(iso: string): { date: string; time: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  if (match === null) return null;
  return { date: match[1] ?? "", time: match[2] ?? "" };
}

function joinDateTime(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const hhmm = /^\d{2}:\d{2}$/.test(time) ? time : "09:00";
  const local = new Date(`${date}T${hhmm}:00`);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

type ItemDraft = {
  include: boolean;
  title: string;
  date: string;
  time: string;
  /** "" = sin tocar; "none" = solo yo/quitar; uid = responsable. */
  assignee: string;
  projectId: string;
  /** Solo acciones de lista: nombre + ítems (uno por línea). */
  listName: string;
  listItems: string;
  /** Solo check_list_item. */
  checked: boolean;
  /** Solo create_poll: tipo de encuesta (single/multiple/yesno/date). */
  pollKind: string;
  /** Solo create_poll: fecha y hora de cada opción (kind 'date'). */
  pollDates: string[];
  /** Solo create_poll: encuesta anónima. */
  anonymous: boolean;
  /** Solo remember: categoría del recuerdo. */
  memoryCategory: string;
  /** Solo remember: clave o dato de salud (oculto, sin push). */
  memorySensitive: boolean;
  /** Solo remember: día de caducidad ("" = nunca). */
  memoryExpires: string;
  /** Solo create_series: regla de repetición. */
  seriesKind: string;
  seriesInterval: number;
  seriesUnit: string;
  seriesWeekdays: number[];
  seriesMonthDay: string;
  seriesMonthWeek: string;
  seriesMonthWeekday: string;
  /** Solo create_series: uids de la rotación, en orden. */
  seriesRotation: string[];
  /** Solo create_series: hora del aviso. */
  seriesRemindTime: string;
};

const SERIES_KIND_LABELS: readonly { value: string; label: string }[] = [
  { value: "daily", label: "Todos los días" },
  { value: "weekly", label: "Cada semana" },
  { value: "monthly", label: "Cada mes" },
  { value: "interval", label: "Cada N" },
];

const MEMORY_CATEGORY_LABELS: readonly { value: string; label: string }[] = [
  { value: "salud", label: "Salud" },
  { value: "casa", label: "Casa" },
  { value: "contactos", label: "Contactos" },
  { value: "trabajo", label: "Trabajo" },
  { value: "otros", label: "Otros" },
];

const POLL_KIND_LABELS: readonly { value: string; label: string }[] = [
  { value: "single", label: "Una opción" },
  { value: "multiple", label: "Varias" },
  { value: "yesno", label: "Sí o no" },
  { value: "date", label: "Elegir fecha" },
];

/** Fecha en el formato de `<input type="datetime-local">` (hora local). */
function toLocalInput(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Opciones de la encuesta que propone Loki: texto + franja (kind 'date'). */
function draftPollOptions(params: Record<string, unknown>): {
  items: string;
  dates: string[];
  anonymous: boolean;
  kind: string;
} {
  const raw = params["options"];
  const items: string[] = [];
  const dates: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw.slice(0, 20)) {
      if (typeof entry === "string") {
        items.push(entry.slice(0, 200));
        dates.push("");
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const text = typeof rec["text"] === "string" ? rec["text"].slice(0, 200) : "";
      if (text === "") continue;
      items.push(text);
      const startsAt = typeof rec["startsAt"] === "string" ? rec["startsAt"] : "";
      const parsed = startsAt === "" ? null : new Date(startsAt);
      dates.push(parsed === null || Number.isNaN(parsed.getTime()) ? "" : toLocalInput(parsed));
    }
  }
  const kind = typeof params["kind"] === "string" ? params["kind"] : "single";
  return {
    items: items.join("\n"),
    dates,
    anonymous: params["anonymous"] === true,
    kind,
  };
}

/** Rearma `options` desde el borrador (texto + día y hora si es 'date'). */
function buildPollOptions(draft: ItemDraft): { text: string; startsAt?: string; endsAt?: string }[] {
  const lines = draft.listItems
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 20);
  if (draft.pollKind !== "date") {
    return lines.map((text) => ({ text }));
  }
  return lines.map((text, index) => {
    const raw = draft.pollDates[index] ?? "";
    const iso = fromLocalInput(raw);
    // Sin día puesto se propone mañana a la misma hora que la primera opción
    // (o 19:00): la tarjeta muestra la fecha exacta y se puede corregir.
    let startsAt = iso;
    if (startsAt === null) {
      const base = new Date();
      base.setDate(base.getDate() + index + 1);
      base.setHours(19, 0, 0, 0);
      startsAt = base.toISOString();
    }
    return {
      text,
      startsAt,
      endsAt: new Date(new Date(startsAt).getTime() + 2 * 3_600_000).toISOString(),
    };
  });
}

function draftListLines(params: Record<string, unknown>): string {
  const raw = params["items"];
  if (Array.isArray(raw)) {
    return raw
      .slice(0, 10)
      .map((entry) => {
        if (typeof entry === "string") return entry.slice(0, 200);
        if (typeof entry === "object" && entry !== null) {
          const rec = entry as Record<string, unknown>;
          const text = typeof rec["text"] === "string" ? rec["text"] : "";
          if (text === "") return "";
          const qty = typeof rec["quantity"] === "string" ? rec["quantity"] : "";
          const unit = typeof rec["unit"] === "string" ? rec["unit"] : "";
          return `${qty !== "" ? `${qty}${unit !== "" ? ` ${unit}` : ""} ` : ""}${text}`.slice(0, 200);
        }
        return "";
      })
      .filter((line) => line !== "")
      .join("\n");
  }
  const single = params["item"] ?? params["title"] ?? params["text"];
  return typeof single === "string" ? single.slice(0, 200) : "";
}

function draftFromParams(params: Record<string, unknown>): ItemDraft {
  const poll = "question" in params ? draftPollOptions(params) : null;
  // Memoria: el texto viaja en `content` (no en `title`).
  const memory = "content" in params ? params : null;
  // Serie: la regla viaja en `kind`/`weekdays`/`monthDay`… y la rotación en
  // `rotation` (uids en orden). Se distingue de una encuesta (que también trae
  // `kind`) por las claves propias de la serie.
  const series =
    "kind" in params &&
    typeof params["kind"] === "string" &&
    ("startDate" in params || "timeOfDay" in params || "rotation" in params)
      ? params
      : null;
  const title =
    poll !== null
      ? typeof params["question"] === "string"
        ? params["question"].slice(0, 200)
        : ""
      : memory !== null
        ? typeof memory["content"] === "string"
          ? memory["content"].slice(0, 1000)
          : ""
        : typeof params["title"] === "string" || typeof params["text"] === "string" || typeof params["item"] === "string"
          ? String(params["title"] ?? params["item"] ?? params["text"] ?? "")
          : draftListLines(params).split("\n")[0] ?? "";
  let date = "";
  let time = "";
  // En memoria la única fecha posible es la caducidad (`expiresAt`) y no lleva
  // hora: por eso no pasa por DATE_KEYS.
  if (memory !== null) {
    const rawExpiry = memory["expiresAt"] ?? memory["expires_at"];
    if (typeof rawExpiry === "string") {
      const split = splitDateTime(rawExpiry);
      if (split !== null) date = split.date;
    }
  } else {
    for (const key of DATE_KEYS) {
      const raw = params[key];
      if (typeof raw === "string") {
        const split = splitDateTime(raw);
        if (split !== null) {
          date = split.date;
          time = split.time;
          break;
        }
      }
    }
  }
  const rawAssignees = params["assigneeIds"] ?? params["assignee_ids"];
  const assignee = Array.isArray(rawAssignees) && typeof rawAssignees[0] === "string"
    ? rawAssignees[0] as string
    : "";
  const projectId = typeof params["projectId"] === "string" || typeof params["project_id"] === "string"
    ? String(params["projectId"] ?? params["project_id"] ?? "")
    : "";
  const listName = typeof params["list"] === "string" ? params["list"] : "";
  const listItems = poll !== null ? poll.items : draftListLines(params);
  const checked = typeof params["checked"] === "boolean" ? params["checked"] : true;
  const rawWeekdays = series !== null && Array.isArray(series["weekdays"]) ? series["weekdays"] : [];
  const rawRotation =
    series !== null && Array.isArray(params["rotation"]) ? params["rotation"] : [];
  const startDate =
    series !== null && typeof series["startDate"] === "string" ? series["startDate"] : "";
  const dateParts = startDate === "" ? null : splitDateTime(`${startDate}T12:00`);
  const remindTime =
    series !== null && typeof series["remindTime"] === "string" ? series["remindTime"] : "09:00";
  if (series !== null && time === "") {
    // En una serie la hora viaja en `timeOfDay` (no en las claves de fecha).
    time =
      typeof series["timeOfDay"] === "string" ? series["timeOfDay"].slice(0, 5) : "";
  }
  return {
    include: true,
    title,
    date: dateParts === null ? date : dateParts.date,
    time,
    assignee,
    projectId,
    listName,
    listItems,
    checked,
    pollKind: poll?.kind ?? "single",
    pollDates: poll?.dates ?? [],
    anonymous: poll?.anonymous ?? false,
    memoryCategory:
      memory !== null && typeof memory["category"] === "string"
        ? memory["category"]
        : "otros",
    memorySensitive: memory !== null && memory["sensitive"] === true,
    memoryExpires: date,
    seriesKind: series !== null ? String(series["kind"]) : "weekly",
    seriesInterval:
      series !== null && typeof series["interval"] === "number" ? series["interval"] : 1,
    seriesUnit: series !== null && series["unit"] === "days" ? "days" : "weeks",
    seriesWeekdays: rawWeekdays.filter(
      (day): day is number => typeof day === "number" && day >= 0 && day <= 6,
    ),
    seriesMonthDay:
      series !== null && typeof series["monthDay"] === "number" ? String(series["monthDay"]) : "",
    seriesMonthWeek:
      series !== null && typeof series["monthWeek"] === "number" ? String(series["monthWeek"]) : "",
    seriesMonthWeekday:
      series !== null && typeof series["monthWeekday"] === "number"
        ? String(series["monthWeekday"])
        : "",
    seriesRotation: rawRotation.filter(
      (uid): uid is string => typeof uid === "string" && uid !== "",
    ),
    seriesRemindTime: remindTime,
  };
}

function applyDraft(
  params: Record<string, unknown>,
  draft: ItemDraft,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  // Una serie trae `kind` (como una encuesta) pero además sus claves propias:
  // `startDate`, `timeOfDay` o `rotation`.
  const isSeries =
    "kind" in next && ("startDate" in next || "timeOfDay" in next || "rotation" in next);
  if ("title" in next) next["title"] = draft.title;
  if ("text" in next && !("title" in next)) next["text"] = draft.title;
  if ("item" in next) next["item"] = draft.title;
  if ("items" in next) {
    const lines = draft.listItems
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(0, 10)
      .map((line) => ({ text: line }));
    next["items"] = lines;
  }
  if ("list" in next && draft.listName !== "") next["list"] = draft.listName;
  if ("checked" in next) next["checked"] = draft.checked;
  // Memoria: texto en `content`, y la fecha es la caducidad (sin hora).
  if ("content" in next) {
    next["content"] = draft.title;
    next["category"] = draft.memoryCategory;
    next["sensitive"] = draft.memorySensitive;
    next["expiresAt"] =
      draft.memoryExpires === ""
        ? null
        : (joinDateTime(draft.memoryExpires, "12:00") ?? null);
  }
  // Encuesta: la pregunta viaja en `question` y las opciones en `options`.
  if ("question" in next) {
    next["question"] = draft.title;
    next["kind"] = draft.pollKind;
    next["options"] = buildPollOptions(draft);
    next["anonymous"] = draft.anonymous;
    // La fecha elegida es el cierre de la encuesta (no va a `dueAt`).
    if (draft.date !== "") {
      const iso = joinDateTime(draft.date, draft.time);
      if (iso !== null) next["closesAt"] = iso;
    }
  }
  if ("content" in next) {
    // La memoria ya tiene su caducidad: nada más que interpretar fechas aquí.
  } else if (draft.date !== "" && !isSeries) {
    const iso = joinDateTime(draft.date, draft.time);
    if (iso !== null) {
      for (const key of DATE_KEYS) {
        if (key in next) next[key] = iso;
      }
      // Si no había fecha (p. ej. tarea) y el usuario puso una, va a dueAt
      // en tareas y a startsAt en eventos/recordatorios (en la encuesta la
      // fecha es el cierre y lo pone su propio bloque de más abajo).
      if (!DATE_KEYS.some((key) => key in params) && !("question" in next)) {
        next["dueAt"] = iso;
      }
    }
  }
  // Serie: la plantilla y la regla viajan en sus propias claves.
  if (isSeries) {
    next["title"] = draft.title;
    next["kind"] = draft.seriesKind;
    next["interval"] = Math.min(60, Math.max(1, Math.round(draft.seriesInterval)));
    next["unit"] = draft.seriesUnit;
    if (draft.seriesKind === "weekly") {
      next["weekdays"] = draft.seriesWeekdays;
      next["monthDay"] = null;
      next["monthWeek"] = null;
      next["monthWeekday"] = null;
    } else if (draft.seriesKind === "monthly") {
      next["weekdays"] = [];
      if (draft.seriesMonthDay !== "") {
        next["monthDay"] = Number(draft.seriesMonthDay);
        next["monthWeek"] = null;
        next["monthWeekday"] = null;
      } else {
        next["monthDay"] = null;
        next["monthWeek"] = Number(draft.seriesMonthWeek);
        next["monthWeekday"] = Number(draft.seriesMonthWeekday);
      }
    } else {
      next["weekdays"] = [];
      next["monthDay"] = null;
      next["monthWeek"] = null;
      next["monthWeekday"] = null;
    }
    next["startDate"] = draft.date === "" ? next["startDate"] : draft.date;
    next["timeOfDay"] = draft.time === "" ? next["timeOfDay"] : draft.time;
    next["remindTime"] = draft.seriesRemindTime;
    next["rotation"] = draft.seriesRotation;
  }
  if (draft.assignee !== "") {
    next["assigneeIds"] = draft.assignee === "none" ? [] : [draft.assignee];
  }
  if (draft.projectId !== "") {
    if ("projectId" in next || !("project_id" in next)) next["projectId"] = draft.projectId;
    else next["project_id"] = draft.projectId;
  }
  return next;
}

const inputClass =
  "h-11 w-full rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none";
const labelClass = "block text-meta leading-4 text-muted-foreground";

/**
 * Campos de una orden al PC en la tarjeta de confirmación: resumen de lo que
 * se va a ejecutar, texto editable cuando la acción lo pide y el camino según
 * riesgo (directo, tarjeta o aprobación en el teléfono).
 */
function DevicePendingFields({
  params,
  draft,
  onPatch,
}: {
  params: Record<string, unknown>;
  draft: ItemDraft;
  onPatch: (patch: Partial<ItemDraft>) => void;
}): React.JSX.Element {
  const catalogAction = typeof params["action"] === "string" ? params["action"] : "";
  const entry = deviceCatalogEntry(catalogAction);
  const deviceName =
    typeof params["deviceName"] === "string" && params["deviceName"] !== ""
      ? params["deviceName"]
      : "tu PC";
  const risk = deviceRiskOf(catalogAction);
  const rest: Record<string, unknown> = { ...params, text: draft.title };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body-sm leading-5 text-foreground">
        {deviceSummary(catalogAction, rest)}{" "}
        <span className="text-muted-foreground">en {deviceName}</span>
      </p>
      {entry?.needsText === true ? (
        <label className="flex flex-col gap-1">
          <span className={labelClass}>
            <Pencil className="mr-1 inline h-3 w-3" aria-hidden="true" />
            {catalogAction === "open_url" ? "URL https" : "Detalle"}
          </span>
          <input
            type="text"
            aria-label="Detalle de la orden al PC"
            value={draft.title}
            onChange={(event) => onPatch({ title: event.target.value })}
            maxLength={2000}
            className={cn(inputClass, "min-h-11")}
          />
        </label>
      ) : null}
      <p className="text-meta leading-4 text-muted-foreground">
        {risk === "sensible"
          ? "Acción sensible: al confirmar se pide tu aprobación en el teléfono."
          : "Se ejecuta en tu PC al confirmar."}
      </p>
    </div>
  );
}

/**
 * Campos de una tarea que se repite: la regla (con chips de día, iguales que
 * en la hoja) y el padrón de turnos en orden. Todo es código, no IA: la tarjeta
 * deja corregir lo que el analizador entendió.
 */
function SeriesPendingFields({
  draft,
  members,
  onPatch,
}: {
  draft: ItemDraft;
  members: CardMember[];
  onPatch: (patch: Partial<ItemDraft>) => void;
}): React.JSX.Element {
  const inRotation = (uid: string): number => draft.seriesRotation.indexOf(uid);
  const toggle = (uid: string): void => {
    onPatch({
      seriesRotation:
        inRotation(uid) >= 0
          ? draft.seriesRotation.filter((value) => value !== uid)
          : [...draft.seriesRotation, uid],
    });
  };
  const move = (uid: string, delta: number): void => {
    const copy = [...draft.seriesRotation];
    const index = copy.indexOf(uid);
    const next = index + delta;
    if (index === -1 || next < 0 || next >= copy.length) return;
    const [moved] = copy.splice(index, 1);
    if (moved === undefined) return;
    copy.splice(next, 0, moved);
    onPatch({ seriesRotation: copy });
  };
  const toggleWeekday = (day: number): void => {
    onPatch({
      seriesWeekdays: draft.seriesWeekdays.includes(day)
        ? draft.seriesWeekdays.filter((value) => value !== day)
        : [...draft.seriesWeekdays, day],
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className={labelClass}>
          <Pencil className="mr-1 inline h-3 w-3" aria-hidden="true" />
          Lo que se repite
        </span>
        <input
          type="text"
          aria-label="Lo que se repite"
          value={draft.title}
          onChange={(event) => onPatch({ title: event.target.value })}
          maxLength={200}
          className={cn(inputClass, "min-h-11")}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Cada</span>
          <select
            aria-label="Frecuencia"
            value={draft.seriesKind}
            onChange={(event) => onPatch({ seriesKind: event.target.value })}
            className={cn(inputClass, "min-h-11")}
          >
            {SERIES_KIND_LABELS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {draft.seriesKind === "interval" ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Cada</span>
              <input
                type="number"
                min={1}
                max={60}
                inputMode="numeric"
                aria-label="Cada cuántas unidades"
                value={draft.seriesInterval}
                onChange={(event) =>
                  onPatch({ seriesInterval: Number(event.target.value) || 1 })
                }
                className={cn(inputClass, "min-h-11")}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Unidad</span>
              <select
                aria-label="Unidad del intervalo"
                value={draft.seriesUnit}
                onChange={(event) => onPatch({ seriesUnit: event.target.value })}
                className={cn(inputClass, "min-h-11")}
              >
                <option value="days">días</option>
                <option value="weeks">semanas</option>
              </select>
            </label>
          </div>
        ) : draft.seriesKind === "monthly" && draft.seriesMonthDay === "" ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Cuál</span>
              <select
                aria-label="Semana del mes"
                value={draft.seriesMonthWeek === "" ? "1" : draft.seriesMonthWeek}
                onChange={(event) => onPatch({ seriesMonthWeek: event.target.value })}
                className={cn(inputClass, "min-h-11")}
              >
                <option value="1">primero</option>
                <option value="2">segundo</option>
                <option value="3">tercero</option>
                <option value="4">cuarto</option>
                <option value="5">último</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Día</span>
              <select
                aria-label="Día de la semana"
                value={draft.seriesMonthWeekday === "" ? "1" : draft.seriesMonthWeekday}
                onChange={(event) => onPatch({ seriesMonthWeekday: event.target.value })}
                className={cn(inputClass, "min-h-11")}
              >
                <option value="1">lunes</option>
                <option value="2">martes</option>
                <option value="3">miércoles</option>
                <option value="4">jueves</option>
                <option value="5">viernes</option>
                <option value="6">sábado</option>
                <option value="0">domingo</option>
              </select>
            </label>
          </div>
        ) : draft.seriesKind === "monthly" ? (
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Día</span>
            <input
              type="number"
              min={1}
              max={31}
              inputMode="numeric"
              aria-label="Día del mes"
              value={draft.seriesMonthDay}
              onChange={(event) => onPatch({ seriesMonthDay: event.target.value })}
              className={cn(inputClass, "min-h-11")}
            />
          </label>
        ) : (
          <span />
        )}
      </div>
      {draft.seriesKind === "weekly" ? (
        <div role="group" aria-label="Días de la semana" className="flex gap-1">
          {SERIES_WEEKDAY_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              aria-pressed={draft.seriesWeekdays.includes(chip.value)}
              aria-label={chip.label}
              onClick={() => toggleWeekday(chip.value)}
              className={cn(
                "h-10 w-10 rounded-full text-body-sm font-semibold outline-none interactive",
                draft.seriesWeekdays.includes(chip.value)
                  ? "bg-foreground text-background dark:bg-white dark:text-black"
                  : "bg-surface-soft text-muted-foreground",
              )}
            >
              {chip.short}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Primera vez</span>
          <input
            type="date"
            aria-label="Primera ocurrencia"
            value={draft.date}
            onChange={(event) => onPatch({ date: event.target.value })}
            className={cn(inputClass, "min-h-11")}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Hora</span>
          <input
            type="time"
            aria-label="Hora de la ocurrencia"
            value={draft.time}
            onChange={(event) => onPatch({ time: event.target.value })}
            className={cn(inputClass, "min-h-11")}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Aviso</span>
          <input
            type="time"
            aria-label="Hora del aviso"
            value={draft.seriesRemindTime}
            onChange={(event) => onPatch({ seriesRemindTime: event.target.value })}
            className={cn(inputClass, "min-h-11")}
          />
        </label>
      </div>
      <div>
        <span className={labelClass}>Turnos (en orden)</span>
        <p className="mb-1 text-meta text-muted-foreground">
          Toca a quien participe, en el orden que deba tocarle.
        </p>
        <div role="group" aria-label="Rotación de turnos" className="flex flex-col">
          {members.map((member) => {
            const position = inRotation(member.uid);
            return (
              <div key={member.uid} className="flex min-h-11 items-center gap-2">
                <Checkbox
                  checked={position >= 0}
                  onCheckedChange={() => toggle(member.uid)}
                  label={member.name}
                />
                <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
                  {member.name}
                </span>
                {position >= 0 ? (
                  <span className="flex items-center gap-1">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-soft text-meta font-semibold text-foreground">
                      {position + 1}
                    </span>
                    <button
                      type="button"
                      aria-label={`Subir a ${member.name}`}
                      disabled={position === 0}
                      onClick={() => move(member.uid, -1)}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground outline-none interactive disabled:opacity-40"
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Bajar a ${member.name}`}
                      disabled={position === draft.seriesRotation.length - 1}
                      onClick={() => move(member.uid, 1)}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground outline-none interactive disabled:opacity-40"
                    >
                      <ArrowDown size={16} />
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-meta text-muted-foreground">
        Las fechas siguen tu zona horaria y las horas de aviso llegan por push (salvo
        que las apagues en Configuración → Notificaciones).
      </p>
    </div>
  );
}

/**
 * Tarjeta de confirmación para acciones de Loki IA.
 * - Una acción: resumen + edición compacta (título, fecha/hora, responsable,
 *   proyecto) + Confirmar/Cancelar.
 * - Plan: lista con casilla por acción, cada una editable.
 * Todo táctil ≥44px, apilado en 360px; Enter confirma y Escape cancela.
 */
export function AiToolCard({
  pending,
  sending,
  members,
  projects,
  workspaces,
  initialWorkspaceId,
  onConfirm,
  onCancel,
}: {
  pending: AiPendingAction;
  sending: boolean;
  members: CardMember[];
  projects: CardProject[];
  workspaces?: CardWorkspace[];
  initialWorkspaceId?: string;
  onConfirm: (payload: CardConfirmPayload) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const items: AiPendingItem[] = React.useMemo(
    () =>
      pending.actions !== undefined && pending.actions.length > 0
        ? pending.actions
        : [{ action: pending.action, label: pending.label, params: pending.params, include: true }],
    [pending],
  );
  const isPlan = pending.actions !== undefined && pending.actions.length > 0;
  const [drafts, setDrafts] = React.useState<ItemDraft[]>(() =>
    items.map((item) => ({
      ...draftFromParams(item.params),
      include: item.include,
    })),
  );
  const [workspaceId, setWorkspaceId] = React.useState(initialWorkspaceId ?? "");

  React.useEffect(() => {
    setDrafts(items.map((item) => ({ ...draftFromParams(item.params), include: item.include })));
  }, [pending.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function setDraft(index: number, patch: Partial<ItemDraft>): void {
    setDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  function handleConfirm(): void {
    if (sending) return;
    void (async () => {
      try {
        const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
        await Haptics.impact({ style: ImpactStyle.Light });
      } catch {
        // Web sin hápticos: se confirma igual.
      }
    })();
    if (isPlan) {
      onConfirm({
        actions: items.map((item, index) => {
          const draft = drafts[index] ?? draftFromParams(item.params);
          return {
            action: item.action,
            params: applyDraft(item.params, draft),
            include: draft.include,
          };
        }),
        params: pending.params,
        ...(workspaceId !== "" ? { workspaceId } : {}),
      });
      return;
    }
    const draft = drafts[0] ?? draftFromParams(pending.params);
    onConfirm({
      params: applyDraft(pending.params, draft),
      ...(workspaceId !== "" ? { workspaceId } : {}),
    });
  }

  // Enter confirma y Escape cancela cuando el foco está en la tarjeta
  // (en un select el Enter lo maneja el propio desplegable).
  function handleKey(event: React.KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      handleConfirm();
    }
  }

  const assigneeOptions = pending.assigneeChoices ?? members;
  const showAssignee = assigneeOptions.length > 0;
  const showProject = projects.length > 0;

  return (
    <div
      role="group"
      aria-label={`Confirmar: ${pending.label}`}
      onKeyDown={handleKey}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <ActionIcon action={pending.action} />
        <p className="text-body-sm font-semibold text-foreground">{pending.label}</p>
      </div>

      {workspaces !== undefined && workspaces.length > 1 ? (
        <label className="flex min-h-11 flex-col justify-center gap-1">
          <span className={labelClass}>Espacio</span>
          <select
            aria-label="Espacio donde se crea"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            className={cn(inputClass, "min-h-11")}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <ul className="flex flex-col gap-3">
        {items.map((item, index) => {
          const draft = drafts[index] ?? draftFromParams(item.params);
          return (
            <li
              key={`${item.action}-${index}`}
              className={cn(
                "flex flex-col gap-2 rounded-xl p-2",
                isPlan && "border border-divider",
                !draft.include && "opacity-60",
              )}
            >
              <div className="flex items-center gap-2">
                {isPlan ? (
                  <input
                    type="checkbox"
                    aria-label={`Incluir: ${item.label}`}
                    checked={draft.include}
                    disabled={item.warning !== undefined}
                    onChange={(event) => setDraft(index, { include: event.target.checked })}
                    className="h-6 w-6 shrink-0 accent-[var(--accent)]"
                  />
                ) : null}
                <ActionIcon action={item.action} />
                <p className="min-w-0 flex-1 truncate text-body-sm font-semibold text-foreground">
                  {item.label}
                </p>
              </div>
              {item.action === "run_device_command" ? (
                <DevicePendingFields
                  params={item.params}
                  draft={draft}
                  onPatch={(patch) => setDraft(index, patch)}
                />
              ) : item.action === "create_series" ? (
                <SeriesPendingFields
                  draft={draft}
                  members={members}
                  onPatch={(patch) => setDraft(index, patch)}
                />
              ) : item.warning !== undefined ? (
                <p role="alert" className="text-body-sm leading-5 text-danger">
                  {item.warning}
                </p>
              ) : item.action === "remember" ? (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>Qué se recuerda</span>
                    <textarea
                      aria-label="Recuerdo"
                      value={draft.title}
                      onChange={(event) => setDraft(index, { title: event.target.value })}
                      rows={2}
                      maxLength={1000}
                      className="min-h-22 w-full rounded-sm bg-surface-soft px-3 py-2 text-body-sm text-foreground outline-none"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className={labelClass}>Categoría</span>
                      <select
                        aria-label="Categoría del recuerdo"
                        value={draft.memoryCategory}
                        onChange={(event) =>
                          setDraft(index, { memoryCategory: event.target.value })
                        }
                        className={cn(inputClass, "min-h-11")}
                      >
                        {MEMORY_CATEGORY_LABELS.map((entry) => (
                          <option key={entry.value} value={entry.value}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={labelClass}>Caduca (opcional)</span>
                      <input
                        type="date"
                        aria-label="Fecha de caducidad del recuerdo"
                        value={draft.memoryExpires}
                        onChange={(event) =>
                          setDraft(index, { memoryExpires: event.target.value })
                        }
                        className={cn(inputClass, "min-h-11")}
                      />
                    </label>
                  </div>
                  <label className="flex min-h-11 items-center gap-2 text-body-sm text-foreground">
                    <input
                      type="checkbox"
                      aria-label="Recuerdo sensible"
                      checked={draft.memorySensitive}
                      onChange={(event) =>
                        setDraft(index, { memorySensitive: event.target.checked })
                      }
                      className="h-6 w-6 accent-[var(--accent)]"
                    />
                    Sensible (queda oculto y nunca sale en push)
                  </label>
                </div>
              ) : item.action === "create_poll" ? (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>Pregunta</span>
                    <input
                      type="text"
                      aria-label="Pregunta de la encuesta"
                      value={draft.title}
                      onChange={(event) => setDraft(index, { title: event.target.value })}
                      maxLength={200}
                      className={cn(inputClass, "min-h-11")}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>Tipo</span>
                    <select
                      aria-label="Tipo de encuesta"
                      value={draft.pollKind}
                      onChange={(event) => setDraft(index, { pollKind: event.target.value })}
                      className={cn(inputClass, "min-h-11")}
                    >
                      {POLL_KIND_LABELS.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className={labelClass}>Cierra (opcional)</span>
                      <input
                        type="date"
                        aria-label="Fecha de cierre de la encuesta"
                        value={draft.date}
                        onChange={(event) => setDraft(index, { date: event.target.value })}
                        className={cn(inputClass, "min-h-11")}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={labelClass}>Hora</span>
                      <input
                        type="time"
                        aria-label="Hora de cierre de la encuesta"
                        value={draft.time}
                        onChange={(event) => setDraft(index, { time: event.target.value })}
                        className={cn(inputClass, "min-h-11")}
                      />
                    </label>
                  </div>
                  {draft.pollKind === "yesno" ? (
                    <p className="text-meta leading-4 text-muted-foreground">
                      Salvo Sí y No, para aprobar algo rápido.
                    </p>
                  ) : (
                    <>
                      <label className="flex flex-col gap-1">
                        <span className={labelClass}>Opciones (una por línea)</span>
                        <textarea
                          aria-label="Opciones de la encuesta"
                          value={draft.listItems}
                          onChange={(event) => setDraft(index, { listItems: event.target.value })}
                          rows={3}
                          maxLength={2000}
                          className="min-h-22 w-full rounded-sm bg-surface-soft px-3 py-2 text-body-sm text-foreground outline-none"
                        />
                      </label>
                      {draft.pollKind === "date" ? (
                        <div className="flex flex-col gap-1">
                          <span className={labelClass}>Día y hora de cada opción</span>
                          {draft.listItems
                            .split("\n")
                            .map((line) => line.trim())
                            .filter((line) => line !== "")
                            .slice(0, 20)
                            .map((line, optionIndex) => (
                              <label
                                key={optionIndex}
                                className="flex min-h-11 flex-col justify-center gap-0.5"
                              >
                                <span className="truncate text-meta text-muted-foreground">
                                  {line}
                                </span>
                                <input
                                  type="datetime-local"
                                  aria-label={`Fecha y hora de ${line}`}
                                  value={draft.pollDates[optionIndex] ?? ""}
                                  onChange={(event) => {
                                    const dates = [...draft.pollDates];
                                    dates[optionIndex] = event.target.value;
                                    setDraft(index, { pollDates: dates });
                                  }}
                                  className={cn(inputClass, "min-h-11")}
                                />
                              </label>
                            ))}
                        </div>
                      ) : null}
                    </>
                  )}
                  <label className="flex min-h-11 items-center gap-2 text-body-sm text-foreground">
                    <input
                      type="checkbox"
                      aria-label="Encuesta anónima"
                      checked={draft.anonymous}
                      onChange={(event) => setDraft(index, { anonymous: event.target.checked })}
                      className="h-6 w-6 accent-[var(--accent)]"
                    />
                    Anónima (nadie ve quién votó)
                  </label>
                </div>
              ) : item.action === "add_list_items" || item.action === "create_list_item" ? (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>Lista</span>
                    <input
                      type="text"
                      aria-label="Lista"
                      value={draft.listName}
                      onChange={(event) => setDraft(index, { listName: event.target.value })}
                      maxLength={120}
                      className={cn(inputClass, "min-h-11")}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>Ítems (uno por línea)</span>
                    <textarea
                      aria-label="Ítems"
                      value={draft.listItems}
                      onChange={(event) => setDraft(index, { listItems: event.target.value })}
                      rows={3}
                      maxLength={2000}
                      className="min-h-22 w-full rounded-sm bg-surface-soft px-3 py-2 text-body-sm text-foreground outline-none"
                    />
                  </label>
                </div>
              ) : item.action === "check_list_item" || item.action === "remove_list_item" ? (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>
                      <Pencil className="mr-1 inline h-3 w-3" aria-hidden="true" />
                      Ítem
                    </span>
                    <input
                      type="text"
                      aria-label="Ítem"
                      value={draft.title}
                      onChange={(event) => setDraft(index, { title: event.target.value })}
                      maxLength={200}
                      className={cn(inputClass, "min-h-11")}
                    />
                  </label>
                  {item.action === "check_list_item" ? (
                    <label className="flex min-h-11 items-center gap-2 text-body-sm text-foreground">
                      <input
                        type="checkbox"
                        aria-label="Marcar como hecho"
                        checked={draft.checked}
                        onChange={(event) => setDraft(index, { checked: event.target.checked })}
                        className="h-6 w-6 shrink-0 accent-[var(--accent)]"
                      />
                      Marcar como hecho
                    </label>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>
                      <Pencil className="mr-1 inline h-3 w-3" aria-hidden="true" />
                      Título
                    </span>
                    <input
                      type="text"
                      aria-label="Título"
                      value={draft.title}
                      onChange={(event) => setDraft(index, { title: event.target.value })}
                      maxLength={200}
                      className={cn(inputClass, "min-h-11")}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className={labelClass}>Fecha</span>
                      <input
                        type="date"
                        aria-label="Fecha"
                        value={draft.date}
                        onChange={(event) => setDraft(index, { date: event.target.value })}
                        className={cn(inputClass, "min-h-11")}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={labelClass}>Hora</span>
                      <input
                        type="time"
                        aria-label="Hora"
                        value={draft.time}
                        onChange={(event) => setDraft(index, { time: event.target.value })}
                        className={cn(inputClass, "min-h-11")}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {showAssignee ? (
                      <label className="flex flex-col gap-1">
                        <span className={labelClass}>Responsable</span>
                        <select
                          aria-label="Responsable"
                          value={draft.assignee}
                          onChange={(event) => setDraft(index, { assignee: event.target.value })}
                          className={cn(inputClass, "min-h-11")}
                        >
                          <option value="">Sin cambio</option>
                          <option value="none">Solo yo</option>
                          {assigneeOptions.map((member) => (
                            <option key={member.uid} value={member.uid}>
                              {member.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {showProject && (item.action === "create_task" || item.action === "create_reminder" || item.action === "update_task") ? (
                      <label className="flex flex-col gap-1">
                        <span className={labelClass}>Proyecto</span>
                        <select
                          aria-label="Proyecto"
                          value={draft.projectId}
                          onChange={(event) => setDraft(index, { projectId: event.target.value })}
                          className={cn(inputClass, "min-h-11")}
                        >
                          <option value="">Bandeja</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.isSystem ? "📥 " : ""}{project.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={sending}
          onClick={handleConfirm}
          className="min-h-11 flex-1 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {sending ? "Enviando…" : "Confirmar"}
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={onCancel}
          className="min-h-11 flex-1 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive disabled:opacity-60"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

/**
 * Barra de "Deshacer" tras ejecutar: vive unos segundos y borra lo creado
 * (tarea, evento o aviso) con el propio usuario.
 */
export function UndoBar({
  items,
  onUndo,
  onDone,
  seconds = 30,
}: {
  items: UndoItem[];
  onUndo: (items: UndoItem[]) => void;
  onDone: () => void;
  seconds?: number;
}): React.JSX.Element | null {
  const [left, setLeft] = React.useState(seconds);

  React.useEffect(() => {
    setLeft(seconds);
    const timer = setInterval(() => {
      setLeft((value) => {
        if (value <= 1) {
          clearInterval(timer);
          onDone();
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [items, seconds, onDone]);

  if (items.length === 0 || left <= 0) return null;
  return (
    <div
      role="status"
      className="pointer-events-auto flex min-h-11 w-full items-center gap-2 rounded-2xl bg-foreground px-4 py-2 text-background shadow-overlay dark:bg-white dark:text-black"
    >
      <span className="min-w-0 flex-1 truncate text-body-sm">
        Creado · se puede deshacer ({left}s)
      </span>
      <button
        type="button"
        onClick={() => {
          onUndo(items);
          onDone();
        }}
        className="flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 text-body-sm font-semibold outline-none interactive"
      >
        <Undo2 className="h-4 w-4" aria-hidden="true" />
        Deshacer
      </button>
    </div>
  );
}
