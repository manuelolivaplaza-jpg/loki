# Loki: prompts de funciones nuevas (etapas 1, 2 y 3)

Manu, aquí van los prompts para opencode, en orden. Cada uno explica **qué queremos construir y por qué**: objetivo, experiencia de usuario, comportamiento, ideas de modelo de datos, casos borde, permisos y cómo encaja con el código que ya existe. No son guiones paso a paso: el agente decide los detalles de implementación dentro de esas reglas.

**Cómo usarlos**
1. Abre opencode en `C:\Users\manue\OneDrive\Desktop\loki`.
2. Pega primero el **Contexto compartido** (bloque de abajo). Después pega UN prompt, espera a que termine, revisa y sigue con el siguiente. Cada prompt también se sostiene solo (repite lo mínimo), así que puedes pegar uno suelto en una sesión nueva; en ese caso conviene pegar antes el contexto compartido.
3. Los prompts de funciones **no** compilan, ni testean, ni verifican nada: toda la verificación está en el **Prompt 16 (final)**. Si algo se rompe entremedio, el prompt final lo detecta y lo corrige.
4. Sugerencia: al terminar cada prompt, haz un commit local con el título del prompt (sin push), así puedes volver atrás si algo sale mal.

**Orden y dependencias**
- Prompts 1–2: cimientos (datos comunes y motor de IA barato y orientado a eventos). Todo lo demás se apoya en ellos.
- Prompts 3–11: etapa 1 (las funciones base que aprobaste). El resumen diario va al final de la etapa porque junta datos de listas, turnos, encuestas y memoria.
- Prompts 12–13: etapa 2 (agentes personales conectados al chat).
- Prompts 14–15: etapa 3 (control del PC con un compañero de escritorio).
- Prompt 16: verificación y regresión completa (web + Android).

**Lo que encontré ya hecho en el repo (los prompts lo tienen en cuenta)**
- Loki IA ya tiene herramientas en `supabase/functions/loki-chat/index.ts`: `get_today_summary`, `list_events`, `create_event`, `list_tasks`, `create_task`, `complete_task`, `list_projects`, `search_messages`, `create_reminder`, con tarjeta de confirmación (`tool_pending` por SSE y segundo POST con `confirm`), cliente `src/lib/ai/tools-client.ts`, tarjeta `src/components/chat/ai-tool-card.tsx`, cuota por usuario (`ai_usage` + `bump_ai_usage`), resúmenes (`ai_summaries`) y una detección de intención sin LLM (`detectIntentFallback`). El prompt 3 **amplía** eso, no lo rehace.
- Ya existe un resumen diario fijo: `create_ai_daily_digest()` con pg_cron `loki-ai-daily-8am` a las 12:00 UTC (texto genérico igual para todos, y en horario de verano de Chile llega a las 9:00). El prompt 11 lo reemplaza.
- Recordatorios: `create_due_reminders()` (pg_cron cada 15 min, SQL puro, sin IA) y push directo `notifications` → trigger `maybe_push_notification` (pg_net, settings `loki.push_url`/`loki.push_key`) → Edge `push-send`. Ese es el patrón orientado a eventos que reutilizan los prompts.
- Ojo: `tasks.project_id` es obligatorio, así que hoy un "recordatorio" sin proyecto falla ("Me falta el proyecto"). El prompt 1 crea una Bandeja por espacio para resolverlo.
- El README dice que la UI de adjuntos está deshabilitada, pero en el código el composer ya sube a Storage (`composer.tsx`, `src/lib/media/upload.ts`, `voice-recorder.tsx`, `message-attachments.tsx`, `voice-message.tsx`). Los prompts piden revisar el estado real y reutilizarlo. "Unirse con código" también parece hecho (`1b473ff`, `/invite`).
- `workspaces.kind` (familia/equipo) sigue en localStorage (`src/lib/data/workspaces.ts`). El prompt 1 lo pasa a la base.
- La idea 7 (gastos compartidos) quedó descartada: no aparece en ningún prompt.

---

## Contexto compartido (pégalo primero)
```
Proyecto Loki: app colaborativa multiplataforma para familias y equipos. Carpeta: C:\Users\manue\OneDrive\Desktop\loki (Windows + PowerShell). Lee PROGRESO.md y README.md antes de empezar.

Stack: Next.js 15 con export estático (output: "export") + TypeScript estricto + Tailwind + shadcn/ui + Capacitor (Android, appId cl.loki.app). Backend: Supabase local (Postgres + RLS + Realtime + Storage + Edge Functions en Deno), con el CLI dentro de WSL2 vía scripts/supabase.mjs. Firebase SOLO para push FCM (src/lib/push/fcm.ts en web, src/lib/push/native.ts en Android).

Patrones que ya existen y hay que seguir:
- Capa de datos en src/lib/data/* (traduce el snake_case de Postgres al camelCase de src/types/*), hooks en src/hooks/*, pantallas en src/app/(app)/*, componentes en src/components/*, estado global con zustand en src/stores/*, React Query para listas.
- Export estático: no hay servidor Next, ni API routes, ni rutas dinámicas sin generateStaticParams. Las pantallas de detalle usan query params (por ejemplo /chat/c?...). Toda lógica de servidor va en Edge Functions (supabase/functions/*), que hoy son archivos sin dependencias externas (loki-chat, push-send, google-calendar). Si extraes código común a supabase/functions/_shared/, usa imports relativos y sin paquetes externos (revisa antes el commit ecd83f9, "arreglo del bundle Deno").
- Migraciones: SIEMPRE una migración NUEVA en supabase/migrations/ con fecha posterior a 20261001000000_push_direct.sql. Nunca editar las anteriores. Convenciones: snake_case, helpers SECURITY DEFINER con search_path fijo, políticas con nombre en español, DROP POLICY IF EXISTS + CREATE POLICY, GRANTs explícitos, y todo lo que dependa del entorno (pg_cron, pg_net, extensiones) en bloques DO con EXCEPTION para no romper sb:reset. Helpers existentes: is_member, is_owner, is_space_admin, can_access_chat, storage_workspace_id. Las tablas nuevas que se vean en vivo se agregan a la publicación supabase_realtime. Por cada tabla nueva deja tests RLS en tests/rls/ siguiendo tests/rls/_helpers.mjs (se ejecutan en el prompt final, no ahora).
- Loki IA real vía la Edge Function loki-chat (LLM_PROVIDER openai|anthropic|gemini, LLM_MODEL, LLM_API_KEY, LLM_BASE_URL en supabase/functions/.env, gitignored, con plantilla .env.example). Sin respuestas simuladas: sin clave la UI muestra "Loki IA sin configurar" y nada se rompe. Las acciones que escriben datos piden confirmación con la tarjeta del chat (protocolo tool_pending + confirm, ya implementado).
- Notificaciones: insertar en public.notifications dispara el push (trigger maybe_push_notification → pg_net → Edge push-send, que respeta notification_prefs y el horario de silencio). Para avisar a alguien, inserta una notificación; no llames a FCM directo.
- Push nativo Android y web ya cableados; sin config, la UI dice "Notificaciones no configuradas".

Principio de arquitectura (obligatorio en todo): NADA queda escuchando ni consultando 24/7 gastando tokens. Todo es por eventos: un insert en la base → trigger o cola → una Edge Function se despierta solo cuando hace falta → resultado por webhook o insert → vuelve a dormir. pg_cron solo para SQL barato (sin LLM). Primero código determinista (sin LLM) para lo simple; después el modelo barato; el modelo potente solo cuando hace falta. Límites de uso por espacio, visibles para el usuario.

Web y móvil siempre: toda función debe funcionar en web (escritorio y navegador móvil) y en la app Android (Capacitor). Layout responsivo (hojas inferiores en móvil, diálogos o paneles en escritorio), gestos táctiles (mantener pulsado 500 ms, deslizar) y sus equivalentes de escritorio (click derecho, hover, atajos de teclado), safe areas, teclado virtual (el composer ya usa window.visualViewport) y funciones nativas (push, micrófono, notificaciones, compartir, hápticos) con alternativa web cuando no estén.

Diseño: claro estilo Grok Bot, el que ya existe. Fondo #FFFFFF, superficies #F0F0F0/#F7F9F9, texto #0F1419/#536471, bordes #EFF3F4, accent #00B4D8, menciones #1D9BF0, oscuro true black opcional, Inter, íconos lucide con stroke 1.75. Reutiliza src/components/ui/* (menu-card, list-row, pill, dialog, popover, switch, empty-state, etc.) y los tokens de src/app/globals.css. Estados vacíos útiles, skeletons, errores con reintento, todo en español con tildes.

Reglas: TypeScript estricto sin any. Nunca secretos en el código; la service_role nunca en NEXT_PUBLIC_ ni en el cliente; los secretos nuevos van solo en supabase/functions/.env, con su línea vacía en .env.example. Sin git push, sin deploy, sin proyectos reales de Supabase o Firebase (nada de supabase link/db push/login). No borres carpetas. No toques procesos ajenos.

En este prompt no compiles, ni corras tests, ni verifiques: la verificación completa va en un prompt final aparte. Concéntrate en implementar bien.
```

