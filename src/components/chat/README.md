# Chat (T13–T16)

Pantalla de conversación estilo Grok con datos reales de Firestore.

## Componentes (`src/components/chat/`)

| Componente | Archivo | Uso |
|---|---|---|
| `ChatList` | `chat-list.tsx` | Loki IA fijado + tarjeta Publicaciones + conversaciones reales de `useChats` (preview `Autor: texto`, hora corta). `EmptyState` si no hay chats. El color del avatar del chat sale de `avatarColorFor(chat.id)`. |
| `ConversationView` | `conversation-view.tsx` | `useMessages` + `useSendMessage` (o mocks locales en `loki-ia`). Scroll al final sin animación, auto-scroll <120px, pastilla de nuevos, paginación con `IntersectionObserver` conservando posición. Desde T16 es también el dueño del estado de interacción: cita (`replyTo`), edición en curso, hilo abierto y avisos de "Mensaje copiado". |
| `MessageList` | `message-list.tsx` | `role=log` + `aria-live=polite`. Agrupa por autor (<5 min), separa por día, anima solo ids nuevos con el spring único. Pasa a cada `MessageItem` los seis callbacks de T16 (reacción, respuesta, hilo, copiar, editar, eliminar). |
| `MessageItem` | `message-item.tsx` | Burbuja interactiva: long-press 500ms (táctil) o hover (ratón) → `ReactionBar`; botón `...` en hover y click derecho → `MessageContextMenu`. Debajo: cita `replyTo`, chips de reacciones y botón `N respuestas`. Exporta desde aquí las clases de ancho (`MESSAGE_ROW_CLASS`, `MESSAGE_BUBBLE_FIT_CLASS`). |
| `MessageBubble` | `message-bubble.tsx` | Propios `#0F0F0F`/`#2A2A2A`, otros `#F0F0F0`/`#16181C`, radio 22px, 15px/1.45, `break-words`. IA sin burbuja (`Loki` + Sparkles), system centrado, eliminado en itálica. Avatar 28px en el último del grupo, hora `HH:mm` bajo el grupo y `· (editado)` si `editedAt`. Color de avatar por `useAuthorAvatarColor`. |
| `ReactionBar` | `reaction-bar.tsx` | `MenuCard` flotante con 6 emojis rápidos + `+` que abre el grid de 24 (`EXTENDED_REACTIONS`). `role=toolbar`, `aria-label="Reaccionar con X"` por emoji, Escape/click afuera cierran. |
| `ReactionChips` | `reaction-chips.tsx` | Chips bajo la burbuja (emoji + contador, ordenados por cantidad). El propio lleva `aria-pressed` y borde accent; tocarlo alterna el uid propio. |
| `MessageContextMenu` | `message-context-menu.tsx` | `role=menu` con Responder, Responder en hilo, Copiar, Editar y Eliminar (las dos últimas solo del autor). Eliminar pide confirmación en línea "Eliminar mensaje?" (Cancelar/Eliminar). |
| `ThreadPanel` | `thread-panel.tsx` | Hilo en portal a `document.body`: drawer derecho de 420px en escritorio (scrim included) y bottom sheet casi a pantalla completa en móvil. Padre + `useThread` en vivo + `Composer` que envía con `threadParentId`. |
| `DaySeparator` | `day-separator.tsx` | `Hoy` / `Ayer` / `lunes 21 de septiembre`, 13px muted. |
| `Composer` | `composer.tsx` | Botón `+` 44px + pastilla con textarea 1–6 líneas, mic deshabilitado, enviar 36px solo con texto (spring). Enter envía solo con puntero fino; `visualViewport` + `safe-area` para el teclado. Desde T16 también acepta `replyTo` (barra de cita con X), `edit` (precarga el texto y Enter guarda) y `placeholder`. |
| `AttachMenu` | `attach-menu.tsx` | `MenuCard` con 3 opciones deshabilitadas + aviso `Los adjuntos llegan pronto`. Cierra con click afuera o Escape. `+` rota a ×. |
| `NewMessagesPill` | `new-messages-pill.tsx` | Pastilla flotante `Nuevos mensajes` + flecha, baja con scroll suave. |
| `TypingIndicator` | `typing-indicator.tsx` | `X está escribiendo…` / `X e Y están…` / `Varias personas…` debajo de los mensajes (`aria-live=polite`). Nada si nadie escribe. |

