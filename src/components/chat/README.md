# Chat (T13–T18)

Pantalla de conversación estilo Grok con datos reales de Firestore, más el
feed de Publicaciones unido al chat y el chat privado con Loki IA.

## Componentes (`src/components/chat/`)

| Componente | Archivo | Uso |
|---|---|---|
| `ChatList` | `chat-list.tsx` | Loki IA fijado + tarjeta Publicaciones + conversaciones reales de `useChats` (preview `Autor: texto`, hora corta). `EmptyState` si no hay chats. El color del avatar del chat sale de `avatarColorFor(chat.id)`. Desde T17 la tarjeta Publicaciones muestra el preview real del `lastMessage` del chat `posts` (y su hora) cuando existe. |
| `ConversationView` | `conversation-view.tsx` | `useMessages` + `useSendMessage` (en `loki-ia`, `useAiMessages` + `useSendAiMessage`/`useSendAiAssistantMessage`, ver T18). Scroll al final sin animación, auto-scroll <120px, pastilla de nuevos, paginación con `IntersectionObserver` conservando posición. Desde T16 es también el dueño del estado de interacción: cita (`replyTo`), edición en curso, hilo abierto y avisos de "Mensaje copiado". |
| `MessageList` | `message-list.tsx` | `role=log` + `aria-live=polite`. Agrupa por autor (<5 min), separa por día, anima solo ids nuevos con el spring único. Pasa a cada `MessageItem` los seis callbacks de T16 (reacción, respuesta, hilo, copiar, editar, eliminar). |
| `MessageItem` | `message-item.tsx` | Burbuja interactiva: long-press 500ms (táctil) o hover (ratón) → `ReactionBar`; botón `...` en hover y click derecho → `MessageContextMenu`. Debajo: cita `replyTo`, chips de reacciones y botón `N respuestas`. Exporta desde aquí las clases de ancho (`MESSAGE_ROW_CLASS`, `MESSAGE_BUBBLE_FIT_CLASS`). |
| `MessageBubble` | `message-bubble.tsx` | Propios `#0F0F0F`/`#2A2A2A`, otros `#F0F0F0`/`#16181C`, radio 22px, 15px/1.45, `break-words`. IA sin burbuja (`Loki` + Sparkles, en `AiReply` con el streaming de T18), system centrado, eliminado en itálica. Avatar 28px en el último del grupo, hora `HH:mm` bajo el grupo y `· (editado)` si `editedAt`. Color de avatar por `useAuthorAvatarColor`. Desde T17 acepta `variant="post"`: fila plana del feed (avatar 40 + nombre + tiempo relativo), sin burbuja. |
| `ReactionBar` | `reaction-bar.tsx` | `MenuCard` flotante con 6 emojis rápidos + `+` que abre el grid de 24 (`EXTENDED_REACTIONS`). `role=toolbar`, `aria-label="Reaccionar con X"` por emoji, Escape/click afuera cierran. |
| `ReactionChips` | `reaction-chips.tsx` | Chips bajo la burbuja (emoji + contador, ordenados por cantidad). El propio lleva `aria-pressed` y borde accent; tocarlo alterna el uid propio. |
| `MessageContextMenu` | `message-context-menu.tsx` | `role=menu` con Responder, Responder en hilo, Copiar, Editar y Eliminar (las dos últimas solo del autor). Eliminar pide confirmación en línea "Eliminar mensaje?" (Cancelar/Eliminar). |
| `ThreadPanel` | `thread-panel.tsx` | Hilo en portal a `document.body`: drawer derecho de 420px en escritorio (scrim included) y bottom sheet casi a pantalla completa en móvil. Padre + `useThread` en vivo + `Composer` que envía con `threadParentId`. Desde T17 acepta `title`/`parentLabel` (Publicaciones lo abre como "Comentarios" sobre "Publicación"). |
| `PostsView` | `posts-view.tsx` | `/chat/publicaciones`: composer arriba (sticky bajo el header, columna de 760px), feed y estado vacío. `usePosts` + `usePublishPost`; errores y reintento con el mismo id de cliente. |
| `PostRow` | `post-row.tsx` | Fila plana estilo X separada por `border-divider`: `MessageBubble variant="post"` + acciones Me gusta (Heart relleno/`text-danger`/`aria-pressed` con contador) y Comentar (MessageCircle + `threadCount`). Exporta `usePostClock`, un único reloj para todos los tiempos relativos. |
| `DaySeparator` | `day-separator.tsx` | `Hoy` / `Ayer` / `lunes 21 de septiembre`, 13px muted. |
| `Composer` | `composer.tsx` | Botón `+` 44px + pastilla con textarea 1–6 líneas, mic deshabilitado, enviar 36px solo con texto (spring). Enter envía solo con puntero fino; `visualViewport` + `safe-area` para el teclado. Desde T16 también acepta `replyTo` (barra de cita con X), `edit` (precarga el texto y Enter guarda) y `placeholder`. Desde T17 `mode="post"` lo convierte en el composer superior del feed. |
| `AttachMenu` | `attach-menu.tsx` | `MenuCard` con 3 opciones deshabilitadas + aviso `Los adjuntos llegan pronto`. Cierra con click afuera o Escape. `+` rota a ×. |
| `NewMessagesPill` | `new-messages-pill.tsx` | Pastilla flotante `Nuevos mensajes` + flecha, baja con scroll suave. |
| `TypingIndicator` | `typing-indicator.tsx` | `X está escribiendo…` / `X e Y están…` / `Varias personas…` debajo de los mensajes (`aria-live=polite`). Nada si nadie escribe. |

