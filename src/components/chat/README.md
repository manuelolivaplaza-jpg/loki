# Chat (Supabase)

Pantalla de conversación estilo Grok con datos reales de Supabase (Postgres +
RLS + Realtime), más el feed de Publicaciones unido al chat y el chat privado
con Loki IA (Edge Function `loki-chat` con streaming real).

## Componentes (`src/components/chat/`)

| Componente | Archivo | Uso |
|---|---|---|
| `ChatList` | `chat-list.tsx` | Loki IA fijado + tarjeta Publicaciones + conversaciones reales de `useChats` (preview `Autor: texto`, hora corta). `EmptyState` si no hay chats. El color del avatar del chat sale de `avatarColorFor(chat.id)`. Desde T17 la tarjeta Publicaciones muestra el preview real del `lastMessage` del chat `posts` (y su hora) cuando existe. |
| `ConversationView` | `conversation-view.tsx` | `useMessages` + `useSendMessage` (en `loki-ia`, `useAiMessages` + `useSendAiMessage` y el stream de la Edge Function, ver Loki IA). Scroll al final sin animación, auto-scroll <120px, pastilla de nuevos, paginación con `IntersectionObserver` conservando posición. Dueño del estado de interacción: cita (`replyTo`), edición en curso, hilo abierto y avisos de "Mensaje copiado". |
| `MessageList` | `message-list.tsx` | `role=log` + `aria-live=polite`. Agrupa por autor (<5 min), separa por día, anima solo ids nuevos con el spring único. Pasa a cada `MessageItem` los seis callbacks de T16 (reacción, respuesta, hilo, copiar, editar, eliminar). |
| `MessageItem` | `message-item.tsx` | Burbuja interactiva: long-press 500ms (táctil) o hover (ratón) → `ReactionBar`; botón `...` en hover y click derecho → `MessageContextMenu`. Debajo: cita `replyTo`, chips de reacciones y botón `N respuestas`. Exporta desde aquí las clases de ancho (`MESSAGE_ROW_CLASS`, `MESSAGE_BUBBLE_FIT_CLASS`). |
| `MessageBubble` | `message-bubble.tsx` | Propios `#0F0F0F`/`#2A2A2A`, otros `#F0F0F0`/`#16181C`, radio 22px, 15px/1.45, `break-words`. IA sin burbuja (`Loki` + Sparkles, en `AiReply` con cursor mientras llega el stream), system centrado, eliminado en itálica. Avatar 28px en el último del grupo, hora `HH:mm` bajo el grupo y `· (editado)` si `editedAt`. Color de avatar por `useAuthorAvatarColor`. `variant="post"`: fila plana del feed (avatar 40 + nombre + tiempo relativo), sin burbuja. |
| `ReactionBar` | `reaction-bar.tsx` | `MenuCard` flotante con 6 emojis rápidos + `+` que abre el grid de 24 (`EXTENDED_REACTIONS`). `role=toolbar`, `aria-label="Reaccionar con X"` por emoji, Escape/click afuera cierran. |
| `ReactionChips` | `reaction-chips.tsx` | Chips bajo la burbuja (emoji + contador, ordenados por cantidad). El propio lleva `aria-pressed` y borde accent; tocarlo alterna el uid propio. |
| `MessageContextMenu` | `message-context-menu.tsx` | `role=menu` con Responder, Responder en hilo, Copiar, Editar y Eliminar (las dos últimas solo del autor). Eliminar pide confirmación en línea "Eliminar mensaje?" (Cancelar/Eliminar). |
| `ThreadPanel` | `thread-panel.tsx` | Hilo en portal a `document.body`: drawer derecho de 420px en escritorio (scrim included) y bottom sheet casi a pantalla completa en móvil. Padre + `useThread` en vivo + `Composer` que envía con `threadParentId`. Desde T17 acepta `title`/`parentLabel` (Publicaciones lo abre como "Comentarios" sobre "Publicación"). |
| `PostsView` | `posts-view.tsx` | `/chat/publicaciones`: composer arriba (sticky bajo el header, columna de 760px), feed y estado vacío. `usePosts` + `usePublishPost`; errores y reintento con el mismo id de cliente. |
| `PostRow` | `post-row.tsx` | Fila plana estilo X separada por `border-divider`: `MessageBubble variant="post"` + acciones Me gusta (Heart relleno/`text-danger`/`aria-pressed` con contador) y Comentar (MessageCircle + `threadCount`). Exporta `usePostClock`, un único reloj para todos los tiempos relativos. |
| `DaySeparator` | `day-separator.tsx` | `Hoy` / `Ayer` / `lunes 21 de septiembre`, 13px muted. |
| `Composer` | `composer.tsx` | Botón `+` 44px + pastilla con textarea 1–6 líneas, micrófono y enviar 36px (spring). Enter envía solo con puntero fino; `visualViewport` + `safe-area` para el teclado. Acepta `replyTo` (barra de cita con X), `edit` (precarga el texto y Enter guarda), `placeholder`, `disabled`, `wsId`/`mediaBucket` (subida de adjuntos) y `onDictate` (en el chat con Loki el micrófono dicta en vez de mandar un adjunto). `mode="post"` lo convierte en el composer superior del feed. |
| `AttachMenu` | `attach-menu.tsx` | `MenuCard` con 4 opciones reales: Foto o video, Cámara, Archivo y Nota de voz. Cierra con click afuera o Escape. `+` rota a ×. |
| `NewMessagesPill` | `new-messages-pill.tsx` | Pastilla flotante `Nuevos mensajes` + flecha, baja con scroll suave. |
| `TypingIndicator` | `typing-indicator.tsx` | `X está escribiendo…` / `X e Y están…` / `Varias personas…` debajo de los mensajes (`aria-live=polite`). Nada si nadie escribe. |