---

## Prompt 1: Cimientos de datos para las funciones nuevas
```
Proyecto Loki (ver el contexto compartido; si no lo tienes, lee PROGRESO.md y README.md). Antes de las funciones nuevas necesitamos unos cimientos comunes en la base y en la capa de datos, para que los prompts siguientes no tengan que tocar lo mismo cada uno.

Qué queremos
1. Tipo de espacio en la base. Hoy kind (familia/equipo) vive en localStorage (src/lib/data/workspaces.ts, KIND_STORAGE_KEY). Pásalo a una columna real de workspaces con una migración nueva (valores acotados, default razonable), actualiza create_workspace o agrega una RPC para fijarlo, y migra desde el cliente lo que haya en localStorage la primera vez que se lea (después deja de usarse). Varias funciones (turnos, listas, textos de Loki, límites de IA) cambian el tono o los defaults según sea familia o equipo.
2. Bandeja por espacio. tasks.project_id es obligatorio, así que un recordatorio o una tarea suelta creada desde el chat, una nota de voz o Loki IA no tiene dónde caer (hoy loki-chat responde "Me falta el proyecto"). Crea un proyecto especial "Bandeja" por espacio (marcado como de sistema, no se puede borrar ni archivar, aparece primero en Proyectos con su propio emoji), creado de forma idempotente con una RPC segura tipo ensure_inbox_project(workspace_id), y también para los espacios existentes. Toda tarea sin proyecto explícito va ahí.
3. Mensajes con contenido estructurado. Las encuestas, las listas compartidas en el chat, las tarjetas de "convertido en tarea", los resultados de agentes y los comandos de PC necesitan datos además del texto. Agrega a messages una columna meta jsonb (default '{}', con tope de tamaño) y amplía los tipos de mensaje permitidos para lo que viene (por ejemplo 'card' para tarjetas y 'agent' para respuestas de agentes externos). Revisa messages_guard_update y las políticas: un cliente no puede falsificar mensajes 'ai' o 'agent' ni meta de sistema; esos los escribe solo la service role desde Edge Functions. El preview del chat (messages_update_chat_preview y src/lib/chat/preview.ts) debe mostrar algo legible para cada tipo nuevo ("📊 Encuesta: …", "✅ Lista: …", "🤖 mi-bot respondió").
4. Tipos de notificación nuevos. Amplía el check de notifications.type y agrega sus columnas en notification_prefs para: resumen diario, listas, turnos/recurrentes, encuestas, agentes y dispositivos (nombres cortos en inglés, como los actuales). Actualiza src/lib/data/notifications.ts, los íconos de la bandeja (notifications-tray, notifications-menu) y Configuración → Notificaciones con sus interruptores. push-send ya respeta las preferencias por tipo: asegúrate de que los tipos nuevos queden mapeados.
5. Enlaces profundos. Define en un solo lugar (por ejemplo src/lib/navigation.ts) cómo se arman los links internos de notificaciones y tarjetas para las entidades nuevas (lista, encuesta, ejecución de agente, comando de PC, resumen del día), siempre con query params por el export estático, y que src/components/pwa/deep-links.tsx y el toque en una push nativa los abran en la pantalla correcta.

Web y móvil
- La migración de kind desde localStorage tiene que funcionar igual en el navegador y en la WebView de Capacitor (cada uno tiene su propio localStorage).
- La Bandeja se ve bien como tarjeta en la lista de proyectos móvil y en escritorio, y en el selector de proyecto de la hoja de tarea.
- Los íconos y textos nuevos de notificaciones se ven en la campana de escritorio, en la bandeja móvil y en la push nativa (canal loki_default).

Casos borde y seguridad
- Espacios ya creados sin kind ni Bandeja: la migración los completa sin fallar.
- Nadie puede borrar ni archivar la Bandeja (ni un admin); renombrarla, a lo sumo, un admin.
- meta nunca se renderiza como HTML; todo pasa por safe-text.
- Tests RLS para la columna nueva, la RPC de la Bandeja y el intento de falsificar mensajes 'ai'/'agent' o meta.
- Actualiza src/types/supabase.ts, src/types/models.ts y src/types/chat.ts según corresponda.
```

## Prompt 2: Motor de IA barato y por eventos (enrutado de modelos, cola y límites por espacio)
```
Proyecto Loki (ver el contexto compartido). Todas las funciones que vienen usan IA, y no queremos nada que espere o consulte 24/7 gastando tokens. Este prompt construye el motor común: enrutado de modelos, una capa determinista, una cola de trabajos por eventos y límites de uso por espacio visibles. No agrega funciones de usuario nuevas, salvo la pantalla de uso.

Qué queremos
1. Enrutado de modelos en loki-chat. Hoy hay un solo LLM_MODEL. Agrega niveles configurables por entorno: un modelo barato y rápido (clasificar intención, extraer fechas, resumir poco texto) y uno potente (planes de varios pasos, resúmenes largos, razonamiento), con fallback al LLM_MODEL actual si no se configuran (por ejemplo LLM_MODEL_FAST y LLM_MODEL_SMART; documéntalos en supabase/functions/.env.example sin valores). Cada llamada declara qué nivel necesita. La regla: código determinista primero, modelo barato después, potente solo cuando el barato no alcanza o la tarea lo exige.
2. Capa determinista antes del LLM. Hoy existe detectIntentFallback (heurística). Conviértelo en un analizador en español reutilizable: fechas relativas ("mañana a las 5", "el viernes", "en 2 horas", "pasado mañana"), recurrencias ("cada lunes", "todos los días a las 8", "el 5 de cada mes"), horas en formato 24 h y am/pm, zona America/Santiago con su horario de verano, personas mencionadas, y verbos de acción ("recuérdame", "agrega a la lista", "agenda"). Si el analizador está seguro, no se llama al modelo ("recuérdame mañana a las 9 sacar la basura", "agrega leche a la lista del súper"). Ponlo en un módulo puro sin dependencias, usable desde Edge y desde el cliente (igual que src/lib/chat/mentions.ts, que se importa desde Node para tests); deja un test unitario nuevo en tests/ y súmalo a test:unit en package.json (se ejecuta en el prompt final).
3. Cola de trabajos por eventos. Una tabla tipo ai_jobs con: espacio, usuario que lo pidió, tipo (resumir chat, transcribir audio, OCR, redactar destacados del día, despachar agente, etc.), payload, estado (queued, running, done, error, cancelled), intentos, resultado, costo estimado y timestamps. Un trigger AFTER INSERT despierta con pg_net una Edge Function trabajadora (por ejemplo loki-worker) usando el mismo patrón de settings que maybe_push_notification (loki.worker_url / loki.worker_key; sin ellos no hace nada y nunca rompe el insert). La función procesa ese trabajo, guarda el resultado (en la tabla destino y/o como mensaje o notificación) y termina. Reintentos con backoff limitados, idempotencia por clave (no procesar dos veces lo mismo) y un barrido SQL barato con pg_cron solo para rescatar trabajos colgados (sin LLM). El cliente ve el estado por Realtime sobre su fila, sin consultar en bucle.
4. Uso y límites por espacio. Hoy ai_usage es por usuario y día. Agrega contabilidad por espacio (unidades o tokens aproximados por día y por mes, por tipo de trabajo y por usuario) y un límite configurable por el admin del espacio, con defaults sensatos distintos para familia y equipo. Antes de cada llamada al LLM se reserva cuota con una RPC atómica (como bump_ai_usage); si no queda, respuesta amable en español ("Este espacio llegó a su límite de IA de hoy") y lo determinista sigue funcionando. Conserva el límite por usuario que ya existe.
5. Pantalla "Uso de IA" en Configuración: consumo del día y del mes del espacio actual, desglose por función y por miembro (el desglose por miembro solo lo ven los admins), límite editable por admins y estado del proveedor (configurado o "Loki IA sin configurar", desde GET /health de loki-chat, sin exponer claves).

Web y móvil
- Configuración → Uso de IA: en móvil, secciones apiladas con barras finas accent; en escritorio aprovecha el ancho con dos columnas; nada depende de hover.
- Los estados de un trabajo (en cola, procesando, listo, error con reintentar) viven en un componente pequeño reutilizable que sirva dentro de burbujas de chat, hojas móviles y paneles de escritorio.

Casos borde y seguridad
- Sin LLM_API_KEY: los trabajos que necesitan modelo terminan con un estado claro "Loki IA sin configurar", sin reintentos infinitos.
- Cada usuario ve solo trabajos de sus espacios, y el payload no filtra datos de chats a los que no tiene acceso (DMs).
- La Edge trabajadora valida la clave interna del trigger; un cliente nunca puede invocarla para saltarse cuotas.
- Rate limiting como en las funciones existentes (429 con mensaje en español).
```

