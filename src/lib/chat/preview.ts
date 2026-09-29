/**
 * Preview de la lista de chats (T18): qué mensajes pueden actualizar
 * `lastMessage` / `updatedAt` del doc del chat.
 *
 * Regla: solo un mensaje REAL del timeline cambia el preview. Un
 * `type: "system"` NO: el caso real es el aviso de IA desactivada
 * ("Loki está desactivada. Actívala en Configuración → Loki IA.",
 * `mentions: ["loki-disabled"]`), que escribe el propio usuario desde
 * `conversation-view.tsx`. Si tocara el doc del chat, la lista mostraría
 * "Manu Oliva: Loki está d…" como último mensaje de General y dejaría de
 * enseñar el último mensaje real ("Manu Oliva: oye @Loki ¿Qué tengo hoy?").
 *
 * El aviso se sigue viendo en el timeline (lo inserta el envío optimista y
 * luego el snapshot en vivo); lo único que se salta es el doc del chat.
 *
 * Puro (sin React ni firebase) para poder importarlo desde `tests/` con Node
 * sin runner ni compilar, igual que `mentions.ts`.
 */

import type { MessageType } from "@/types/chat";

/** Tipos que SÍ actualizan el preview del chat. */
const PREVIEW_TYPES: readonly MessageType[] = ["user", "ai", "post"];

/**
 * True si un mensaje de este tipo actualiza `lastMessage` / `updatedAt` del
 * chat. `undefined` se resuelve como `"user"`, el default de `sendMessage`.
 *
 * "system" queda fuera a propósito (ver el encabezado). "ai" sí está: en los
 * chats de espacio lo escribe el backend con Admin SDK
 * (`functions/src/onMention.ts`) y su respuesta debe salir en la lista.
 */
export function updatesChatPreview(type?: MessageType): boolean {
  return PREVIEW_TYPES.includes(type ?? "user");
}
