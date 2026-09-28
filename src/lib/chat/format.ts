import type { Timestamp } from "firebase/firestore";
import type { MessageDoc } from "@/types/chat";

export type MessageDateInput = Timestamp | Date | null | undefined;

export function toDateSafe(input: MessageDateInput): Date | null {
  if (input === null || input === undefined) return null;
  if (input instanceof Date) return input;
  try {
    return input.toDate();
  } catch {
    return null;
  }
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatHour(input: MessageDateInput): string {
  const date = toDateSafe(input) ?? new Date();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Etiqueta de día: "Hoy" | "Ayer" | "lunes 21 de septiembre". */
export function formatDayLabel(input: MessageDateInput, now = new Date()): string {
  const date = toDateSafe(input) ?? now;
  if (sameDay(date, now)) return "Hoy";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Ayer";
  const weekday = new Intl.DateTimeFormat("es-ES", { weekday: "long" }).format(date);
  const day = date.getDate();
  const month = new Intl.DateTimeFormat("es-ES", { month: "long" }).format(date);
  return `${weekday} ${day} de ${month}`;
}

/** Clave yyyy-m-d para agrupar por día. */
export function dayKey(input: MessageDateInput): string {
  // Sin fecha (serverTimestamp pendiente) = ahora: cae bajo "Hoy",
  // nunca en epoch 0 al principio del historial.
  const date = toDateSafe(input) ?? new Date();
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Hora relativa corta para la lista: "9:41" | "Ayer" | "lun" | "21/09/25". */
export function formatChatTime(input: MessageDateInput, now = new Date()): string {  const date = toDateSafe(input) ?? now;
  if (sameDay(date, now)) return formatHour(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Ayer";
  const diffDays = Math.floor(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86400000,
  );
  if (diffDays >= 0 && diffDays < 7) {
    return new Intl.DateTimeFormat("es-ES", { weekday: "short" })
      .format(date)
      .replace(".", "");
  }
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear().toString().slice(2);
  return `${day}/${month}/${year}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Texto de "está escribiendo" (T14): 1 nombre, 2 nombres o genérico.
 * Devuelve null si no hay nadie escribiendo.
 */
export function formatTypingText(names: readonly string[]): string | null {
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ""))].sort(
    (a, b) => a.localeCompare(b, "es"),
  );
  if (unique.length === 0) return null;
  if (unique.length === 1) return `${unique[0]} está escribiendo…`;
  if (unique.length === 2) return `${unique[0]} y ${unique[1]} están escribiendo…`;
  return "Varias personas están escribiendo…";
}

export type MessageGroup = {
  key: string;
  authorId: string;
  authorName: string;
  isMine: boolean;
  messages: MessageDoc[];
};

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Agrupa consecutivos del mismo autor a menos de 5 minutos. */
export function groupMessages(
  messages: MessageDoc[],
  currentUid: string | null,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    const prev = last?.messages[last.messages.length - 1];
    // Sin fecha (serverTimestamp pendiente) = ahora: agrupa con el
    // bloque actual en vez de romper hacia epoch 0.
    const prevDate = prev ? (toDateSafe(prev.createdAt)?.getTime() ?? Date.now()) : 0;
    const currDate = toDateSafe(message.createdAt)?.getTime() ?? Date.now();
    const sameAuthor =
      last !== undefined &&
      prev !== undefined &&
      last.authorId === message.authorId &&
      prev.type === message.type &&
      Math.abs(currDate - prevDate) < GROUP_WINDOW_MS;
    if (last !== undefined && sameAuthor) {
      last.messages.push(message);
      last.key = `${last.key}+${message.id}`;
    } else {
      groups.push({
        key: message.id,
        authorId: message.authorId,
        authorName: message.authorName,
        isMine: currentUid !== null && message.authorId === currentUid,
        messages: [message],
      });
    }
  }
  return groups;
}