## Prompt 3: Loki IA que actúa (eventos, tareas, recordatorios y avisos desde el chat)
```
Proyecto Loki (ver el contexto compartido). Loki IA ya tiene herramientas en supabase/functions/loki-chat/index.ts (create_event, create_task, complete_task, create_reminder, list_events, list_tasks, list_projects, search_messages, get_today_summary) con tarjeta de confirmación (tool_pending → segundo POST con confirm; cliente src/lib/ai/tools-client.ts; UI src/components/chat/ai-tool-card.tsx). Queremos que Loki "actúe" de verdad desde cualquier chat, con menos fricción y más alcance, sin rehacer lo que ya funciona. Usa el enrutado, el analizador determinista y la cuota por espacio del prompt 2, y la Bandeja y meta de mensajes del prompt 1.

Qué queremos
- Más acciones: crear avisos (publicación en el chat 'posts' del espacio vía ensure_posts_chat), recordatorios para otra persona del espacio ("recuérdale a Sofi el dentista el jueves"), asignar responsables y fechas, mover o editar una tarea o evento existente, y crear ítems de lista (cuando exista el prompt 5; deja listo el punto de extensión). Los recordatorios y tareas sin proyecto van a la Bandeja del espacio: nunca más "Me falta el proyecto".
- Planes de varias acciones: "organiza el cumpleaños del sábado: evento a las 16, tarea de comprar la torta para mí y recordatorio a todos el viernes" produce UNA tarjeta con varias acciones, cada una con su casilla para incluirla o no, y un solo Confirmar. Hoy el protocolo maneja una acción pendiente; extiéndelo a una lista sin romper la tarjeta actual.
- Editar antes de confirmar: en la tarjeta se pueden tocar título, fecha y hora, responsables y proyecto con controles compactos (no un formulario gigante). Lo que se ejecuta es exactamente lo que el usuario ve.
- Resolver personas y fechas: "mañana", "el viernes", "a Pedro" se resuelven con el analizador determinista y con los miembros del espacio (display_name de workspace_members). Si hay ambigüedad (dos "Pedro"), la tarjeta pide elegir en vez de adivinar.
- Enrutado: los comandos simples los resuelve el analizador sin LLM y muestran la tarjeta directo; las frases complejas van al modelo barato y los planes largos al potente. Cada acción con IA consume cuota del espacio.
- Funciona en el chat privado Loki IA (modo personal; hoy usa por defecto el primer espacio del usuario: muestra en la tarjeta en qué espacio se va a crear y deja cambiarlo) y con @Loki en chats de grupo (modo mention, en el hilo como hoy). En grupo, el resultado queda visible para todos como mensaje 'ai' o tarjeta 'card', con enlace a lo creado.
- Después de ejecutar: mensaje de resultado con enlaces a cada cosa creada (deep links del prompt 1) y "Deshacer" disponible unos segundos para lo recién creado por Loki.

Permisos y seguridad
- Todo se ejecuta con el JWT del usuario que confirma (RLS), nunca con service_role, salvo el guardado del mensaje 'ai'. Si el usuario no tiene permiso (por ejemplo, editar un evento ajeno, que solo puede el creador o un admin), la tarjeta lo dice antes de confirmar.
- Un recordatorio para otra persona crea la notificación de esa persona; no debe servir para spamear: límite razonable por hora y por destinatario.
- Nada que escriba datos se ejecuta sin confirmación. Las lecturas, directo.
- Sin clave: "Loki IA sin configurar", pero el analizador determinista igual puede ofrecer la tarjeta para comandos simples (eso es código, no IA). Decide y documenta el comportamiento exacto.

Web y móvil
- La tarjeta de plan se ve completa en un teléfono de 360 px: acciones apiladas, controles táctiles de 44 px, selector de fecha y hora nativo en Android (input date/time) y popover en escritorio.
- En escritorio, Enter confirma y Escape cancela cuando la tarjeta tiene el foco; en móvil, botones grandes y un háptico suave al confirmar (Capacitor Haptics, sin romper la web).
- Las sugerencias rápidas (src/components/chat/ai-suggestions.tsx) incluyen ejemplos de acciones.
```

## Prompt 4: Del chat a tareas (convertir mensajes y resumir no leídos)
```
Proyecto Loki (ver el contexto compartido). En una familia o un equipo, las cosas importantes se dicen en el chat y se pierden. Queremos convertir cualquier mensaje en tarea, evento o recordatorio en dos toques, y que Loki resuma lo no leído de un chat.

1. Convertir un mensaje
- El menú del mensaje (src/components/chat/message-context-menu.tsx; se abre manteniendo pulsado 500 ms en táctil y con click derecho en escritorio, con la barra de reacciones arriba) suma un grupo "Convertir en…": Tarea, Evento y Recordatorio (y "Agregar a lista" cuando exista el prompt 5; deja el punto de extensión). En escritorio aparece también como botón en la barra de hover del mensaje.
- Al elegir, se abre una hoja inferior (móvil) o un diálogo (escritorio) prellenado: título sacado del texto (recortado con criterio), fecha y hora detectadas con el analizador determinista del prompt 2 ("el jueves a las 18"), responsable sugerido (si el mensaje menciona a alguien, esa persona), proyecto (Bandeja por defecto) y notas con la cita del mensaje y su autor. Reutiliza los formularios existentes (src/components/projects/task-sheet.tsx, src/components/calendar/event-dialog.tsx) en vez de crear otros.
- Opcional con IA: botón "Mejorar con Loki" que usa el modelo barato para proponer título y fecha cuando el texto es largo; nunca automático.
- Vínculo de ida y vuelta: la tarea o el evento guarda de qué mensaje salió (columna o tabla de vínculos en migración nueva) y el mensaje muestra un chip discreto "✓ Tarea: Comprar torta" que abre la tarea; si la tarea se completa, el chip lo refleja en vivo. Opcionalmente queda en el chat una tarjeta breve "Manu convirtió esto en tarea para Sofi" (configurable, para no llenar el chat).
- Selección múltiple (opcional, si encaja bien con la UI): seleccionar varios mensajes y crear una sola tarea con todos citados.

2. Resumen de no leídos
- Cuando un chat tiene muchos no leídos (umbral, por ejemplo 15, a partir de chat_reads.last_read_at), junto a src/components/chat/new-messages-pill.tsx aparece una pastilla "Resumir 23 mensajes con Loki". Al tocarla se encola un trabajo (cola del prompt 2) con el modelo barato y el resultado aparece como tarjeta privada solo para quien lo pidió (no se publica en el chat): puntos clave, decisiones, preguntas pendientes y menciones a ti, con enlaces a los mensajes originales. Desde la tarjeta se pueden convertir puntos en tareas (mismo flujo de arriba).
- Cachea el resumen por (usuario, chat, último mensaje incluido) para no pagar dos veces lo mismo; si llegan mensajes nuevos, ofrece "Actualizar".
- También disponible desde el menú del chat y como pedido a Loki ("¿qué me perdí en Familia?").

Permisos y seguridad
- Solo se pueden convertir mensajes de chats accesibles (can_access_chat) y lo creado queda en el mismo espacio. Convertir un mensaje de un DM no expone el DM a otros, salvo el título que el usuario elija.
- El resumen usa solo mensajes que el usuario puede leer y respeta la cuota del espacio; sin clave, la pastilla dice "Loki IA sin configurar" y no aparenta funcionar.

Web y móvil
- Mantener pulsado no debe chocar con el scroll ni con la selección de texto nativa de Android; en escritorio el click derecho abre el mismo menú y el menú del navegador no aparece encima.
- La hoja de conversión respeta el teclado virtual y las safe areas; en escritorio el diálogo se maneja entero con teclado.
```

