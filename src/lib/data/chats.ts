import { AI_CHAT_ID, AI_CHAT_NAME } from "@/lib/chat/ai-mock";
import { normalizePathname } from "@/lib/navigation";

export type ChatPreview = {
  id: string;
  name: string;
  preview: string;
  time: string;
  unread: boolean;
  color: string;
};

/** Chat personal con IA, fijado arriba de la lista de chats. */
export const LOKI_IA_CHAT: ChatPreview = {
  id: AI_CHAT_ID,
  name: AI_CHAT_NAME,
  preview: "Tu asistente personal, siempre disponible",
  time: "Ahora",
  unread: false,
  color: "#0f1419",
};

/** Subrutas de /chat que son listas, no conversaciones. */
const CHAT_LIST_ROUTES: readonly string[] = ["publicaciones", "c"];

export function getChatIdFromPath(pathname: string | null): string | null {
  const normalized = normalizePathname(pathname);
  if (!normalized) return null;
  if (normalized === `/chat/${AI_CHAT_ID}`) return AI_CHAT_ID;
  if (!normalized.startsWith("/chat/") || normalized === "/chat/") return null;
  const segment = normalized.slice("/chat/".length).split("/")[0] ?? "";
  if (segment === "" || CHAT_LIST_ROUTES.includes(segment)) return null;
  return segment;
}

/** Resuelve el id de conversación con pathname + query (?id=) de /chat/c. */
export function getConversationId(
  pathname: string | null,
  queryId: string | null,
): string | null {
  const normalized = normalizePathname(pathname);
  if (normalized === `/chat/${AI_CHAT_ID}`) return AI_CHAT_ID;
  if (normalized === "/chat/c") {
    if (queryId === null || queryId === "") return null;
    if (CHAT_LIST_ROUTES.includes(queryId)) return null;
    return queryId;
  }
  return getChatIdFromPath(normalized);
}