## Publicaciones (T17)

Feed estilo X unido al chat: los posts son mensajes `type: "post"` con `threadParentId: null` del chat `posts` del espacio (id fijo, creado por la RPC `create_workspace`; `ensurePostsChat` lo crea si el espacio es anterior a T17). Los comentarios son respuestas de hilo normales.

- `src/lib/chat/posts.ts` (puro): `POSTS_CHAT_ID`/nombre/emoji, `POST_LIKE_EMOJI` (corazón rojo U+2764 U+FE0F), textos de la pantalla, `formatPostTime` ("ahora" / "5 min" / "2 h" / "ayer" / fecha) y los helpers `isPostMessage`, `postLikeCount`, `hasPostLike`, `postCommentCount`.
- `PostsView` + `PostRow`: `usePosts` (misma query que el timeline: `thread_parent_id == null` + `created_at` desc, con el índice parcial de Postgres) y `usePublishPost` con envío optimista e idempotente (`ensure_posts_chat` → `sendMessage` type `post`). Publicar actualiza `last_message` del chat (trigger); comentar solo sube `threadCount` (trigger).
- Un post **no** es una burbuja: `MessageBubble` acepta `variant="post"` (fila plana con avatar `avatarColorFor(uid)`, nombre semibold, tiempo relativo muted) y las acciones viven en `PostRow`: Me gusta (Heart relleno + `text-danger` + `aria-pressed` cuando el uid propio ya reaccionó, contador al lado, alterna con `toggleReaction`) y Comentar (MessageCircle + `threadCount`, abre el `ThreadPanel` con título "Comentarios").
- `Composer` acepta `mode="post"`: mismo autogrow y Enter con puntero fino, pero botón de imagen deshabilitado "Próximamente", botón "Publicar" (deshabilitado sin texto) y sin menú de menciones. Va arriba, `sticky` bajo el header y centrado en la columna de 760px; en la lista de chats la tarjeta Publicaciones muestra el preview real del `lastMessage` del chat `posts`.
- **Alta del chat antes de escuchar**: `usePosts` llama a `ensurePostsChat` (RPC `ensure_posts_chat`, idempotente) y solo después se suscribe a `listenPosts`. Sin acceso al espacio la RLS devuelve lista vacía, no error; si el canal falla (red), no se muestra error (el feed queda en su estado vacío) y se reintenta 3 veces cada 4 s volviendo a asegurar el chat; el esqueleto solo aparece hasta la primera carga y las cargas entran con `mergeUnique` (desc), para que un post optimista o con error de envío no desaparezca por una carga ajena.
- **Móvil**: `MobileHeader` detecta `/chat/publicaciones` y pinta la misma cabecera que una conversación (volver a `/chat`, pastilla con el emoji 📰 y "Publicaciones", botón de detalles), en vez del selector de espacio. En escritorio no cambia nada.
- **Acentos**: los literales de `posts.ts` van con tilde y signos correctos (`¿Qué quieres compartir?`, `Publicación`, `Próximamente`, `Todavía no hay publicaciones…`); en el panel de comentarios el contador dice `1 comentario` / `N comentarios` y el vacío `Sin comentarios todavía.` (el hilo normal sigue con "respuesta(s)").