## Prompt 5: Listas compartidas en vivo (compras, quehaceres, checklists)
```
Proyecto Loki (ver el contexto compartido). Queremos listas compartidas que se actualicen en vivo para todos los miembros del espacio: la lista del súper, los quehaceres de la casa, la checklist del viaje, los materiales de un proyecto.

Experiencia
- Una sección "Listas" dentro de Proyectos (hoy src/app/(app)/proyectos/proyectos-tabs.tsx tiene las pestañas Proyectos e Ideas: agrega Listas), un acceso en Acciones rápidas (src/components/shell/quick-actions.tsx) y un widget en Inicio con las listas fijadas y cuántos ítems faltan.
- Tipos: compras (cantidad, unidad, categoría o pasillo opcional, "lo compré"), quehaceres (responsable y fecha opcional) y checklist genérica. Cada lista tiene título, emoji, color, fijada sí/no y archivada.
- Agregar rápido: campo siempre visible; Enter agrega y deja el foco listo para el siguiente; pegar varias líneas crea varios ítems; "2 kg de pan" se separa en cantidad y texto con el analizador determinista (sin IA).
- Marcar como hecho con un toque; los hechos bajan a una sección plegable "Hechos" que se puede limpiar entera. Reordenar arrastrando. Se ve quién agregó y quién marcó cada ítem.
- Autocompletar con ítems usados antes en ese espacio (código, no IA).
- Compartir una lista en un chat como tarjeta viva (mensaje 'card' con la meta del prompt 1) que muestra el progreso y permite marcar ítems desde el chat.
- Loki: herramientas para agregar, quitar y marcar ítems y para leer una lista ("agrega huevos y leche a la lista del súper", "¿qué falta comprar?"), conectadas al plan de acciones del prompt 3. Agregar ítems simples a una lista que existe lo resuelve el analizador sin LLM.
- Notificaciones opcionales por lista ("avísame cuando agreguen algo" o "cuando esté completa"), agrupadas: nada de una push por ítem; junta los cambios de unos minutos en una sola notificación usando dedupe.

Datos (ideas)
- Tablas lists y list_items (workspace_id en ambas para que la RLS sea simple, position numeric como en tasks, checked_by/checked_at, assignee_id, quantity/unit, created_by), en Realtime. RLS: los miembros del espacio leen y escriben; borrar la lista solo el creador o un admin.
- Concurrencia: dos personas marcan o editan a la vez; gana la última escritura pero sin perder ítems; agregar el mismo ítem dos veces casi seguido se fusiona o se avisa.
- Sin conexión: usa la cola existente src/lib/offline/outbox.ts para agregar y marcar ítems en el súper sin señal, y sincroniza al volver.

Web y móvil
- Móvil: pantalla completa por lista, ítems de 48 px, deslizar a la izquierda para borrar y a la derecha para marcar, mantener pulsado para editar o reordenar, háptico al marcar, y la lista no salta cuando otro agrega algo en vivo. El campo de agregar queda cerca del pulgar para usarla con una mano en el súper.
- Escritorio: panel de listas a la izquierda y la lista abierta a la derecha, atajos (Enter agrega, Espacio marca, Supr borra), arrastrar con mouse y edición en línea con doble click.
```

## Prompt 6: Tareas recurrentes y turnos rotativos
```
Proyecto Loki (ver el contexto compartido). Queremos tareas que se repiten (sacar la basura cada martes, pagar la luz el 5 de cada mes, el reporte semanal del equipo) y turnos que rotan entre los miembros del espacio (esta semana lava la loza Sofi, la próxima Tomás), con recordatorios push.

Comportamiento
- Desde la hoja de tarea (src/components/projects/task-sheet.tsx) se activa "Repetir": diario, semanal (qué días), mensual (día del mes o "primer lunes"), cada N días o semanas, con fecha de término opcional. Desde ahí también "Turno rotativo": se eligen los miembros y el orden, y cada ocurrencia se asigna al siguiente.
- Modelo: una serie (plantilla) genera ocurrencias como tareas normales en tasks, para que el kanban, Inicio, la búsqueda y los recordatorios existentes sigan funcionando sin cambios. La siguiente ocurrencia se genera cuando se completa la actual o cuando llega su momento, lo que pase primero, sin crear cientos de tareas futuras. La generación es SQL barato (trigger al completar + barrido con pg_cron, igual que create_due_reminders), sin LLM.
- Turnos: intercambiar ("¿me cambias el turno?", con aceptación del otro), saltar a alguien (vacaciones con rango de fechas), reordenar, y ver la rotación de las próximas semanas en una vista simple "Turnos" del espacio. Si un miembro sale del espacio, se quita de la rotación y se avisa al creador.
- Recordatorios: aviso el día antes y a la hora configurada al responsable de turno (tipo de notificación de turnos del prompt 1), aviso al siguiente cuando le toque y un recordatorio amable si quedó sin hacer. push-send ya respeta preferencias y horario de silencio.
- Editar una serie: "solo esta" o "esta y las siguientes", como en un calendario. Borrar, igual.
- Loki: crear series y turnos con lenguaje natural ("cada domingo alguien distinto riega las plantas: Sofi, Tomás y yo"), usando el analizador determinista para la recurrencia y el plan de acciones del prompt 3. "¿A quién le toca la loza?" se responde sin LLM cuando se puede.
- En Inicio: "Te toca hoy"; en el calendario, las ocurrencias próximas se ven como marcas discretas.

Datos (ideas)
- Tabla de series (workspace_id, project_id con la Bandeja por defecto, plantilla de título/notas/prioridad, regla de recurrencia simple y acotada, zona horaria con default America/Santiago, orden de rotación uuid[], índice actual, pausas y excepciones, activa, created_by) y en tasks una referencia a la serie y el número de ocurrencia (migración nueva). Tabla de solicitudes de intercambio con estado.
- Fechas calculadas con el horario de verano de Chile bien hecho (no repetir el error del resumen diario actual, programado a 12:00 UTC fijo).

Permisos
- Crear y editar series: cada miembro las suyas; un admin, todas. Un intercambio solo lo resuelven los dos involucrados. RLS por membresía y tests.

Web y móvil
- Selector de recurrencia compacto con chips (L M M J V S D) usable con el pulgar; en escritorio, un popover junto al campo de fecha.
- Vista Turnos: en móvil, lista por semana con avatares; en escritorio, grilla semanas × tareas.
- La push de turno abre directo la tarea, con acción "Hecho" desde la notificación si push-send y el canal de Android lo permiten (si no, el toque abre la tarea).
```

## Prompt 7: Encuestas y decisiones rápidas en el chat
```
Proyecto Loki (ver el contexto compartido). Queremos decidir rápido en grupo sin 40 mensajes: "¿pizza o sushi?", "¿qué día hacemos el asado?", "¿aprobamos el diseño?". Encuestas dentro del chat, con la opción de cruzar las fechas propuestas con la disponibilidad del calendario.

Experiencia
- Crear: desde el menú + del composer (src/components/chat/attach-menu.tsx suma "Encuesta"), desde Acciones rápidas o pidiéndoselo a Loki ("haz una encuesta para elegir el día del asado entre viernes y sábado"). Tipos: opción única, múltiple, sí/no rápido y "elegir fecha" (opciones con fecha y hora). Ajustes: anónima o no, permitir que otros agreguen opciones, fecha de cierre y quién puede cerrar.
- Ver y votar: la encuesta es un mensaje 'card' (meta del prompt 1) con barras que se actualizan en vivo, avatares de quién votó (si no es anónima), quién falta por votar y la posibilidad de cambiar el voto mientras siga abierta. Los comentarios son el hilo del mensaje (ya existe thread_parent_id).
- Encuestas de fecha con disponibilidad: cada opción muestra cuántos miembros ya tienen algo agendado en events a esa hora ("2 ocupados"), sin mostrar el detalle de los eventos (solo ocupado/libre). Es una consulta SQL, no IA. Los eventos importados de Google (external_source = 'google') cuentan igual.
- Cerrar: al vencer o a mano. El resultado queda fijado en la tarjeta; un empate se muestra como empate y decide quien la creó. Si es de fecha, botón "Crear evento" con la opción ganadora prellenada (event-dialog) y los votantes como invitados. Si es un sí/no de aprobación, opción de crear una tarea con el resultado.
- Recordatorio opcional a quienes no han votado antes del cierre (una sola notificación, tipo encuestas del prompt 1). El cierre por tiempo lo hace SQL barato (pg_cron, o al leer), sin LLM.
- Bajo pedido, Loki resume el resultado y las opiniones del hilo (modelo barato, cuota del espacio).

Datos (ideas)
- polls (message_id, workspace_id, chat_id, question, kind, settings, closes_at, closed_at, created_by), poll_options (texto o rango de fecha, position, added_by) y poll_votes (único por usuario y opción; en opción única, uno por usuario). Realtime en los votos. En las anónimas, los conteos se leen con una RPC que no expone user_id (la RLS no debe dejar ver quién votó).

Permisos
- Vota quien puede ver el chat (can_access_chat). Cierra o edita el creador o un admin. No se puede votar en encuestas cerradas ni de chats ajenos. Tests RLS, incluido el caso anónimo.

Web y móvil
- Móvil: votar tocando toda la fila, háptico, crear en hoja inferior agregando opciones con el Enter del teclado, selector de fecha nativo.
- Escritorio: crear en diálogo, el hover muestra quién votó cada opción, navegación de opciones con teclado.
- La push "falta tu voto" abre el chat justo en la encuesta.
```