## Publicaciones (T17)

Feed estilo X unido al chat: los posts son mensajes `type: "post"` con `threadParentId: null` del chat `posts` del espacio (id fijo, creado en el mismo batch que `general`; `ensurePostsChat` lo crea si el espacio es anterior a T17). Los comentarios son respuestas de hilo normales.

- `src/lib/chat/posts.ts` (puro): `POSTS_CHAT_ID`/nombre/emoji, `POST_LIKE_EMOJI` (corazón rojo U+2764 U+FE0F), textos de la pantalla, `formatPostTime` ("ahora" / "5 min" / "2 h" / "ayer" / fecha) y los helpers `isPostMessage`, `postLikeCount`, `hasPostLike`, `postCommentCount`.
- `PostsView` + `PostRow`: `usePosts` (misma query que el timeline: `threadParentId == null` + `createdAt` desc, así que reutiliza el índice existente) y `usePublishPost` con envío optimista e idempotente (`ensurePostsChat` → `sendMessage` type `post`). Publicar actualiza `lastMessage` del chat; comentar solo sube `threadCount`.
- Un post **no** es una burbuja: `MessageBubble` acepta `variant="post"` (fila plana con avatar `avatarColorFor(uid)`, nombre semibold, tiempo relativo muted) y las acciones viven en `PostRow`: Me gusta (Heart relleno + `text-danger` + `aria-pressed` cuando el uid propio ya reaccionó, contador al lado, alterna con `toggleReaction`) y Comentar (MessageCircle + `threadCount`, abre el `ThreadPanel` con título "Comentarios").
- `Composer` acepta `mode="post"`: mismo autogrow y Enter con puntero fino, pero botón de imagen deshabilitado "Próximamente", botón "Publicar" (deshabilitado sin texto) y sin menú de menciones. Va arriba, `sticky` bajo el header y centrado en la columna de 760px; en la lista de chats la tarjeta Publicaciones muestra el preview real del `lastMessage` del chat `posts`.
- **Alta del chat antes de escuchar**: `usePosts` llama a `ensurePostsChat` y solo después se suscribe a `listenPosts` (`use-chat.ts`). En un espacio anterior a T17 el doc no existe y la consulta moría con `permission-denied` (`canAccessChat` sobre un doc inexistente), así que los posts de otros nunca llegaban en vivo hasta recargar. `listenPosts` recibe `onError`: con `permission-denied` **no** se muestra error (el feed queda en su estado vacío) y se reintenta 3 veces cada 4 s volviendo a asegurar el chat; el esqueleto solo aparece hasta el primer snapshot y los snapshots entran con `mergeUnique` (desc), para que un post optimista o con error de envío no desaparezca por un snapshot ajeno.
- **Móvil**: `MobileHeader` detecta `/chat/publicaciones` y pinta la misma cabecera que una conversación (volver a `/chat`, pastilla con el emoji 📰 y "Publicaciones", botón de detalles), en vez del selector de espacio. En escritorio no cambia nada.
- **Acentos**: los literales de `posts.ts` van con tilde y signos correctos (`¿Qué quieres compartir?`, `Publicación`, `Próximamente`, `Todavía no hay publicaciones…`); en el panel de comentarios el contador dice `1 comentario` / `N comentarios` y el vacío `Sin comentarios todavía.` (el hilo normal sigue con "respuesta(s)").

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
- `posts.ts` (T17): id/nombre/emoji del chat `posts`, `POST_LIKE_EMOJI`, textos de la pantalla, `formatPostTime` y los helpers de like/comentarios.
- `reactions.ts`: `QUICK_REACTIONS` (6) y `EXTENDED_REACTIONS` (24) como {emoji, nombre accesible, codepoints} construidos con `String.fromCodePoint` (sin emojis pegados a mano en el código).
- `mentions.ts`: `getMentionQuery`, `filterMentionCandidates`, `resolveMentionIds`, `parseMentionSegments`, `mentionsLoki`, `isAiEnabled`, `buildLokiDisabledMessage` (puras, testeables con Node sin runner).
- `preview.ts` (T18): `updatesChatPreview(type)` — qué mensajes pueden tocar `lastMessage`/`updatedAt` del chat (los del preview de la lista). `type "system"` NO.
- `ai-mock.ts` (T18): `AI_CHAT_ID`/`AI_CHAT_NAME`/`AI_AUTHOR_ID`, `AI_SUGGESTIONS` (los tres chips), `AI_PLACEHOLDER`, `AI_EMPTY_TITLE`/`AI_EMPTY_DESCRIPTION`, `AI_CONNECTING_TEXT`, `AI_MOCK_PREFIX`, `AI_STREAM_INTERVAL_MS`, `streamChunks` y `buildMockAiReply`. Sin React ni firebase: solo literales de UI y la respuesta MOCK.