## Interacción por mensaje (T16)

- **Reacciones**: long-press 500ms en táctil o hover con ratón sobre la burbuja → barra flotante (6 rápidos + `+` con el grid de 24). Elegir un emoji llama a `toggleReaction`, que inserta/borra tu fila en `message_reactions` (la RLS solo deja tu `user_id`). Los chips de debajo repiten la acción: `aria-pressed` marca el propio y el borde accent lo distingue. Llegan en vivo por realtime (`useMessages`/`usePosts`/`useThread` refrescan los mapas).
- **Responder**: el menú pone una barra de cita sobre el composer (autor + texto truncado + X) y el mensaje enviado guarda `replyTo {id, authorName, text}`. En el timeline la cita se ve encima de la burbuja (borde accent).
- **Editar** (solo autor): el composer precarga el texto; Enter (o el botón enviar) llama a `editMessage` con el texto y sus menciones, y la burbuja muestra `· (editado)` en la línea de la hora.
- **Eliminar** (solo autor): `deleteMessage` (borrado suave) y la burbuja pasa a `Mensaje eliminado` en itálica con borde `divider` y sin relleno; sin interacciones ni chips.
- **Copiar**: `navigator.clipboard.writeText` y un aviso `Mensaje copiado` de 1,8 s (`role=status`) sobre el composer.
- **Hilos**: `Responder en hilo` o el botón `N respuestas` abren el `ThreadPanel` con el mensaje padre. Las respuestas se escriben con `sendMessage({threadParentId})` (no con el envío optimista de `useSendMessage`, que insertaría en la caché del timeline) y llegan por `useThread`/`listenThread`. **No aparecen nunca en el timeline principal**: sus consultas filtran `threadParentId == null`.

### Correcciones de T16 (intento 2, verificadas con Playwright)

- **Hover**: el reset de menús/reacciones de `MessageItem` compara el id con un `useRef` (`prevMessageIdRef`), así que ya no corre al montar; el **primer** `pointerenter` con ratón abre la `ReactionBar` (antes había que salir y volver a entrar).
- **Ancho**: los wrappers de cada mensaje en `MessageList` (`<div className="w-full">` y el `motion.div`) llevan `w-full`; con `items-end` se encogían al contenido y el `max-w-[78%]` se resolvía contra ese ancho intrínseco, partiendo los mensajes cortos en 2 líneas a 1440px.
- **Mensaje eliminado**: sin fondo sólido, borde 1px `border-divider`, itálica `text-muted-foreground`, mismo radio 22px, alineado según el autor y sin reacciones ni menú (los tokens ya cubren claro y oscuro).
- **Preview del chat**: con `threadParentId !== null` no se toca el chat (ni `last_message` ni `updated_at`): el trigger de Postgres solo actualiza el preview con mensajes del timeline de type `user`/`post`/`ai`, y el de hilos solo sube `threadCount`/`last_reply_at` del padre.

## Avatares deterministas (T16)

`src/lib/avatar-color.ts` (puro) + `src/hooks/use-avatar-color.ts`:

- `AVATAR_COLOR_PALETTE` son 8 colores sobrios (`#5B8DEF`, `#E07A5F`, `#3D9970`, `#9B72CF`, `#D4A017`, `#2A9D8F`, `#C2185B`, `#6C757D`).
- `avatarColorFor(id)` = hash estable (djb2 de 32 bits) del id → índice de la paleta. La misma persona (o el mismo chat) tiene siempre el mismo color sin guardar nada en la base.
- `useAuthorAvatarColor(uid)` devuelve el color de mi perfil si la persona soy yo y el perfil ya está cargado; si no, el determinista.
- Se usa en burbujas, panel de hilo, menú de menciones del composer, avatares de la lista de chats, cabecera móvil y panel de miembros del panel contextual, en lugar de `AVATAR_FALLBACK_COLOR`.
- `avatarTextColor` (en `src/types/models.ts`) suma los tonos claros de la paleta al grupo que necesita texto `#0F1419` (con blanco quedaban entre 2.4:1 y 3.7:1; con texto oscuro suben a 4.8:1-7.5:1).