## Prompt 8: Notas de voz que se vuelven acción
```
Proyecto Loki (ver el contexto compartido). Queremos hablarle a Loki y que lo dicho se convierta en cosas: "comprar pan, leche y detergente, y recuérdame llamar al doctor mañana a las 10" → ítems en la lista del súper + un recordatorio. También transcribir las notas de voz del chat para leerlas y buscarlas.

Estado actual que hay que revisar primero
- El README dice que la UI de adjuntos está deshabilitada, pero en el código el composer ya ofrece foto/video, cámara, archivo y nota de voz y sube a Storage (src/components/chat/composer.tsx, src/lib/media/upload.ts, src/lib/media/audio.ts, src/components/media/voice-recorder.tsx y voice-message.tsx; buckets privados chat-media y post-media con RLS por espacio en 20260930000002_storage.sql). Revisa qué funciona de verdad de punta a punta, termina lo que falte en vez de rehacerlo y deja el README coherente con la realidad.

Qué queremos
1. Transcripción. Cada nota de voz tiene "Ver transcripción". Por defecto se transcribe bajo demanda (cuando alguien la abre) para no gastar; en el chat Loki IA y en el botón "voz a acción" se transcribe siempre. Se encola un trabajo (prompt 2) y una Edge Function descarga el audio con permisos de servidor, lo manda a un proveedor de voz a texto configurable y guarda el texto (tabla de transcripciones por archivo, con idioma, duración y estado). El proveedor va por secretos nuevos (por ejemplo STT_PROVIDER, STT_MODEL, STT_API_KEY, STT_BASE_URL) y debe soportar al menos un endpoint de transcripción compatible con OpenAI y Gemini con entrada de audio. Revisa la documentación oficial vigente de cada proveedor antes de implementar; no inventes parámetros. Sin config: "Transcripción sin configurar", sin errores.
2. Voz a acción. Un botón de micrófono en el chat Loki IA y en Acciones rápidas ("Dictar a Loki"): grabas, se transcribe y el texto entra al mismo flujo del prompt 3 (analizador determinista primero, modelo después), que devuelve una tarjeta de plan con varias acciones (ítems de lista del prompt 5, recordatorios en la Bandeja, eventos, tareas, avisos) para revisar y confirmar. La transcripción se muestra siempre encima del plan para corregir errores de dictado antes de confirmar.
3. En chats de grupo, sobre una nota de voz: "Convertir en…" (prompt 4) usa la transcripción como texto.
4. Las transcripciones quedan indexadas para la búsqueda universal (prompt 10).

Web y móvil
- Android: el micrófono dentro de la WebView de Capacitor necesita el permiso RECORD_AUDIO en android/app/src/main/AndroidManifest.xml y su petición en tiempo de ejecución. Asegúrate de que getUserMedia funcione dentro de la app (revisa cómo Capacitor 8 concede permisos a la WebView y, si hace falta, pide el permiso con un plugin oficial). Si el usuario lo niega, mensaje claro con cómo activarlo en Ajustes. Mantener para grabar, deslizar para cancelar y háptico al empezar y al terminar (voice-recorder.tsx ya tiene la base).
- Web: MediaRecorder con el mimeType que soporte cada navegador (webm/opus en Chrome, mp4 en Safari); en escritorio, click para empezar y parar además de mantener, y un atajo de teclado en Loki IA. Si el navegador no permite el micrófono (http sin TLS, permisos), alternativa: subir un archivo de audio.
- Límites amables de duración y tamaño (upload.ts ya pone 10 MB para audio), indicador de grabación visible, y la grabación se corta si la app pasa a segundo plano.

Seguridad y privacidad
- La Edge Function verifica que quien pide la transcripción es miembro del espacio del archivo (ruta {workspace_id}/...). El audio no se manda al proveedor si el espacio llegó a su límite. Ninguna clave en el cliente. Las transcripciones heredan la visibilidad del mensaje (las de un DM, solo para sus miembros).
```

## Prompt 9: Memoria del espacio
```
Proyecto Loki (ver el contexto compartido). Queremos que Loki recuerde datos útiles de cada espacio y los use al responder: "la clave del wifi es…", "Tomás es alérgico al maní", "el pediatra es el Dr. Rojas, +56…", "el cliente prefiere reuniones los martes". Que la familia o el equipo pregunte "¿cuál era la clave del wifi?" y Loki responda.

Comportamiento
- Guardar explícito: "Loki, recuerda que…" (detectado sin LLM), la opción "Recordar en el espacio" del menú de un mensaje, o a mano desde una pantalla "Memoria" del espacio (en Configuración o en el panel del espacio).
- Sugerencias: cuando Loki ya está procesando algo por otra razón (un resumen de no leídos, una mención) puede proponer "¿Guardo esto en la memoria del espacio?" con una tarjeta; nunca guarda en silencio. Nada de leer todo el chat de fondo para sacar recuerdos: solo se analiza lo que ya pasó por Loki o lo que el usuario marca.
- Usar: loki-chat consulta la memoria antes de responder preguntas sobre el espacio (herramientas tipo remember y recall). Primero búsqueda full-text en español (como global_search, sin costo de IA); si el entorno tiene pgvector se puede sumar búsqueda semántica opcional, pero no es requisito. Las respuestas citan el recuerdo y quién lo guardó.
- Gestionar: lista de recuerdos con categoría (salud, casa, contactos, trabajo, otros), quién lo guardó y cuándo, fijar, editar, borrar y fecha de caducidad opcional ("el código del portón cambia en marzo").
- Sensibles: un recuerdo marcado como sensible (claves, datos de salud) no aparece en previews ni en push, se muestra oculto con "Mostrar", y Loki solo lo revela a quien lo pide dentro del espacio, nunca en un resumen diario.

Datos y permisos (ideas)
- Tabla space_memories (workspace_id, content, category, sensitive, pinned, source_message_id, created_by, expires_at, timestamps, índice GIN en español). RLS: los miembros leen; cualquier miembro crea; edita o borra quien lo creó o un admin. Si encaja sin complicar, recuerdos personales (solo yo) dentro del espacio. Tests RLS.
- Un recuerdo que sale de un DM no se vuelve visible para todo el espacio sin que quien lo guarda lo confirme explícitamente.

Web y móvil
- Pantalla Memoria: lista con buscador arriba; en móvil, deslizar para borrar y mantener pulsado para editar; en escritorio, edición en línea y acciones al hover.
- Mostrar un recuerdo sensible pide una confirmación simple y se vuelve a ocultar al salir; en Android, si es fácil, evita que se vea en la vista previa de apps recientes, sin romper la web.
```

## Prompt 10: Búsqueda universal (mensajes, tareas, eventos, archivos y más)
```
Proyecto Loki (ver el contexto compartido). Ya existe la búsqueda Cmd/Ctrl+K (src/components/search/search-palette.tsx, src/stores/search-store.ts, src/lib/data/search.ts) con la RPC global_search (20260930000003_search.sql), que devuelve mensajes, tareas, proyectos, eventos y personas con full-text en español, unaccent y pg_trgm. Queremos que encuentre TODO lo que se guarda en Loki.

Qué queremos
- Grupos nuevos: listas e ítems (prompt 5), encuestas (prompt 7), recuerdos del espacio (prompt 9, respetando los sensibles), ideas, archivos e imágenes adjuntos por nombre, transcripciones de notas de voz (prompt 8) y, si es viable, el texto dentro de las imágenes.
- Texto en imágenes (OCR), por eventos y opcional: al subir una imagen se puede encolar un trabajo (prompt 2) que extrae el texto con el modelo de visión del proveedor configurado (o un servicio de OCR configurable) y lo guarda indexado. Solo si está configurado y hay cuota; nunca bloquea el envío; sin config, las imágenes se encuentran solo por nombre. Agrega una opción por espacio para activarlo o no (cuesta).
- Índice de adjuntos: hoy los adjuntos viven en messages.attachments (jsonb). Crea un índice consultable (tabla alimentada por trigger al insertar o editar mensajes, con nombre, tipo, tamaño, ruta, mensaje, chat, espacio y texto extraído) para no recorrer jsonb en cada búsqueda.
- Filtros: por tipo (chips), por persona ("de: Sofi"), por chat, por rango de fechas ("la semana pasada") con una sintaxis simple que entienda el analizador determinista, y "solo míos".
- Resultados útiles: cada resultado abre exactamente en su lugar (mensaje resaltado en su chat, tarea abierta en su hoja, archivo en el visor attachment-viewer.tsx, ítem dentro de su lista), con el fragmento resaltado y contexto.
- Preguntar a Loki (opcional): un botón "Preguntar a Loki" al final de la paleta convierte la búsqueda en pregunta y Loki responde usando los mejores resultados como contexto (modelo barato, cuota del espacio). Nunca automático mientras se escribe.
- Rendimiento: debounce, límite por grupo, "ver más" paginado y ninguna consulta con menos de 2 caracteres (como hoy).

Seguridad
- La RPC sigue siendo la puerta: solo espacios donde eres miembro y chats que can_access_chat permite (los DMs ajenos quedan fuera, con sus archivos, transcripciones y OCR). Amplía los tests RLS de búsqueda para los grupos nuevos y los recuerdos sensibles.

Web y móvil
- Escritorio: paleta Cmd/Ctrl+K manejable entera con teclado (flechas, Enter, Tab entre grupos, Escape).
- Móvil: la lupa del header móvil (src/components/shell/mobile-header.tsx) abre una pantalla de búsqueda completa con chips de filtro desplazables, resultados grandes fáciles de tocar y el teclado del sistema con botón "Buscar"; el botón atrás de Android cierra la búsqueda.
- Búsquedas recientes y sugerencias en ambos.
```