## Menciones (T15)

- **Composer**: `@` abre un `MenuCard` flotante con la entrada fija `@Loki`/`@ai` (id `loki`) + miembros del espacio (`useMembers` → `listMembers`/`listenMembers` en `src/lib/data/chat.ts`). Filtra por el texto tras `@` (sin tildes, insensible a mayúsculas). Flechas + Enter / click insertan `@Nombre` (el uid se resuelve en `mentions[]` al enviar con `resolveMentionIds`). Escape cierra; sin resultados se cierra.
- **MessageBubble**: `parseMentionSegments` resalta menciones conocidas (match `@Nombre` o lookup por `mentions[]`) con `text-mention` (#1D9BF0), `font-semibold`, sin subrayado. El texto plano sigue igual.
- **Flag `NEXT_PUBLIC_AI_ENABLED`** (default `false` en `.env.example`): si el mensaje menciona `loki`/`ai` y el flag no es `"true"`, tras el mensaje del usuario se escribe seguido un aviso type `system` con el `authorId` del propio usuario, texto `Loki está desactivada. Actívala en Configuración → Loki IA.` y `mentions: ["loki-disabled"]`. Es lo único escribible por el cliente en los chats de espacio (las reglas prohíben type `ai` ahí y exigen `authorId == uid`).
- **El aviso es SUTIL y CENTRADO**: `MessageBubble` lo pinta como mensaje de sistema (texto 13px muted, centrado, sin burbuja) en medio del timeline. No hay toast ni banner. La marca `loki-disabled` no cuenta como mención real en `parseMentionSegments`, así que el aviso no arrastra a resaltar nada.
- **El aviso NO toca el doc del chat** (T18): `sendMessage` solo actualiza `lastMessage`/`updatedAt` si `updatesChatPreview(type)` (`src/lib/chat/preview.ts`), y `type "system"` queda fuera. El batch es entonces solo el `set` del mensaje, así que la lista de chats sigue enseñando el último mensaje real del usuario ("Manu Oliva: oye @Loki ¿Qué tengo hoy?") en vez de "Loki está desactivada…". No hace falta tocar `firestore.rules`: crear el mensaje `system` con `authorId == uid` ya estaba permitido sin actualizar el chat.
- **T18**: con Cloud Functions + Admin SDK (`functions/`, apagado en fase 1-2) el backend escribirá la respuesta real con type `ai`. Si el flag es `"true"`, el cliente no inventa ninguna respuesta.

## Loki IA (T18)

`/chat/loki-ia` es un chat real contra `users/{uid}/aiChats/loki-ia/messages` (no hay mocks en memoria desde T18). `ConversationView` detecta el chat con `AI_CHAT_ID` y cambia de origen de datos: `useAiMessages` en vez de `useMessages`, y sin typing, paging, reacciones ni hilos (todo eso es de los chats de espacio).

- **Estilo**: la respuesta de la IA va **sin burbuja** y a ancho completo, con `Loki` + icono `Sparkles` (ya estaba desde T13); los mensajes del usuario conservan su burbuja de T13/T16. `MessageBubble` la delega en `AiReply`.
- **Estado vacío + chips**: sin mensajes, `EmptyState` (`Sparkles`, "Habla con Loki") y debajo los tres chips de `AI_SUGGESTIONS` — `¿Qué tengo hoy?`, `Resume mi semana`, `Crea un recordatorio`. Al tocar uno, `AiSuggestions` llama a `onPick` y el texto se envía **como mensaje del usuario** por el mismo camino que escribirlo y pulsar Enter (`handleSend(text, [])`).
- **IA apagada** (`NEXT_PUBLIC_AI_ENABLED !== "true"`, el default): tras el mensaje del usuario, `sendAiReply` escribe una respuesta MOCK con `sendAiAssistantMessage` (`type: "ai"` en `users/{uid}/aiChats/...`, que las reglas ya permiten al propio usuario). El texto empieza por `[Simulado] ` y es contextual pero **no inventa datos** (`buildMockAiReply`): si le pides la agenda, dice que no lee tu calendario.
- **Streaming simulado**: `useAiReveal` (`src/hooks/`) revela el texto palabra a palabra cada `AI_STREAM_INTERVAL_MS` (30 ms), con un cursor `accent` mientras corre. El documento de Firestore siempre guarda el texto completo; lo parcial es solo lo que se ve. Los ids ya revelados se recuerdan a nivel de módulo, así que al volver a la pantalla el texto sale entero.
- **IA encendida**: la UI muestra `Conectando con Loki…` (`AiConnecting`, con Sparkles) y **no inventa nada**; queda el `TODO(T18-siguiente)` en `conversation-view.tsx` para invocar la callable `aiChat` de `functions/`, que todavía no se llama desde el cliente.
- **Móvil**: `ConversationView` y `MobileHeader` usan `AI_CHAT_ID`/`AI_CHAT_NAME` en vez de literales sueltos, así que la cabecera y la lista de chats no se desincronizan del id de Firestore.
- `Configuración → Loki IA` muestra el estado real del flag ("Activada" / "Desactivada") con una nota de qué pasa mientras está apagada. Es de solo lectura: la clave y el proveedor viven en el backend, no en el cliente.

| Componente | Archivo | Uso |
|---|---|---|
| `AiSuggestions` | `ai-suggestions.tsx` | Los tres chips de arranque, solo con el chat vacío. `onPick(text)` envía el texto como mensaje del usuario. |
| `AiConnecting` | `ai-connecting.tsx` | Línea "Conectando con Loki…" (Sparkles + muted) con `NEXT_PUBLIC_AI_ENABLED=true`. |

### Unitarios (T18)

`tests/ai-mock.test.mjs` (`npm run test:ai-mock`) cubre `ai-mock.ts` sin runner ni firebase: los tres chips con su texto exacto, `Conectando con Loki…`, el prefijo `[Simulado] ` en las seis variantes del mock, que el texto no invente datos ("tienes N tareas"), que las partes del streaming rearmen el original y el aviso de `mentions.ts` con su texto exacto.

`tests/preview.test.mjs` (`npm run test:preview`) cubre `preview.ts`: que `user`/`post`/`ai` (y el default sin `type`) actualicen el preview del chat y que **`system` no** lo haga, aplicado al aviso real de `buildLokiDisabledMessage`. Los tres corren en `npm run test:unit`.

## Movimiento

Todo `motion.*` usa el spring único de `src/lib/motion.ts` y respeta `prefers-reduced-motion` (`useReducedMotion` + `matchMedia` en scroll).