## Interacción por mensaje (T16)

- **Reacciones**: long-press 500ms en táctil o hover con ratón sobre la burbuja → barra flotante (6 rápidos + `+` con el grid de 24). Elegir un emoji llama a `toggleReaction`, que solo alterna **mi** uid en `reactions.<emoji>` (única escritura que permiten las reglas). Los chips de debajo repiten la acción: `aria-pressed` marca el propio y el borde accent lo distingue.
- **Responder**: el menú pone una barra de cita sobre el composer (autor + texto truncado + X) y el mensaje enviado guarda `replyTo {id, authorName, text}`. En el timeline la cita se ve encima de la burbuja (borde accent).
- **Editar** (solo autor): el composer precarga el texto; Enter (o el botón enviar) llama a `editMessage` con el texto y sus menciones, y la burbuja muestra `· (editado)` en la línea de la hora.
- **Eliminar** (solo autor): `deleteMessage` (borrado suave) y la burbuja pasa a `Mensaje eliminado` en itálica con borde `divider` y sin relleno; sin interacciones ni chips.
- **Copiar**: `navigator.clipboard.writeText` y un aviso `Mensaje copiado` de 1,8 s (`role=status`) sobre el composer.
- **Hilos**: `Responder en hilo` o el botón `N respuestas` abren el `ThreadPanel` con el mensaje padre. Las respuestas se escriben con `sendMessage({threadParentId})` (no con el envío optimista de `useSendMessage`, que insertaría en la caché del timeline) y llegan por `useThread`/`listenThread`. **No aparecen nunca en el timeline principal**: sus consultas filtran `threadParentId == null`.

### Correcciones de T16 (intento 2, verificadas con Playwright)

- **Hover**: el reset de menús/reacciones de `MessageItem` compara el id con un `useRef` (`prevMessageIdRef`), así que ya no corre al montar; el **primer** `pointerenter` con ratón abre la `ReactionBar` (antes había que salir y volver a entrar).
- **Ancho**: los wrappers de cada mensaje en `MessageList` (`<div className="w-full">` y el `motion.div`) llevan `w-full`; con `items-end` se encogían al contenido y el `max-w-[78%]` se resolvía contra ese ancho intrínseco, partiendo los mensajes cortos en 2 líneas a 1440px.
- **Mensaje eliminado**: sin fondo sólido, borde 1px `border-divider`, itálica `text-muted-foreground`, mismo radio 22px, alineado según el autor y sin reacciones ni menú (los tokens ya cubren claro y oscuro).
- **Preview del chat**: `sendMessage` con `threadParentId !== null` ya no actualiza el doc del chat (ni `lastMessage` ni `updatedAt`): solo `threadCount + 1` y `lastReplyAt` en el padre. El batch sigue cumpliendo `firestore.rules` (create del mensaje + update del padre con +1 exacto), así que las reglas no cambiaron.

## Avatares deterministas (T16)

`src/lib/avatar-color.ts` (puro) + `src/hooks/use-avatar-color.ts`:

- `AVATAR_COLOR_PALETTE` son 8 colores sobrios (`#5B8DEF`, `#E07A5F`, `#3D9970`, `#9B72CF`, `#D4A017`, `#2A9D8F`, `#C2185B`, `#6C757D`).
- `avatarColorFor(id)` = hash estable (djb2 de 32 bits) del id → índice de la paleta. La misma persona (o el mismo chat) tiene siempre el mismo color sin guardar nada en Firestore.
- `useAuthorAvatarColor(uid)` devuelve el color de mi perfil si la persona soy yo y el perfil ya está cargado; si no, el determinista.
- Se usa en burbujas, panel de hilo, menú de menciones del composer, avatares de la lista de chats, cabecera móvil y panel de miembros del panel contextual, en lugar de `AVATAR_FALLBACK_COLOR`.
- `avatarTextColor` (en `src/types/models.ts`) suma los tonos claros de la paleta al grupo que necesita texto `#0F1419` (con blanco quedaban entre 2.4:1 y 3.7:1; con texto oscuro suben a 4.8:1-7.5:1).

## Ancho de la burbuja