## Prompt 11: Resumen diario (push de la mañana y vista "Tu día")
```
Proyecto Loki (ver el contexto compartido). Queremos que cada mañana llegue una push con tu día y que al tocarla se abra una vista "Tu día" con los eventos de hoy, las tareas que vencen, los turnos que te tocan, las listas pendientes, las encuestas por votar y lo destacado de tus espacios.

Estado actual que se reemplaza
- Existe create_ai_daily_digest() en 20260930000001_ai_tools.sql con el pg_cron 'loki-ai-daily-8am' a las 12:00 UTC: texto fijo genérico, igual para todos, y la hora se corre con el horario de verano de Chile. En una migración nueva, desprograma ese job y reemplázalo por lo de abajo (sin editar la migración vieja).

Comportamiento
- Preferencias por usuario (Configuración → Notificaciones → Resumen diario): activado sí/no, hora (default 8:00), zona horaria (default America/Santiago, detectada del dispositivo y editable), días (todos o solo hábiles) y qué espacios incluir.
- Generación por eventos y barata: un job SQL liviano (pg_cron cada 15 min, sin LLM) busca a los usuarios cuya hora local ya llegó y que aún no tienen resumen hoy, arma los datos con consultas (eventos de hoy, tareas por vencer o atrasadas, turnos del prompt 6, listas fijadas con pendientes del prompt 5, encuestas abiertas sin tu voto del prompt 7) y crea la notificación del tipo resumen diario (prompt 1) con texto concreto: "Hoy: 3 eventos (el primero, 9:30 Dentista), vencen 2 tareas y te toca la basura". Si no hay nada, no se manda push (o un texto breve, según la preferencia). Idempotente con dedupe por usuario y día local.
- Destacados con IA bajo demanda: "lo importante de tus espacios" (mensajes destacados, decisiones, menciones a ti) NO se genera para todos a las 8:00. Se genera cuando el usuario abre "Tu día" (o toca la push), con el modelo barato, cacheado por día y consumiendo la cuota de su espacio. Sin clave o sin cuota, la vista muestra igual todo lo determinista y una nota "Destacados con IA no disponibles".
- Vista "Tu día": accesible desde la push, desde Inicio (tarjeta "Tu día" arriba) y desde Loki ("¿cómo viene mi día?", con get_today_summary ampliado). Secciones con acciones directas: completar tarea, abrir evento, marcar ítem, votar. Por el export estático, usa una ruta propia o un query param (por ejemplo /inicio?vista=dia), coherente con los deep links del prompt 1.
- Respeta el horario de silencio y el interruptor del tipo (push-send ya lo hace) y no se duplica con los recordatorios de create_due_reminders del mismo momento.

Web y móvil
- Android: la push nativa llega a la hora local correcta y al tocarla abre "Tu día" aunque la app esté cerrada (deep link). Texto corto que se lea entero en la notificación expandida.
- Web: push web si está configurada; si no, la tarjeta "Tu día" de Inicio cumple la función y la bandeja de notificaciones guarda el resumen.
- Móvil en una columna con secciones plegables; escritorio en dos columnas (agenda a la izquierda; tareas, listas y destacados a la derecha), y el right-panel de Inicio muestra el resumen compacto.

Casos borde
- Usuario en varios espacios: un solo resumen agrupado por espacio. Cambio de horario de verano: la hora local se mantiene. Miembro nuevo sin datos: bienvenida breve o nada.
```

## Prompt 12: Agentes personales: registro, permisos y contrato
```
Proyecto Loki (ver el contexto compartido). Etapa 2. Queremos que cada miembro de un espacio pueda conectar SU propio agente de IA personal (por ejemplo un bot de Grok Bot, donde cada bot tiene su propia computadora en la nube, o Hermes Agent, u otros) e invocarlo desde el chat de Loki con una mención como @mi-bot. Este prompt construye la capa genérica: registro de agentes, permisos, contrato y seguridad. El prompt 13 lo conecta al chat y a los proveedores.

Idea central: una capa de "conectores de agentes" con UN contrato propio de Loki. Loki manda una tarea al agente; el agente devuelve eventos de progreso y un resultado final. Cada proveedor tiene un adaptador que traduce ese contrato a lo que el proveedor entiende. Diseñalo para que sea compatible con estándares abiertos cuando se pueda: el ciclo de tareas de A2A (Agent2Agent: tarea, estados, mensajes, artefactos) encaja con este contrato, y más adelante Loki podría exponer sus acciones como herramientas MCP para que los agentes lean contexto o creen tareas. Revisa las especificaciones oficiales vigentes de A2A y MCP antes de fijar nombres de campos; no inventes.

Contrato (defínelo y documéntalo en docs/AGENTES.md)
- Tarea saliente: id de ejecución, agente, espacio, chat, quién la pidió, texto de la orden, contexto permitido (mensajes recientes del chat solo si el permiso lo autoriza, recortados), URL de retorno y token de la ejecución, y fecha límite.
- Eventos entrantes: progreso (texto corto y porcentaje opcional), pedido de aclaración o confirmación al usuario, resultado final (texto, adjuntos o enlaces, y acciones propuestas para Loki como "crear tarea", que pasan por la tarjeta de confirmación del prompt 3) o error.
- Estados: queued, dispatched, running, needs_input, done, error, cancelled, expired.

Datos (ideas; migración nueva con RLS y tests)
- agent_connections: dueño (user_id), proveedor (generic_webhook, grokbot, hermes, a2a…), nombre visible y handle para mencionar (único dentro de cada espacio donde esté habilitado, sin chocar con miembros ni con @Loki), descripción, avatar o emoji, configuración del proveedor (URL de disparo, etc.), secreto saliente cifrado (mismo enfoque que google-calendar: AES-GCM con una clave del servidor tipo AGENT_TOKEN_KEY en supabase/functions/.env), hash del token entrante (el token en claro se muestra UNA sola vez), estado (activo, pausado, error) y último uso.
- agent_space_grants: en qué espacios está habilitado y con qué permisos: quién puede invocarlo (solo yo, o también miembros que yo elija), si puede leer contexto del chat y cuántos mensajes, si puede publicar en el chat, si puede proponer acciones (crear tareas o eventos) y sus propios límites de uso.
- agent_runs y agent_run_events: cada ejecución y su historial de eventos, en Realtime para ver el progreso en vivo.
- Los admins del espacio pueden desactivar cualquier agente dentro de su espacio (gobernanza), pero no ver sus secretos ni reconfigurarlo.

UI: Configuración → "Mis agentes"
- Conectar agente: elegir proveedor, nombre y handle, pegar la URL o los datos del proveedor, generar el token entrante (se copia una vez; regenerarlo invalida el anterior), elegir espacios y permisos, y "Probar conexión" (manda una tarea de prueba y espera el retorno, con estado visible).
- Lista de mis agentes con estado, espacios, último uso, pausar, editar y borrar. En cada espacio, una vista "Agentes en este espacio" (de quién es cada uno y quién puede usarlo).
- Explicación clara en español de qué datos ve el agente y de que el agente es responsabilidad de su dueño.

Seguridad
- Los secretos nunca vuelven al cliente (tampoco al dueño, una vez guardados). Tokens entrantes solo como hash. Toda llamada saliente sale de Edge Functions, nunca del navegador. Contexto mínimo: nada de DMs, salvo que se invoque dentro de ese DM y el dueño lo permita. Auditoría: cada ejecución queda registrada con quién la pidió.

Web y móvil
- Formularios de conexión cómodos en móvil (pegar URL y token, copiar con un toque, compartir con Web Share o Capacitor Share) y en escritorio (diálogo amplio). El token se copia con confirmación visual.
```

