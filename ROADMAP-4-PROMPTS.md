# Loki: lo que queda en 4 prompts (T21–T36)

**Antes de empezar:** T20 (Auth con Supabase) está hecha pero sin commit. En la carpeta del proyecto:
```
git add -A
git commit -m "T20: Auth con Supabase"
```
Después pega los prompts en opencode, uno por vez y en orden. Supabase local debe estar corriendo (`npm run sb:start`; `npm run sb:status` muestra URL y claves locales).

**Clave de IA y credenciales de Google**
- **Clave de IA** (`LLM_API_KEY` en `supabase/functions/.env`, gitignored, nunca en el código): solo para ver respuestas reales de Loki IA (prompt 1: chat y @Loki; prompt 3: herramientas y resumen diario; opcional en recordatorios del prompt 2). Sin clave todo compila y la app muestra "Loki IA sin configurar".
- **Credenciales de Google OAuth**: solo para que "Continuar con Google" funcione de verdad. Sin ellas el botón avisa "Google no está configurado en este entorno". Ningún prompt las necesita para compilar; el prompt 4 documenta cómo configurarlas.
- Push reales (FCM) necesitan un proyecto Firebase; sin él, el interruptor dice "Notificaciones no configuradas".

---

## Prompt 1: Terminar la migración a Supabase (T21–T25)
```
Proyecto Loki (Next.js 15 export estático + Capacitor, TypeScript estricto, Tailwind, shadcn/ui). Lee .forja/plan-supabase.md, supabase/README.md y supabase/migrations/. T19 (esquema + RLS) y T20 (Auth) ya están. Termina la migración de Firestore a Supabase:

1. Chats y mensajes: reescribe src/lib/data/chat.ts y chats.ts con supabase-js (quita el bloque "fallo suave" de T20). Mantén intacta la API de src/hooks/use-chat.ts y los tipos de src/types (adaptador snake_case -> camelCase). Lista de chats y mensajes con realtime postgres_changes filtrado por workspace_id/chat_id, paginación hacia atrás por created_at, envío optimista con id crypto.randomUUID() e idempotente (duplicado = enviado), editar (edited_at), borrar soft, leídos con upsert en chat_reads, "escribiendo…" por Realtime Broadcast en el canal chat:{wsId}:{chatId}. last_message/thread_count los mantienen los triggers.
2. Reacciones (message_reactions + realtime, reconstruye message.reactions {emoji: uid[]}), hilos (thread_parent_id; fuera del timeline y sin tocar el preview), menciones y Publicaciones (type 'post' en el chat 'posts' vía rpc ensure_posts_chat; like = ❤️; comentarios = hilo). La UI actual no cambia.
3. Loki IA real: Edge Function supabase/functions/loki-chat/index.ts (Deno). GET /health -> {configured, provider, model} sin exponer la clave. POST con JWT del usuario: modo 'personal' (chat Loki IA, SSE real, guarda type 'ai' con la service role del entorno de la función) y modo 'mention' (@Loki en chats del espacio, verifica membresía). Proveedor por env: LLM_PROVIDER (openai|anthropic|gemini), LLM_MODEL, LLM_API_KEY, LLM_BASE_URL, en supabase/functions/.env (gitignored) con .env.example. Sin clave: 503 {code:'not_configured'}. Si hace falta, agrega una migración NUEVA (no edites la de T19). Cliente src/lib/ai/loki.ts (getLokiStatus, streamLokiReply). /chat/loki-ia sin clave muestra "Loki IA sin configurar" y deshabilita el composer; @Loki sin clave inserta el aviso de sistema "Loki IA sin configurar. Pide al administrador que configure el proveedor." Elimina src/lib/chat/ai-mock.ts, src/hooks/use-ai-reveal.ts, tests/ai-mock.test.mjs (y quítalo de test:unit en package.json), todo "[Simulado]" y NEXT_PUBLIC_AI_ENABLED.
4. Firebase solo para push: src/lib/push/fcm.ts (solo se activa con NEXT_PUBLIC_FIREBASE_* y VAPID; token a push_tokens; sin config: "Notificaciones no configuradas en este entorno"), public/firebase-messaging-sw.js sin claves, supabase/functions/push-send (FCM HTTP v1 con secreto FCM_SERVICE_ACCOUNT; sin secreto 503). Quita Firestore, Firebase Auth y Storage de src/, borra firestore.rules, firestore.indexes.json, storage.rules, tests/firestore.rules.test.mjs, tests/chat.rules.test.mjs y los scripts emulators*/test:rules* de package.json; desinstala firebase-tools y @firebase/rules-unit-testing. En functions/ quita el código de IA y deja un README (no borres carpetas). Al final no debe quedar ningún import de firebase/firestore, firebase/auth ni firebase/storage en src/.
5. README.md: arquitectura, requisitos (WSL2 + Docker, Node), sb:start, .env.local (URL + anon key), sb:functions con supabase/functions/.env, scripts de test y qué falta. Corrige tildes y estados vacíos que veas.

Restricciones: TypeScript estricto sin any; mantén el diseño claro estilo Grok Bot existente; sin claves en el código (la service_role nunca en NEXT_PUBLIC_ ni en el cliente); no git push, no deploy, no crear ni usar proyectos reales de Supabase o Firebase (nada de supabase link/db push/login); no borres carpetas.

Chequeo final único: `npm run typecheck && npm run build && npm run test:rls` sin errores; corrige hasta que pase y luego haz commit local "T21-T25: Migración a Supabase completa".
```