## Ancho de la burbuja

`MESSAGE_ROW_CLASS` (`relative flex w-full`) da a la fila el ancho **de la columna** y `MESSAGE_BUBBLE_FIT_CLASS` (`long-press relative w-fit max-w-[78%]`) deja que la burbuja crezca con su contenido hasta el 78%.

El orden importa: si el contenedor de la burbuja encoge al contenido (`items-end` en una columna flex), su `max-width` en porcentaje se resuelve contra ese ancho intrínseco y los textos cortos se parten muy pronto (≈55% del ancho en 390px). Por eso **toda** la cadena de ancestros hasta la burbuja es `w-full` (wrapper del mensaje en `MessageList` incluido, propio y animado) y la burbuja usa `w-fit max-w-[78%]` con `break-words` (nunca `break-all`), y `min-w-0` solo en la burbuja de los otros (para que una palabra larga pueda partirse).

## Tiempo real

- **Envío optimista**: `useSendMessage` inserta el mensaje con id de cliente (`crypto.randomUUID()`) y `createdAt` provisional en la caché de TanStack Query; el evento de realtime lo reemplaza al confirmar (mismo id). Estado local en `src/lib/chat/message-status.ts` (`sending`/`error`); en error la burbuja muestra `No se pudo enviar · Reintentar` y reintenta con el mismo id (duplicado = enviado).
- **Typing**: Broadcast en el canal `chat:{espacio}:{chat}` (`displayName`, `at`) con throttle 800ms (`useNotifyTyping`); se borra al vaciar, enviar o desmontar. `useTyping` filtra `at < 4s` (sin mí) y revalida cada segundo. El composer del hilo publica su typing con el mismo hook.
- **Leídos**: `chat_reads` (upsert de `last_read_at`); se marca al abrir y al llegar al fondo (`useMarkChatRead`). La lista muestra punto azul + contador (`useUnread`: `lastMessage.createdAt > lastReadAt` y autor ajeno).

## Utilidades (`src/lib/chat/`)

- `format.ts`: `formatHour`, `formatDayLabel`, `formatChatTime`, `dayKey`, `groupMessages` (ventana 5 min).
- `posts.ts` (T17): id/nombre/emoji del chat `posts`, `POST_LIKE_EMOJI`, textos de la pantalla, `formatPostTime` y los helpers de like/comentarios.
- `reactions.ts`: `QUICK_REACTIONS` (6) y `EXTENDED_REACTIONS` (24) como {emoji, nombre accesible, codepoints} construidos con `String.fromCodePoint` (sin emojis pegados a mano en el código).
- `mentions.ts`: `getMentionQuery`, `filterMentionCandidates`, `resolveMentionIds`, `parseMentionSegments`, `mentionsLoki`, `buildLokiDisabledMessage` (puras, testeables con Node sin runner).
- `preview.ts`: `updatesChatPreview(type)` — qué mensajes pueden tocar `lastMessage`/`updated_at` del chat (los del preview de la lista). `type "system"` NO (misma regla que el trigger de Postgres).
- `src/lib/ai/constants.ts`: `AI_CHAT_ID`/`AI_CHAT_NAME`/`AI_AUTHOR_ID`, `AI_SUGGESTIONS` (los tres chips), `AI_PLACEHOLDER`, `AI_EMPTY_TITLE`/`AI_EMPTY_DESCRIPTION`, `AI_CONNECTING_TEXT`. Solo literales de UI.
- `src/lib/ai/loki.ts`: cliente de la Edge Function (`getLokiStatus`, `streamLokiReply` por SSE, textos "Loki IA sin configurar").

## Menciones (T15)