## Prompt 13: Agentes en el chat: menciones, ejecución por eventos y adaptadores
```
Proyecto Loki (ver el contexto compartido). Sobre la capa de agentes del prompt 12, queremos poder escribir en cualquier chat "@mi-bot revisa el presupuesto adjunto y dime qué falta" y ver el progreso y el resultado del agente dentro del chat, sin que nada quede esperando 24/7.

Flujo por eventos (obligatorio)
1. El usuario menciona a un agente. El composer ya tiene menciones (src/lib/chat/mentions.ts, candidatos @Loki + miembros): suma como candidatos los agentes habilitados en ese espacio, con distintivo de bot y su dueño ("mi-bot · de Manu"). Solo aparecen los que el usuario puede invocar. Amplía tests/mentions.test.mjs con el caso de agentes.
2. Al enviar se inserta el mensaje normal y una fila en agent_runs (queued). Un trigger con pg_net despierta la Edge Function de despacho (por ejemplo agent-dispatch, mismo patrón de settings que maybe_push_notification). Esta valida permisos y cuota, arma el contexto permitido, llama al adaptador del proveedor, marca dispatched y termina. No queda nada vivo esperando.
3. El agente trabaja en su propia infraestructura y le reporta a Loki llamando a una Edge Function de retorno (por ejemplo agent-callback) con el token de esa ejecución (o el token del agente + el id de ejecución). La función valida el token contra el hash y el estado, guarda el evento en agent_run_events y, si corresponde, publica en el chat como mensaje 'agent' (service role) o actualiza la tarjeta de progreso. Las acciones que propone el agente (crear tarea, evento) aparecen como tarjeta de confirmación para el usuario (la del prompt 3): el agente nunca escribe datos de Loki directo.
4. Si el agente no responde antes de la fecha límite, un barrido SQL barato marca expired y avisa en el chat. Cancelar desde la tarjeta marca cancelled e intenta avisarle al proveedor si el adaptador lo soporta.

Experiencia en el chat
- Tarjeta de ejecución bajo el mensaje: "mi-bot está trabajando…" con los eventos de progreso en vivo (Realtime sobre agent_run_events), botón Cancelar y, al terminar, el resultado formateado con safe-text (enlaces solo http/https), adjuntos y acciones propuestas. Si el agente pide aclaración (needs_input), quien lo invocó responde en el hilo y eso viaja como continuación.
- Notificación a quien lo invocó cuando termina (tipo agentes del prompt 1), útil si cerró la app.
- Los demás miembros ven la respuesta solo si el permiso "publicar en el chat" está activo; si no, es privada para quien lo invocó.

Adaptadores (registro extensible; los detalles de cada proveedor son configurables, no fijos en el código)
- Webhook genérico: POST firmado (HMAC con el secreto saliente) a la URL configurada, con la tarea en el contrato de Loki; el agente responde a agent-callback. Es el adaptador de referencia.
- Grok Bot: según lo que sabemos, sus rutinas se pueden disparar con un webhook. NO está verificado que Grok Bot tenga una forma oficial de mandar resultados de vuelta a una app externa. Diseña el adaptador así: disparar la rutina por su webhook mandando la tarea, la URL de agent-callback y el token de la ejecución en el cuerpo, y como retorno usar el fallback de que el propio bot haga un POST a agent-callback (las instrucciones de la rutina se lo indican). Si la documentación oficial de Grok Bot ofrece un canal de retorno o de estado, úsalo además. Revisa la documentación oficial vigente antes de implementar y deja todo (URL, cabeceras, formato) configurable desde la conexión; no inventes endpoints ni campos.
- Hermes Agent: no inventes su API. Deja un adaptador que use el webhook genérico o A2A, según indique su documentación oficial, con los campos configurables, y anota en docs/AGENTES.md qué hay que verificar.
- A2A: si el agente expone A2A, mapear la tarea de Loki a una tarea A2A y sus actualizaciones de estado a agent_run_events (según la especificación vigente).
- En docs/AGENTES.md, un ejemplo mínimo de cómo un desarrollador conecta su propio agente al webhook genérico (qué recibe, cómo verifica la firma, cómo responde a agent-callback).

Costo y límites
- Invocar un agente externo no gasta tokens de Loki salvo el armado del contexto (código) y, opcionalmente, un resumen del resultado con el modelo barato. Límites de ejecuciones por agente, por usuario y por espacio, visibles en Uso de IA (prompt 2). Protección contra bucles: un agente no puede mencionar a otro agente ni a sí mismo para disparar ejecuciones en cadena.

Seguridad
- agent-callback valida token, tamaño máximo, tipos de evento permitidos, idempotencia por id de evento y rate limit, y nunca confía en el contenido (es texto de un tercero: se muestra como texto, jamás se ejecuta). La URL saliente no puede apuntar a direcciones internas (bloquea localhost y redes privadas, salvo un modo de desarrollo explícito).

Web y móvil
- El autocompletado de @ con agentes funciona con el teclado de escritorio y con el teclado virtual de Android sin tapar la lista.
- La tarjeta de progreso es compacta en móvil (una línea con el último evento y "ver más" en hoja inferior) y extendida en escritorio (línea de tiempo en el panel de hilo, thread-panel.tsx).
```

## Prompt 14: Control del PC (1/2): emparejamiento, permisos, comandos y auditoría en Loki
```
Proyecto Loki (ver el contexto compartido). Etapa 3. Queremos que desde el chat de Loki (web o teléfono) el usuario pueda ordenar acciones en SU propio PC y recibir el resultado, a través de un compañero de escritorio liviano (Windows primero) que se conecta hacia afuera a Supabase Realtime y espera comandos: sin puertos abiertos en el PC y sin gastar tokens mientras está inactivo. Este prompt construye todo el lado de Loki (base, Edge Functions, UI y seguridad). El prompt 15 construye la app de escritorio.

Emparejamiento fuerte
- En Loki: Configuración → "Mis dispositivos" → "Vincular un PC" muestra un código corto de un solo uso (y QR) que vence en pocos minutos. En el compañero de escritorio se ingresa el código; una Edge Function (por ejemplo device-pair) lo canjea y le entrega al dispositivo una credencial propia (secreto largo, guardado en la base solo como hash) con la que obtiene tokens de corta duración. El dispositivo nunca usa la contraseña ni la sesión del usuario.
- Para que el dispositivo escuche por Realtime con RLS, elige y documenta el mecanismo más seguro que soporte la versión de Supabase del proyecto (por ejemplo, la Edge Function emite tokens de acceso de corta duración limitados a ese dispositivo, y la RLS o Realtime Authorization solo le deja leer sus propios comandos en un canal privado). Revisa la documentación oficial vigente de Supabase Realtime Authorization y de tokens antes de decidir. Nunca le des al dispositivo la service_role ni el secreto JWT.
- Revocar un dispositivo invalida su credencial al instante; el compañero lo detecta y vuelve a la pantalla de vinculación. Se ve el último contacto, la versión y el sistema.

Comandos (catálogo cerrado, no texto libre ejecutado a ciegas)
- Tabla device_commands: quién lo pidió, desde qué chat, tipo de acción del catálogo, parámetros validados, nivel de riesgo, estado (pending_confirmation, queued, delivered, running, done, error, rejected, expired), resultado (texto, archivo subido a Storage con RLS del usuario, captura de pantalla) y timestamps. Realtime para que el PC reciba y la app vea el estado.
- Catálogo inicial sugerido: estado del PC (batería, uso, encendido), abrir una app o URL, buscar archivos por nombre en carpetas permitidas, mandar un archivo del PC al chat, captura de pantalla, bloquear pantalla, volumen y multimedia, y ejecutar un script de una lista que el usuario registró en el PC. Comandos arbitrarios de terminal: solo si el usuario los habilita explícitamente en ese dispositivo, y siempre con confirmación.
- Lenguaje natural: en el chat, "@mi-pc abre Spotify" o pedírselo a Loki ("toma una captura de mi PC"). El analizador determinista resuelve lo simple; si no, el modelo barato lo traduce a un comando del catálogo y se muestra la tarjeta con lo que se va a ejecutar. El LLM nunca corre en el PC ni mientras está inactivo.

Confirmación en el teléfono para lo sensible
- Cada tipo de acción tiene un nivel de riesgo. Las sensibles (borrar, enviar algo a terceros, comprar, ejecutar comandos arbitrarios, mover archivos fuera de carpetas permitidas) quedan en pending_confirmation y generan una push (tipo dispositivos del prompt 1) a los teléfonos del usuario; al tocarla se abre una pantalla con el detalle exacto y los botones Aprobar y Rechazar. Aunque la orden venga desde la web, lo sensible se aprueba en el teléfono (si el usuario no tiene la app Android, define un fallback seguro, por ejemplo confirmar en la web volviendo a autenticarse, y documéntalo). Las confirmaciones vencen en pocos minutos.
- El compañero de escritorio vuelve a comprobar el nivel de riesgo y que exista la confirmación antes de ejecutar (doble control: no confía solo en la app).

Permisos por dispositivo y auditoría
- Por dispositivo: qué acciones del catálogo están habilitadas, qué carpetas se pueden leer, si puede mandar archivos al chat, y desde qué espacios o chats se le puede ordenar (por defecto, solo desde el chat privado Loki IA y los DMs del dueño; en grupos, nadie más que el dueño puede ordenar nada a su PC).
- Registro de auditoría inmutable (solo inserción): quién, qué, cuándo, desde dónde, confirmación y resultado. Pantalla de historial por dispositivo con filtros.

Web y móvil
- "Mis dispositivos" y el historial funcionan en web y móvil. La pantalla de aprobación en Android se lee rápido: acción en grande, detalle debajo, Aprobar/Rechazar a la altura del pulgar, háptico, y se abre desde la push con la app cerrada.
- En web y en escritorio, la tarjeta del comando en el chat muestra el estado en vivo y el resultado (las capturas, en el visor existente).

Seguridad adicional
- Límite de comandos por minuto, expiración de comandos no entregados, ningún dato del PC en la push (solo "Tu PC necesita tu aprobación"), resultados grandes a Storage en vez de al mensaje. Tests RLS: un usuario no ve ni manda órdenes a dispositivos ajenos; un dispositivo solo ve sus comandos.
```