## Prompt 2: Calendario, proyectos, notificaciones e invitaciones (T26–T29)
```
Proyecto Loki (Next.js 15 export estático + Capacitor, TypeScript estricto, Supabase local). Agrega una migración NUEVA en supabase/migrations/ (no edites las anteriores) con RLS y tests en tests/rls/, más la UI de cada parte:

1. Calendario: tabla events (workspace_id, project_id nullable, title, description, starts_at, ends_at, all_day, location, color, created_by, attendees uuid[], reminder_minutes int[], recurrence text nullable). RLS: miembros leen; creador o admin editan/borran. Pestaña Calendario con vistas Mes, Semana y Agenda (segmented control; móvil Agenda, desktop Semana), hoy marcado, crear/editar en hoja (móvil) o diálogo (desktop), arrastrar en Semana, recurrencia diaria/semanal/mensual expandida en el cliente. El widget de semana de Inicio lee eventos reales.
2. Proyectos y tareas: tablas projects (name, description, emoji, color, status active|archived, due_date) y tasks (project_id, workspace_id, title, notes, status todo|doing|done, priority, assignee_ids, due_at, reminder_at, position numeric, parent_task_id, completed_at) + progreso hechas/total (vista o columna). UI: lista de proyectos con tarjeta, emoji y barra de progreso accent; detalle con vista Lista y Tablero kanban arrastrable (position); hoja de tarea con subtareas, responsables, fecha, recordatorio, prioridad y notas; sección Ideas convertible en tarea. Inicio muestra "Tareas de hoy" y progreso reales; borra src/lib/mock/home.ts.
3. Notificaciones: tabla notifications (user_id, workspace_id, type mention|reply|reaction|task_assigned|task_due|event_reminder|invite|ai_alert, title, body, link, read_at); RLS: cada usuario ve solo las suyas. Triggers para mención, respuesta en hilo, tarea asignada e invitación; job pg_cron que crea recordatorios de tareas y eventos con texto fijo en español (redacción con IA solo si loki-chat está configurada). Push vía supabase/functions/push-send (sin FCM real). UI: campana en el header con punto si hay no leídas, bandeja Hoy/Ayer/Antes con "marcar todo como leído", toast discreto; Configuración -> Notificaciones con interruptores por tipo y horario de silencio.
4. Invitaciones: tabla invites (code 8 caracteres sin 0/O/1/I, role member|admin, expires_at, max_uses, uses, revoked_at); solo admins crean y revocan; función segura accept_invite(code). UI en Configuración -> Miembros: Invitar con link copiable, código grande mono y QR (librería qrcode), expiración 1 día/7 días/nunca y rol; página /invite?code= con "Unirme" (login previo si hace falta); Web Share en móvil; cambio de rol y expulsión con confirmación.

Capa de datos en src/lib/data/, hooks en src/hooks/, pantallas en src/app/ y componentes en src/components/, siguiendo el patrón existente.

Restricciones: TypeScript estricto sin any; diseño claro estilo Grok Bot existente (mismas tarjetas, radios, tipografía, espaciados, lucide stroke 1.75, oscuro opcional); sin claves en el código; no git push, no deploy, no Supabase ni Firebase reales.

Chequeo final único: `npm run typecheck && npm run build && npm run test:rls` sin errores; corrige hasta que pase y luego haz commit local "T26-T29: Calendario, proyectos, notificaciones e invitaciones".
```

