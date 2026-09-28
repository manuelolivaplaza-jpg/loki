# Chat (T13)

Pantalla de conversación estilo Grok con datos reales de Firestore.

## Componentes (`src/components/chat/`)

| Componente | Archivo | Uso |
|---|---|---|
| `ChatList` | `chat-list.tsx` | Loki IA fijado + tarjeta Publicaciones + conversaciones reales de `useChats` (preview `Autor: texto`, hora corta). `EmptyState` si no hay chats. Exporta `colorForChat` (color por hash, paleta de `models`). |
| `ConversationView` | `conversation-view.tsx` | `useMessages` + `useSendMessage` (o mocks locales en `loki-ia`). Scroll al final sin animación, auto-scroll <120px, pastilla de nuevos, paginación con `IntersectionObserver` conservando posición. |
| `MessageList` | `message-list.tsx` | `role=log` + `aria-live=polite`. Agrupa por autor (<5 min), separa por día, anima solo ids nuevos con el spring único. |
| `MessageBubble` | `message-bubble.tsx` | Propios `#0F0F0F`/`#2A2A2A`, otros `#F0F0F0`/`#16181C`, radio 22px, 15px/1.45, máx 78%. IA sin burbuja (`Loki` + Sparkles), system centrado, eliminado en itálica. Avatar 28px en el último del grupo, hora `HH:mm` bajo el grupo. |
| `DaySeparator` | `day-separator.tsx` | `Hoy` / `Ayer` / `lunes 21 de septiembre`, 13px muted. |
| `Composer` | `composer.tsx` | Botón `+` 44px + pastilla con textarea 1–6 líneas, mic deshabilitado, enviar 36px solo con texto (spring). Enter envía solo con puntero fino; `visualViewport` + `safe-area` para el teclado. |
| `AttachMenu` | `attach-menu.tsx` | `MenuCard` con 3 opciones deshabilitadas + aviso `Los adjuntos llegan pronto`. Cierra con click afuera o Escape. `+` rota a ×. |
| `NewMessagesPill` | `new-messages-pill.tsx` | Pastilla flotante `Nuevos mensajes` + flecha, baja con scroll suave. |

## Utilidades (`src/lib/chat/format.ts`)

`formatHour`, `formatDayLabel`, `formatChatTime`, `dayKey`, `groupMessages` (ventana 5 min).

## Movimiento

Todo `motion.*` usa el spring único de `src/lib/motion.ts` y respeta `prefers-reduced-motion` (`useReducedMotion` + `matchMedia` en scroll).
