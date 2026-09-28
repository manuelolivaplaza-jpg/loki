// TODO(fase-2): reemplazar estos datos de ejemplo por conversaciones reales de Firestore.

export type ChatPreview = {
  id: string;
  name: string;
  preview: string;
  time: string;
  unread: boolean;
  color: string;
};

export const EXAMPLE_CHATS: readonly ChatPreview[] = [
  { id: "familia", name: "Familia", preview: "Mamá: ¿a qué hora llegan mañana?", time: "9:41", unread: true, color: "#00b4d8" },
  { id: "equipo-diseno", name: "Equipo diseño", preview: "Lucía: subí la propuesta nueva", time: "8:15", unread: true, color: "#1d9bf0" },
  { id: "martin", name: "Martín", preview: "Te paso el archivo esta tarde", time: "Ayer", unread: false, color: "#00ba7c" },
  { id: "club-lectura", name: "Club de lectura", preview: "Ana: el capítulo 4 es el mejor", time: "Ayer", unread: false, color: "#6d5fc0" },
  { id: "sofia", name: "Sofía", preview: "Jajaja, tal cual", time: "Lun", unread: false, color: "#ffad1f" },
  { id: "vecinos", name: "Vecinos 3B", preview: "Reunión el jueves a las 19 h", time: "Lun", unread: true, color: "#f4212e" },
  { id: "diego", name: "Diego", preview: "¿Jugamos el sábado?", time: "Dom", unread: false, color: "#536471" },
  { id: "trabajo", name: "Trabajo", preview: "Deploy listo para revisar", time: "Dom", unread: false, color: "#0f1419" },
];

/** Chat personal con IA, fijado arriba de la lista de chats. */
export const LOKI_IA_CHAT: ChatPreview = {
  id: "loki-ia",
  name: "Loki IA",
  preview: "Tu asistente personal, siempre disponible",
  time: "Ahora",
  unread: false,
  color: "#0f1419",
};

export function getChatById(id: string): ChatPreview | null {
  if (id === LOKI_IA_CHAT.id) return LOKI_IA_CHAT;
  return EXAMPLE_CHATS.find((chat) => chat.id === id) ?? null;
}

/** Subrutas de /chat que son listas, no conversaciones. */
const CHAT_LIST_ROUTES: readonly string[] = ["publicaciones"];

export function getChatIdFromPath(pathname: string | null): string | null {
  if (!pathname) return null;
  if (!pathname.startsWith("/chat/") || pathname === "/chat/") return null;
  const segment = pathname.slice("/chat/".length).split("/")[0] ?? "";
  if (segment === "" || CHAT_LIST_ROUTES.includes(segment)) return null;
  return segment;
}

export type ChatMessage = {
  id: string;
  from: "me" | "other";
  text: string;
};

// TODO(fase-2): burbujas de ejemplo; traer mensajes reales de Firestore.
export const EXAMPLE_MESSAGES: readonly ChatMessage[] = [
  { id: "m1", from: "other", text: "¿Viste la propuesta que subí ayer?" },
  { id: "m2", from: "me", text: "Sí, la estuve mirando. Me gusta la dirección." },
  { id: "m3", from: "other", text: "Genial, entonces la dejamos así y seguimos mañana" },
  { id: "m4", from: "me", text: "Dale, mañana lo revisamos con calma" },
];

/** Mensajes de ejemplo de la conversación con Loki IA. */
export const LOKI_IA_MESSAGES: readonly ChatMessage[] = [
  { id: "l1", from: "other", text: "Hola, soy Loki IA. ¿En qué te ayudo hoy?" },
  { id: "l2", from: "me", text: "Resúmeme el día del espacio" },
  { id: "l3", from: "other", text: "Tienes 3 tareas pendientes y 2 eventos esta semana. ¿Empezamos por lo urgente?" },
];