## Prompt 15: Control del PC (2/2): compañero de escritorio para Windows
```
Proyecto Loki (ver el contexto compartido). Sobre lo construido en el prompt 14 (emparejamiento, device_commands, confirmaciones y auditoría), construye el compañero de escritorio: una app liviana para Windows (primero) que vive en la bandeja del sistema, arranca con Windows, se conecta hacia afuera a Supabase Realtime y ejecuta los comandos del catálogo.

Ubicación y tecnología
- En una carpeta propia del repo (por ejemplo desktop/) con su propio package o manifiesto, que NO forme parte del build de Next ni del tsconfig/eslint de la raíz (exclúyela explícitamente para no romper los scripts actuales).
- Elige una tecnología liviana y justifícala en desktop/README.md. Recomendación: Tauri 2 (bandeja, autoarranque, actualizaciones, binario chico) o un servicio .NET con ícono de bandeja; evita algo pesado si no aporta. Debe poder llevarse a macOS o Linux más adelante sin rehacer el protocolo.

Comportamiento
- Primera vez: ventana pequeña "Vincular con Loki" donde se pega el código del prompt 14; la credencial del dispositivo se guarda en el almacén seguro del sistema (Windows Credential Manager / DPAPI), nunca en texto plano.
- En reposo: una sola conexión saliente (WebSocket de Realtime) suscrita a sus comandos; sin consultas periódicas a la API, sin LLM, con consumo mínimo de CPU y RAM. Renueva su token de corta duración antes de que venza y se reconecta con backoff si se cae la red o el PC vuelve de suspensión; al reconectar recoge los comandos pendientes que no hayan expirado.
- Al recibir un comando: valida que esté en el catálogo y habilitado localmente, revisa que tenga la confirmación requerida, lo ejecuta, informa progreso y resultado (estado en device_commands; archivos y capturas a Storage) y lo anota en un log local rotativo. Lo que no entiende o no tiene habilitado lo rechaza con el motivo.
- Ícono de bandeja con estado (conectado, desconectado, ejecutando) y menú: pausar (no acepta comandos), actividad reciente, permisos locales (qué acciones y carpetas permite este PC; deben coincidir con lo configurado en Loki y siempre gana lo más restrictivo), desvincular y salir.
- Aviso visible en el PC cada vez que se ejecuta algo (notificación del sistema, por ejemplo "Loki: tomando una captura pedida desde tu teléfono"), para que nada pase a escondidas.
- Scripts registrados: el usuario agrega en la app de escritorio scripts con nombre (ruta fija) que después puede invocar desde Loki por su nombre; Loki nunca envía el contenido de un script.

Seguridad
- Nada de puertos abiertos ni servidor local. Corre sin privilegios de administrador. Valida las rutas para que no salgan de las carpetas permitidas (ojo con .., enlaces simbólicos y rutas UNC). Los comandos arbitrarios, si están habilitados, corren con tiempo límite y salida truncada. Si la credencial se revoca desde Loki, la app lo respeta al instante.
- Firma del ejecutable e instalador: documentada como pendiente para el lanzamiento (no publicar nada ahora).

Integración con Loki (web y móvil)
- Desde el chat en el teléfono o en la web, la tarjeta del comando muestra el progreso y el resultado en vivo, y la aprobación de lo sensible llega al teléfono (prompt 14). El flujo completo tiene que funcionar desde Android y desde un navegador de escritorio.
- Documenta en desktop/README.md cómo correrla en desarrollo contra Supabase local y cómo empaquetarla, y en docs/ el protocolo dispositivo ↔ Loki.
```

## Prompt 16 (final): Verificación y regresión completa (web + Android)
```
Proyecto Loki (ver el contexto compartido). Este es el ÚNICO prompt de verificación: los anteriores implementaron sin compilar ni testear. Ahora hay que dejar todo en verde sin romper nada y revisar a mano en web y en Android. Corrige lo que falle con cambios mínimos y coherentes con el código existente; si una función quedó a medias, termínala o déjala desactivada con un aviso claro en español, nunca rota.

1. Base de datos
- Supabase local arriba (npm run sb:start; npm run sb:status). npm run sb:reset debe aplicar TODAS las migraciones en orden (las 8 originales y las nuevas) sin errores. Comprueba que ninguna migración anterior fue editada (git diff de esos archivos vacío) y que lo que depende del entorno (pg_cron, pg_net, extensiones) no rompe el reset.
- Comprueba que el job viejo 'loki-ai-daily-8am' quedó reemplazado y que no hay jobs de pg_cron duplicados.

2. Chequeos automáticos (todos deben terminar en 0)
- npm run typecheck
- npm run lint
- npm run test:unit (incluye los tests nuevos del analizador de fechas y de menciones con agentes)
- npm run test:rls (incluye los tests nuevos: Bandeja, meta de mensajes, cola de trabajos, uso por espacio, listas, series y turnos, encuestas con el caso anónimo, memoria y sensibles, búsqueda ampliada, agentes, dispositivos y comandos)
- Apaga npm run dev antes de compilar (comparten .next). npm run build
- npm run build:capacitor
- Edge Functions: npm run sb:functions levanta todas (loki-chat, push-send, google-calendar y las nuevas: trabajadora, transcripción si quedó aparte, agent-dispatch, agent-callback, device-pair y las que hayan surgido) sin errores de bundle; GET /health de loki-chat responde configured true/false sin exponer claves.
- Compañero de escritorio (desktop/): compila con su propia herramienta según su README y no afecta los scripts de la raíz.
- Revisa el diff buscando secretos (claves, tokens, service_role en NEXT_PUBLIC_, archivos .env o google-services.json agregados al repo) y que los .env.example de la raíz y de supabase/functions documenten todos los secretos nuevos sin valores.

3. Revisión manual en web (escritorio y ventana angosta tipo móvil)
- Sin LLM_API_KEY: todo carga, los lugares con IA dicen "Loki IA sin configurar" y lo determinista funciona (recordatorio simple, agregar a una lista).
- Con clave (si está en supabase/functions/.env): Loki arma un plan de varias acciones con edición y confirmación; convertir un mensaje en tarea con click derecho y ver el chip; resumir no leídos; listas en vivo entre dos navegadores con usuarios distintos; serie recurrente y turno rotativo generando la siguiente ocurrencia; encuesta de fecha con disponibilidad y "Crear evento"; nota de voz transcrita y convertida en acciones (o "Transcripción sin configurar"); guardar y preguntar algo de la memoria del espacio; búsqueda universal con filtros; vista "Tu día"; Uso de IA con límites; conectar un agente de webhook genérico de prueba y ver progreso y resultado vía agent-callback; vincular el compañero de escritorio y ejecutar una acción simple y una sensible con aprobación.
- Teclado (atajos, foco visible, Escape), hover y click derecho, modo oscuro, textos en español con tildes, estados vacíos y errores con reintento.

4. Revisión manual en Android (Capacitor, teléfono real o emulador)
- Instala el APK debug (README: Android Studio o ./gradlew assembleDebug dentro de android/).
- Mantener pulsado un mensaje abre el menú con "Convertir en…" sin chocar con el scroll; deslizar ítems de lista; hojas inferiores con el teclado abierto y safe areas; el botón atrás cierra hojas y búsqueda.
- Micrófono: se pide RECORD_AUDIO, se graba, se cancela deslizando y se transcribe; si se niega, aparece cómo activarlo.
- Push (si FCM está configurado): resumen diario a la hora local, recordatorio de turno, "falta tu voto", agente terminó y aprobación de comando del PC; cada una abre la pantalla correcta con la app cerrada. Sin config: "Notificaciones no configuradas".
- Hápticos, compartir, barra de estado y rendimiento aceptable en listas largas.

5. Cierre
- Actualiza README.md (arquitectura con las piezas nuevas, secretos, y un "Qué falta" fiel a la realidad: por ejemplo adjuntos e invitaciones si ya funcionan) y PROGRESO.md (qué se hizo, qué quedó pendiente y qué depende de Manu: claves de LLM y STT, FCM, verificar las APIs de Grok Bot y Hermes, firma del compañero de escritorio).
- Repite los chequeos del punto 2 hasta que todos den 0. Después haz commit local "Funciones etapas 1-3: verificación y regresión" (sin push, sin deploy).
```