- **Composer**: `@` abre un `MenuCard` flotante con la entrada fija `@Loki`/`@ai` (id `loki`) + miembros del espacio (`useMembers` → `listMembers`/`listenMembers` en `src/lib/data/chat.ts`). Filtra por el texto tras `@` (sin tildes, insensible a mayúsculas). Flechas + Enter / click insertan `@Nombre` (el uid se resuelve en `mentions[]` al enviar con `resolveMentionIds`). Escape cierra; sin resultados se cierra.
- **MessageBubble**: `parseMentionSegments` resalta menciones conocidas (match `@Nombre` o lookup por `mentions[]`) con `text-mention` (#1D9BF0), `font-semibold`, sin subrayado. El texto plano sigue igual.
- **@Loki**: si el mensaje menciona `loki`/`ai`, tras enviarlo la app pide la respuesta a la Edge Function (modo `mention`): la escribe con la service role y llega por realtime como mensaje `type: "ai"`. Sin proveedor configurado se inserta seguido un aviso type `system` con el `authorId` del propio usuario, texto `Loki IA sin configurar. Pide al administrador que configure el proveedor.` y `mentions: ["loki-disabled"]`. Es lo único escribible por el cliente en los chats de espacio (la RLS prohíbe type `"ai"` ahí).
- **El aviso es SUTIL y CENTRADO**: `MessageBubble` lo pinta como mensaje de sistema (texto 13px muted, centrado, sin burbuja) en medio del timeline. No hay toast ni banner. La marca `loki-disabled` no cuenta como mención real en `parseMentionSegments`, así que el aviso no arrastra a resaltar nada.
- **El aviso NO toca el preview del chat**: el trigger solo mira mensajes del timeline de type `user`/`post`/`ai`, así que la lista sigue enseñando el último mensaje real ("Manu Oliva: oye @Loki ¿Qué tengo hoy?").

## Loki IA (Edge Function `loki-chat`)

`/chat/loki-ia` es un chat real contra `ai_messages` (la fila privada se
resuelve por usuario). `ConversationView` detecta el chat con `AI_CHAT_ID` y
cambia de origen de datos: `useAiMessages` en vez de `useMessages`, y sin
typing, paging, reacciones ni hilos (todo eso es de los chats de espacio).

- **Estilo**: la respuesta de la IA va **sin burbuja** y a ancho completo, con `Loki` + icono `Sparkles`; los mensajes del usuario conservan su burbuja. `MessageBubble` la delega en `AiReply`, con cursor `accent` mientras llega el stream.
- **Estado vacío + chips**: sin mensajes, `EmptyState` (`Sparkles`, "Habla con Loki") y debajo los tres chips de `AI_SUGGESTIONS` — `¿Qué tengo hoy?`, `Resume mi semana`, `Crea un recordatorio`. Al tocar uno, `AiSuggestions` llama a `onPick` y el texto se envía **como mensaje del usuario** por el mismo camino que escribirlo y pulsar Enter (`handleSend(text, [])`).
- **Flujo**: el mensaje del usuario se guarda con `useSendAiMessage` (type `user`, lo único que la RLS deja al cliente) y seguido se llama a `streamLokiReply` (modo `personal`): la Edge Function responde por SSE real (texto en vivo en una burbuja provisional) y guarda la respuesta `type "ai"` con la service role, que llega por realtime. Sin proveedor: `GET /health` dice `configured: false`, la pantalla muestra **"Loki IA sin configurar"**, los chips se ocultan y el composer se deshabilita (prop `disabled`).
- **Móvil**: `ConversationView` y `MobileHeader` usan `AI_CHAT_ID`/`AI_CHAT_NAME` en vez de literales sueltos, así que la cabecera y la lista no se desincronizan del id.
- `Configuración → Loki IA` muestra el estado real del proveedor ("Disponible" / "Sin configurar" / "Comprobando…") con `getLokiStatus()`. Es de solo lectura: la clave y el proveedor viven en `supabase/functions/.env`, no en el cliente.

| Componente | Archivo | Uso |
|---|---|---|
| `AiSuggestions` | `ai-suggestions.tsx` | Los tres chips de arranque, solo con el chat vacío y configurado. `onPick(text)` envía el texto como mensaje del usuario. |
| `AiConnecting` | `ai-connecting.tsx` | Línea "Conectando con Loki…" (Sparkles + muted) mientras genera la Edge Function. |
| `AiToolCard` | `ai-tool-card.tsx` | Tarjeta de confirmación: una acción o un plan con casilla por acción, cada una editable (título, fecha/hora, responsable, proyecto, ítems de lista). Enter confirma y Escape cancela. `UndoBar` debajo tras ejecutar. |
| `ConvertSheet` | `convert-sheet.tsx` | Mensaje (o transcripción de una nota de voz) → tarea/evento/recordatorio, con prefill del analizador determinista y "Mejorar con Loki". |
| `VoiceConvertSheet` | `voice-convert-sheet.tsx` | "Convertir en…" sobre una nota de voz: pide la transcripción y, cuando llega, abre el `ConvertSheet` con ese texto. |
| `DictationBanner` | `dictation-banner.tsx` | El texto dictado, editable, encima de la tarjeta de plan, con "Recalcular con este texto". |
| `DictateSheet` | `../ai/dictate-sheet.tsx` | Grabar (o subir un archivo) → subir a Storage → transcribir → revisar y enviar a Loki. |

## Notas de voz y transcripción

- **Grabar**: `src/components/media/voice-recorder.tsx` con dos modos.
  `hold` (chat): mantener para grabar, soltar para enviar, deslizar a la
  izquierda (>80 px) para cancelar. `toggle` (diálogos y escritorio): un click
  empieza y el siguiente para. El MIME lo elige `pickVoiceMimeType()` (webm/opus
  en Chrome, mp4 en Safari), con onda en vivo por `AnalyserNode`, cronómetro,
  háptico al empezar y al terminar, tope de 5 minutos y corte automático si la
  app pasa a segundo plano. Si el permiso se niega, el mensaje dice cómo
  reactivarlo y siempre queda subir un archivo de audio.
- **Subir**: `src/lib/media/upload.ts` sube a `chat-media` con progreso real y
  cancelación, y guarda en el adjunto `path = {bucket}/{wsId}/{uuid}-{nombre}`.
  Ese `path` es lo que permite transcribir después sin volver a subir nada.
- **Transcribir (bajo demanda)**: `src/components/media/transcription-panel.tsx`
  pinta "Ver transcripción" bajo cada nota de voz. Al tocarlo:
  1. se busca si ya existe (no se vuelve a pagar);
  2. si no, se comprueba `GET /health` de `loki-worker`; sin proveedor se
     muestra "Transcripción sin configurar" **sin encolar nada**;
  3. se inserta una fila en `audio_transcriptions`, y el trigger
     `audio_transcriptions_enqueue` + `wake_ai_worker` despiertan a la Edge por
     `pg_net`;
  4. el texto llega por Realtime sobre la fila.
- **Visibilidad**: la transcripción lleva `message_id` + `chat_id`, así que la
  RLS la filtra con `can_access_chat` (en un DM, solo sus miembros). El CHECK
  `storage_workspace_id(object_path) = workspace_id` ata cada transcripción al
  espacio real del archivo.
- **Dictar a Loki**: `src/components/ai/dictate-sheet.tsx` (botón del
  composer en `/chat/loki-ia`, acción rápida "Dictar a Loki" con
  `?dictar=1`, o `Ctrl/Cmd+Shift+D`). El texto transcrito entra por
  `sendToLoki`, el mismo camino que escribirlo, y `DictationBanner` lo muestra
  encima del plan para corregirlo antes de confirmar.
- **Convertir una nota de voz**: "Convertir en…" detecta el adjunto de audio
  (`firstTranscribable`) y abre `VoiceConvertSheet`, que transcribe y luego
  convierte.
- **Buscar**: `global_search` devuelve además el grupo `transcriptions`, que la
  paleta pinta como "Notas de voz".

### Unitarios

`tests/preview.test.mjs` (`npm run test:preview`) cubre `preview.ts`: que `user`/`post`/`ai` (y el default sin `type`) actualicen el preview del chat y que **`system` no** lo haga, aplicado al aviso real de `buildLokiDisabledMessage`. `tests/mentions.test.mjs` cubre el parser @ y el texto exacto del aviso. Los dos corren en `npm run test:unit`.

## Movimiento

Todo `motion.*` usa el spring único de `src/lib/motion.ts` y respeta `prefers-reduced-motion` (`useReducedMotion` + `matchMedia` en scroll).
