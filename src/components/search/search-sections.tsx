"use client";

/**
 * Secciones de resultados compartidas por la paleta de escritorio
 * (`search-palette.tsx`) y la pantalla móvil (`search-screen.tsx`).
 *
 * Cada resultado abre exactamente en su lugar: el mensaje resaltado en su
 * chat (`?msg=`), la tarea en su hoja, la lista con su ítem, la encuesta en
 * su tarjeta y el archivo en su mensaje (de ahí al visor). Las personas son
 * informativas (sin destino propio).
 */

import * as React from "react";
import {
  BarChart3,
  Brain,
  CalendarDays,
  ClipboardList,
  FileText,
  FolderKanban,
  Image,
  Lightbulb,
  ListChecks,
  MessageCircle,
  Mic,
  ShoppingCart,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { highlight, type SearchGroupKey, type SearchResults } from "@/lib/data/search";

export type ResultItemKind =
  | SearchGroupKey
  | "recent"
  | "action";

export type ResultItem = {
  key: string;
  kind: ResultItemKind;
  /** Destino de recientes (para guardar al abrir). */
  recentKind: "message" | "task" | "project" | "event" | "action" | "list" | "poll" | "idea" | "attachment" | "memory";
  title: string;
  subtitle: string;
  /** Tercera línea (OCR, detalle de idea, estado de encuesta…). */
  detail: string | null;
  /** Null = informativo, sin destino. */
  href: string | null;
  icon: LucideIcon;
  /** Texto donde se resaltan las coincidencias. */
  highlightText: string;
  emoji?: string;
};

export type ResultSection = {
  key: string;
  label: string;
  group: SearchGroupKey | null;
  items: ResultItem[];
};

export type TypeChip = {
  key: string;
  label: string;
  /** Null = todos los grupos. */
  types: SearchGroupKey[] | null;
};

export const TYPE_CHIPS: readonly TypeChip[] = [
  { key: "all", label: "Todo", types: null },
  { key: "messages", label: "Mensajes", types: ["messages"] },
  { key: "voice", label: "Voz", types: ["transcriptions"] },
  { key: "files", label: "Archivos", types: ["attachments"] },
  { key: "lists", label: "Listas", types: ["lists", "list_items"] },
  { key: "polls", label: "Encuestas", types: ["polls"] },
  { key: "ideas", label: "Ideas", types: ["ideas"] },
  { key: "memories", label: "Recuerdos", types: ["memories"] },
  { key: "tasks", label: "Tareas", types: ["tasks"] },
  { key: "projects", label: "Proyectos", types: ["projects"] },
  { key: "events", label: "Eventos", types: ["events"] },
  { key: "people", label: "Personas", types: ["people"] },
];

function attachmentIcon(kind: string): LucideIcon {
  if (kind === "image") return Image;
  if (kind === "video") return Video;
  if (kind === "audio") return Mic;
  return FileText;
}

/**
 * Convierte los 12 grupos de la RPC en secciones listas para pintar.
 * `query` es el texto limpio (sin `de:` ni fechas) para el resaltado.
 */
export function buildResultSections(
  results: SearchResults,
  query: string,
): ResultSection[] {
  void query;
  const out: ResultSection[] = [];
  if (results.messages.length > 0) {
    out.push({
      key: "messages",
      label: "Mensajes",
      group: "messages",
      items: results.messages.map((hit) => ({
        key: `message:${hit.id}`,
        kind: "messages",
        recentKind: "message",
        title: hit.text === "" ? "(sin texto)" : hit.text,
        subtitle: `${hit.authorName} · ${hit.chatName}`,
        detail: null,
        href: `/chat/c?id=${encodeURIComponent(hit.chatId)}&msg=${encodeURIComponent(hit.id)}`,
        icon: MessageCircle,
        highlightText: hit.text,
      })),
    });
  }
  if (results.transcriptions.length > 0) {
    out.push({
      key: "transcriptions",
      label: "Notas de voz",
      group: "transcriptions",
      items: results.transcriptions.map((hit) => ({
        key: `transcription:${hit.id}`,
        kind: "transcriptions",
        recentKind: "message",
        title: hit.text === "" ? "(sin texto)" : hit.text,
        subtitle:
          hit.authorName === "" ? "Transcripción" : `${hit.authorName} · transcripción`,
        detail: null,
        href:
          hit.chatId !== null && hit.chatId !== "" && hit.messageId !== null
            ? `/chat/c?id=${encodeURIComponent(hit.chatId)}&msg=${encodeURIComponent(hit.messageId)}`
            : hit.chatId !== null && hit.chatId !== ""
              ? `/chat/c?id=${encodeURIComponent(hit.chatId)}`
              : "/chat/loki-ia",
        icon: Mic,
        highlightText: hit.text,
      })),
    });
  }
  if (results.attachments.length > 0) {
    out.push({
      key: "attachments",
      label: "Archivos",
      group: "attachments",
      items: results.attachments.map((hit) => ({
        key: `attachment:${hit.id}`,
        kind: "attachments",
        recentKind: "attachment",
        title: hit.name,
        subtitle: `${hit.authorName} · ${hit.chatName}`,
        detail: hit.ocrText === "" ? null : `Dice: «${hit.ocrText}»`,
        href: `/chat/c?id=${encodeURIComponent(hit.chatId)}&msg=${encodeURIComponent(hit.messageId)}`,
        icon: attachmentIcon(hit.kind),
        highlightText: hit.ocrText === "" ? hit.name : hit.ocrText,
      })),
    });
  }
  if (results.lists.length > 0) {
    out.push({
      key: "lists",
      label: "Listas",
      group: "lists",
      items: results.lists.map((hit) => ({
        key: `list:${hit.id}`,
        kind: "lists",
        recentKind: "list",
        title: hit.title,
        subtitle: "Lista",
        detail: null,
        href: `/proyectos?tab=listas&list=${encodeURIComponent(hit.id)}`,
        icon: ShoppingCart,
        highlightText: hit.title,
        emoji: hit.emoji,
      })),
    });
  }
  if (results.listItems.length > 0) {
    out.push({
      key: "list_items",
      label: "Ítems",
      group: "list_items",
      items: results.listItems.map((hit) => ({
        key: `list-item:${hit.id}`,
        kind: "list_items",
        recentKind: "list",
        title: hit.text,
        subtitle: `${hit.checked ? "Hecho · " : ""}${hit.listTitle}`,
        detail: null,
        href: `/proyectos?tab=listas&list=${encodeURIComponent(hit.listId)}`,
        icon: ListChecks,
        highlightText: hit.text,
      })),
    });
  }
  if (results.polls.length > 0) {
    out.push({
      key: "polls",
      label: "Encuestas",
      group: "polls",
      items: results.polls.map((hit) => ({
        key: `poll:${hit.id}`,
        kind: "polls",
        recentKind: "poll",
        title: hit.question,
        subtitle: `${hit.chatName} · ${hit.isOpen ? "Abierta" : "Cerrada"}`,
        detail: null,
        href: `/chat/c?id=${encodeURIComponent(hit.chatId)}&msg=${encodeURIComponent(hit.messageId)}`,
        icon: BarChart3,
        highlightText: hit.question,
      })),
    });
  }
  if (results.ideas.length > 0) {
    out.push({
      key: "ideas",
      label: "Ideas",
      group: "ideas",
      items: results.ideas.map((hit) => ({
        key: `idea:${hit.id}`,
        kind: "ideas",
        recentKind: "idea",
        title: hit.title,
        subtitle: hit.tag === "" ? "Idea" : `Idea · ${hit.tag}`,
        detail: hit.detail === "" ? null : hit.detail,
        href: "/proyectos?tab=ideas",
        icon: Lightbulb,
        highlightText: hit.title,
      })),
    });
  }
  if (results.memories.length > 0) {
    out.push({
      key: "memories",
      label: "Recuerdos",
      group: "memories",
      items: results.memories.map((hit) => ({
        key: `memory:${hit.id}`,
        kind: "memories",
        recentKind: "memory",
        title: hit.content,
        subtitle: `Recuerdo · ${hit.authorName}`,
        detail: null,
        href: "/memoria",
        icon: Brain,
        highlightText: hit.content,
      })),
    });
  }
  if (results.tasks.length > 0) {
    out.push({
      key: "tasks",
      label: "Tareas",
      group: "tasks",
      items: results.tasks.map((hit) => ({
        key: `task:${hit.id}`,
        kind: "tasks",
        recentKind: "task",
        title: hit.title,
        subtitle: hit.projectName === "" ? "Tarea" : hit.projectName,
        detail: null,
        href: `/proyectos?project=${encodeURIComponent(hit.projectId)}&task=${encodeURIComponent(hit.id)}`,
        icon: ClipboardList,
        highlightText: hit.title,
      })),
    });
  }
  if (results.projects.length > 0) {
    out.push({
      key: "projects",
      label: "Proyectos",
      group: "projects",
      items: results.projects.map((hit) => ({
        key: `project:${hit.id}`,
        kind: "projects",
        recentKind: "project",
        title: hit.name,
        subtitle: "Proyecto",
        detail: null,
        href: `/proyectos?project=${encodeURIComponent(hit.id)}`,
        icon: FolderKanban,
        highlightText: hit.name,
        emoji: hit.emoji,
      })),
    });
  }
  if (results.events.length > 0) {
    out.push({
      key: "events",
      label: "Eventos",
      group: "events",
      items: results.events.map((hit) => ({
        key: `event:${hit.id}`,
        kind: "events",
        recentKind: "event",
        title: hit.title,
        subtitle: formatEventDate(hit.startsAt),
        detail: null,
        href: "/calendario",
        icon: CalendarDays,
        highlightText: hit.title,
      })),
    });
  }
  if (results.people.length > 0) {
    out.push({
      key: "people",
      label: "Personas",
      group: "people",
      items: results.people.map((person) => ({
        key: `person:${person.userId}`,
        kind: "people",
        recentKind: "action",
        title: person.displayName,
        subtitle: ROLE_LABELS[person.role] ?? "Miembro",
        detail: null,
        href: null,
        icon: Users,
        highlightText: person.displayName,
      })),
    });
  }
  return out;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  member: "Miembro",
};

function formatEventDate(iso: string): string {
  if (iso === "") return "Evento";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Evento";
  return date.toLocaleDateString("es", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Texto con las coincidencias envueltas en `<mark>`. */
export function Marked({ query, text }: { query: string; text: string }): React.JSX.Element {
  const parts = highlight(query, text);
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark
            key={index}
            className="rounded-sm bg-accent/20 font-semibold text-inherit"
          >
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
}