## Prompt 3: Loki IA con herramientas, adjuntos, búsqueda y app (T30–T33)
```
Proyecto Loki (Next.js 15 export estático + Capacitor, TypeScript estricto, Supabase local). Migraciones NUEVAS en supabase/migrations/ con RLS y tests en tests/rls/ cuando toques la base.

1. Loki IA con herramientas: amplía supabase/functions/loki-chat con function calling del proveedor de LLM_PROVIDER, ejecutado con el JWT del usuario (respeta RLS): get_today_summary, list_events, create_event, list_tasks, create_task, complete_task, list_projects, search_messages, create_reminder. Las acciones que modifican datos muestran una tarjeta de confirmación en el chat (Confirmar/Cancelar). Historial con límite de contexto y resumen de conversaciones largas; límite diario por usuario con tabla ai_usage; @loki en grupo responde en el hilo con el contexto de ese chat; alerta ai_alert diaria a las 8:00 con el resumen. Sin clave: "Loki IA sin configurar", sin romper nada.
2. Adjuntos y voz: Supabase Storage con buckets y políticas por espacio (en migración). Menú + del composer: Foto/Video, Cámara, Archivo, Nota de voz. Imágenes comprimidas en el cliente (máx. 2048 px, WebP) en grilla de 1 a 4 con visor a pantalla completa (deslizar y zoom); archivos como tarjeta con ícono, nombre, tamaño y descarga; notas de voz con MediaRecorder (mantener para grabar, deslizar para cancelar, onda, 1x/1.5x/2x); progreso con cancelar y límite de tamaño con mensaje amable. Mismo componente en Publicaciones.
3. Búsqueda Cmd/Ctrl+K (lupa en el header móvil): paleta con grupos Mensajes, Tareas, Proyectos, Eventos, Personas, Acciones; full-text de Postgres en español (unaccent + GIN) vía RPC segura; teclado, resaltado, recientes y acciones rápidas. Presencia con Realtime Presence: punto verde, "Última vez hace…" y estado personalizado (emoji + texto).
4. PWA y Android: manifest con íconos maskable, theme-color claro/oscuro, service worker con caché de la app y cola de mensajes sin conexión. Capacitor Android (appId cl.loki.app) sobre el export estático con status-bar, splash-screen, keyboard, haptics, push-notifications, share y camera; safe areas en la barra inferior; deep links a /invite; genera android/ y documenta en README cómo compilar el APK.

Restricciones: TypeScript estricto sin any; diseño claro estilo Grok Bot existente; sin claves en el código (las del LLM y FCM solo como secretos del servidor); no git push, no deploy, no Supabase ni Firebase reales.

Chequeo final único: `npm run typecheck && npm run build && npm run test:rls` sin errores; corrige hasta que pase y luego haz commit local "T30-T33: IA con herramientas, adjuntos, búsqueda y app".
```

## Prompt 4: Pulido visual, calidad, seguridad y lanzamiento (T34–T36)
```
Proyecto Loki (Next.js 15 export estático + Capacitor, TypeScript estricto, Supabase local). Deja la app lista para lanzar, sin desplegar nada:

1. Pulido visual en todas las pantallas (login, onboarding, Inicio, Chat, conversación, hilo, Publicaciones, Loki IA, Calendario, Proyectos, tarea, Perfil, Configuración, invitaciones). Unifica tokens en src/app/globals.css y tailwind: espaciado 4/8/12/16/24/32, radios 8/12/16/24/pill, 2 sombras, Inter 13/15/17/20/28 (400/500/600/700), lucide stroke 1.75. Estados vacíos útiles, skeletons en listas, errores con reintento, microinteracciones framer-motion de 150–250 ms ease-out respetando prefers-reduced-motion. Mantener pulsado un mensaje abre un solo menú (emojis arriba, acciones abajo). Textos en español con tildes y sin inglés. Documenta en src/components/ui/README.md.
2. Calidad y seguridad: ARIA, foco visible, teclado y contraste AA; listas de chat y feed virtualizadas con paginación por cursor; code splitting; tests RLS negativos en tests/rls/ (usuario ajeno, no miembro, member haciendo acciones de admin); rate limiting en las Edge Functions; validación con zod en cliente y funciones; sanitizar markdown y links; headers de seguridad y CSP; error boundary por sección y un logger; .github/workflows/ci.yml (typecheck, lint, test:unit, test:rls con Supabase local, build) sin pasos de deploy.
3. Lanzamiento: docs/DEPLOY.md con los pasos para crear Supabase real y aplicar migraciones, Auth con email y Google OAuth (URLs de redirección), secretos de Edge Functions (LLM_*, FCM_SERVICE_ACCOUNT), pg_cron, Firebase solo FCM, frontend en Vercel o Firebase Hosting y firma de APK/AAB. .env.example completo y comentado, scripts/check-env.mjs, página /legal (términos y privacidad), bienvenida de 3 pantallas, datos de demo opcionales para un espacio nuevo y README profesional con diagrama mermaid.

Restricciones: TypeScript estricto sin any; mantén el diseño claro estilo Grok Bot existente; sin claves ni secretos en el repo; no git push, no deploy, no Supabase ni Firebase reales (DEPLOY.md solo documenta).

Chequeo final único: `npm run typecheck && npm run build && npm run test:rls` sin errores; corrige hasta que pase y luego haz commit local "T34-T36: Pulido, calidad y lanzamiento".
```