`MESSAGE_ROW_CLASS` (`relative flex w-full`) da a la fila el ancho **de la columna** y `MESSAGE_BUBBLE_FIT_CLASS` (`long-press relative w-fit max-w-[78%]`) deja que la burbuja crezca con su contenido hasta el 78%.

El orden importa: si el contenedor de la burbuja encoge al contenido (`items-end` en una columna flex), su `max-width` en porcentaje se resuelve contra ese ancho intrínseco y los textos cortos se parten muy pronto (≈55% del ancho en 390px). Por eso **toda** la cadena de ancestros hasta la burbuja es `w-full` (wrapper del mensaje en `MessageList` incluido, propio y animado) y la burbuja usa `w-fit max-w-[78%]` con `break-words` (nunca `break-all`), y `min-w-0` solo en la burbuja de los otros (para que una palabra larga pueda partirse).

## Tiempo real (T14)

- **Envío optimista**: `useSendMessage` inserta el mensaje con id de cliente (`newMessageId`) y `createdAt` provisional en la caché de TanStack Query; el snapshot lo reemplaza al confirmar. Estado local en `src/lib/chat/message-status.ts` (`sending`/`error`); en error la burbuja muestra `No se pudo enviar · Reintentar` y reintenta con el mismo id.
- **Typing**: `typing/{uid}` (`displayName`, `updatedAt`) con throttle 800ms (`useNotifyTyping`); se borra al vaciar, enviar o desmontar. `useTyping` filtra `updatedAt < 4s` (sin mí) y revalida cada segundo. El composer del hilo publica su typing con el mismo hook.
- **Leídos**: `reads/{uid}` (`lastReadAt`, `lastReadMessageId`); se marca al abrir y al llegar al fondo (`useMarkChatRead`). La lista muestra punto azul + contador (`useUnread`: `lastMessage.createdAt > lastReadAt` y autor ajeno).

## Utilidades (`src/lib/chat/`)

- `format.ts`: `formatHour`, `formatDayLabel`, `formatChatTime`, `dayKey`, `groupMessages` (ventana 5 min).
- `reactions.ts`: `QUICK_REACTIONS` (6) y `EXTENDED_REACTIONS` (24) como {emoji, nombre accesible, codepoints} construidos con `String.fromCodePoint` (sin emojis pegados a mano en el código).
- `mentions.ts`: `getMentionQuery`, `filterMentionCandidates`, `resolveMentionIds`, `parseMentionSegments`, `mentionsLoki`, `isAiEnabled`, `buildLokiDisabledMessage` (puras, testeables con Node sin runner).

## Menciones (T15)

- **Composer**: `@` abre un `MenuCard` flotante con la entrada fija `@Loki`/`@ai` (id `loki`) + miembros del espacio (`useMembers` → `listMembers`/`listenMembers` en `src/lib/data/chat.ts`). Filtra por el texto tras `@` (sin tildes, insensible a mayúsculas). Flechas + Enter / click insertan `@Nombre` (el uid se resuelve en `mentions[]` al enviar con `resolveMentionIds`). Escape cierra; sin resultados se cierra.
- **MessageBubble**: `parseMentionSegments` resalta menciones conocidas (match `@Nombre` o lookup por `mentions[]`) con `text-mention` (#1D9BF0), `font-semibold`, sin subrayado. El texto plano sigue igual.
- **Flag `NEXT_PUBLIC_AI_ENABLED`** (default `false` en `.env.example`): si el mensaje menciona `loki`/`ai` y el flag no es `"true"`, tras el mensaje del usuario se escribe seguido un aviso type `system` con el `authorId` del propio usuario, texto `Loki: Loki esta desactivada hasta activar el plan Blaze.` y `mentions: ["loki-disabled"]`. Es lo único compatible con las reglas actuales (prohíben type `ai` desde el cliente y exigen `authorId == uid`) y con export sin Admin SDK.
- **TODO(T18)**: con Cloud Functions + Admin SDK el backend escribirá la respuesta real con type `ai`. Si el flag es `"true"`, el cliente no inventa ninguna respuesta.

## Movimiento

Todo `motion.*` usa el spring único de `src/lib/motion.ts` y respeta `prefers-reduced-motion` (`useReducedMotion` + `matchMedia` en scroll).
