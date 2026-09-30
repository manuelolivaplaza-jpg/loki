# Loki: prompts cortos (T21–T36)

**Antes de empezar:** T20 (Auth con Supabase) ya está hecha pero sin commit. Ejecuta primero en la carpeta del proyecto:
```
git add -A
git commit -m "T20: Auth con Supabase"
```
Luego pega los prompts **desde T21**, uno por vez y en orden. Supabase local debe estar corriendo (`npm run sb:start`). La versión larga está en `.forja/ROADMAP-PROMPTS.largo.md`.

**¿Cuándo hace falta una clave o credencial?**
- **Clave de IA** (`LLM_API_KEY` en `supabase/functions/.env`, nunca en el código): solo para ver respuestas reales de Loki IA en T23 y T30 (y los textos redactados por IA de T28, que son opcionales). Sin clave, todas las tareas compilan y la app muestra "Loki IA sin configurar".
- **Credenciales de Google OAuth**: solo para que funcione de verdad "Continuar con Google". Sin ellas, el botón avisa "Google no está configurado en este entorno". Ninguna tarea las necesita para compilar; T36 documenta cómo configurarlas.
- **Firebase (FCM)**: solo para push reales en T24, T28 y T33. Sin config, el interruptor dice "Notificaciones no configuradas".

**Reglas en todos los prompts:** TypeScript estricto, diseño claro estilo Grok Bot ya existente, sin claves en el código, sin push ni deploy.

---

## T21: Chats y mensajes
```
Proyecto Loki, T21. Migra CHATS y MENSAJES de Firestore a Supabase (ver .forja/plan-supabase.md y supabase/migrations). Toca src/lib/data/chat.ts, chats.ts y los hooks de chat; mantén intacta la API de src/hooks/use-chat.ts y los tipos de src/types (adaptador snake_case -> camelCase), sin cambiar componentes salvo lo imprescindible. Incluye: lista de chats y mensajes con realtime (postgres_changes), paginación hacia atrás, envío optimista con id crypto.randomUUID() e idempotente, editar, borrar (soft), leídos con chat_reads y "escribiendo…" por Realtime Broadcast (canal chat:{wsId}:{chatId}). Quita firebase/firestore de estos módulos. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run build` sin errores y commit local "T21: Chats en Supabase".
```

## T22: Reacciones, hilos, menciones y publicaciones
```
Proyecto Loki, T22. Migra a Supabase reacciones (message_reactions, con realtime), hilos (thread_parent_id; las respuestas no salen en el timeline), menciones con aviso de sistema y Publicaciones (mensajes type 'post' en el chat 'posts'; like = reacción ❤️; comentarios = hilo). Toca src/lib/data/*, src/hooks/* de chat y publicaciones. La UI de T15–T17 no cambia. Sin firebase/firestore en ningún módulo de chat. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run build` sin errores y commit local "T22: Reacciones, hilos y publicaciones".
```

## T23: Loki IA real (Edge Function)
```
Proyecto Loki, T23. Crea la Edge Function supabase/functions/loki-chat (Deno): GET /health -> {configured, provider, model}; POST con JWT del usuario, modos 'personal' (chat Loki IA, streaming SSE real, guarda el mensaje type 'ai') y 'mention' (@Loki en chats del espacio). Proveedor por entorno: LLM_PROVIDER (openai|anthropic|gemini), LLM_MODEL, LLM_API_KEY, LLM_BASE_URL, en supabase/functions/.env (gitignored) con .env.example. Sin clave: 503 not_configured. Si hace falta, agrega una migración NUEVA (no edites la de T19). Cliente: src/lib/ai/loki.ts; /chat/loki-ia muestra "Loki IA sin configurar" y deshabilita el composer si no hay clave; @Loki sin clave inserta el aviso "Loki IA sin configurar. Pide al administrador que configure el proveedor." Elimina ai-mock.ts, use-ai-reveal.ts, todo "[Simulado]", NEXT_PUBLIC_AI_ENABLED y el código de IA de functions/ (deja su README). Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código ni en el cliente, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T23: Loki IA real".
```

## T24: Firebase solo para push
```
Proyecto Loki, T24. Firebase queda SOLO para push (FCM). Crea src/lib/push/fcm.ts (se activa solo si hay NEXT_PUBLIC_FIREBASE_* y VAPID; guarda el token en push_tokens; sin config el interruptor dice "Notificaciones no configuradas en este entorno"), public/firebase-messaging-sw.js sin claves y supabase/functions/push-send (FCM HTTP v1 con secreto FCM_SERVICE_ACCOUNT; sin secreto responde 503). Limpieza: quita Firestore, Firebase Auth y Storage del cliente, firestore.rules, storage.rules, sus tests y scripts de emuladores; desinstala firebase-tools y @firebase/rules-unit-testing. No borres carpetas. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T24: Firebase solo push".
```

## T25: Revisión y README
```
Proyecto Loki, T25. Reescribe README.md: arquitectura (Next export + Capacitor, Supabase, Firebase solo FCM), requisitos (WSL2 + Docker, Node), sb:start, .env.local (URL + anon), sb:functions con supabase/functions/.env, scripts de test y qué falta (proyecto real, Google OAuth, FCM, dispositivo). Recorre todas las pantallas y corrige tildes, estados vacíos y errores de consola. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run build` sin errores y commit local "T25: Revisión y README".
```

## T26: Calendario
```
Proyecto Loki, T26. Calendario sobre Supabase: migración nueva con tabla events (workspace_id, project_id, title, description, starts_at, ends_at, all_day, location, color, created_by, attendees, reminder_minutes, recurrence) y RLS (miembros leen; creador o admin editan), más tests en tests/rls. UI en la pestaña Calendario: vistas Mes, Semana y Agenda con segmented control, crear/editar en hoja (móvil) o diálogo (desktop), arrastrar en Semana, recurrencia básica. El widget de semana de Inicio lee eventos reales. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T26: Calendario".
```

## T27: Proyectos y tareas
```
Proyecto Loki, T27. Migración nueva con tablas projects y tasks (estado, prioridad, responsables, fechas, recordatorio, position, subtareas) con RLS por membresía y tests. UI en Proyectos: lista con tarjeta, emoji y barra de progreso; detalle con vista Lista y Tablero kanban arrastrable; hoja de tarea con subtareas, responsables, fecha, prioridad y notas; sección Ideas convertible en tarea. Inicio muestra "Tareas de hoy" y progreso reales; borra src/lib/mock/home.ts. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T27: Proyectos y tareas".
```

## T28: Recordatorios y notificaciones
```
Proyecto Loki, T28. Migración nueva con tabla notifications (RLS: cada usuario ve las suyas) y tests; triggers que notifican menciones, respuestas, tareas asignadas e invitaciones; job con pg_cron que genera recordatorios de tareas y eventos con texto fijo en español (redacción por IA solo si está configurada). Envío push con la Edge Function push-send (sin FCM real, simulado si no hay secreto). UI: campana en el header con punto si hay no leídas, bandeja agrupada Hoy/Ayer/Antes, marcar todo como leído y toast; Configuración → Notificaciones con interruptores por tipo y horario de silencio. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T28: Notificaciones".
```

## T29: Invitaciones
```
Proyecto Loki, T29. Migración nueva con tabla invites (código de 8 caracteres sin 0/O/1/I, rol, expiración, usos, revocado) con RLS (solo admins crean y revocan), función segura accept_invite(code) y tests. UI en Configuración → Miembros: botón Invitar con link copiable, código grande y QR (librería qrcode), expiración y rol; página /invite?code= con botón "Unirme"; Web Share en móvil; cambio de rol y expulsión con confirmación. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T29: Invitaciones".
```

## T30: Loki IA con herramientas
```
Proyecto Loki, T30. Amplía supabase/functions/loki-chat con function calling ejecutado con el JWT del usuario (respeta RLS): get_today_summary, list_events, create_event, list_tasks, create_task, complete_task, list_projects, search_messages, create_reminder. Las acciones que modifican datos piden confirmación en una tarjeta del chat. Historial con límite de contexto y resumen; límite diario por usuario con tabla ai_usage (migración nueva + tests); @loki responde en el hilo; alerta diaria de resumen a las 8:00. Sin clave: "Loki IA sin configurar" sin romper nada. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T30: Loki IA con herramientas".
```

## T31: Adjuntos y notas de voz
```
Proyecto Loki, T31. Adjuntos en chat y publicaciones con Supabase Storage (buckets con políticas por espacio, en migración nueva + tests). Menú + del composer: Foto/Video, Cámara, Archivo y Nota de voz. Imágenes comprimidas en el cliente (máx. 2048 px, WebP) en grilla de 1 a 4 con visor a pantalla completa; archivos como tarjeta con descarga; notas de voz con MediaRecorder, onda y velocidad 1x/1.5x/2x; progreso de subida con cancelar y límite de tamaño con mensaje amable. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T31: Adjuntos y voz".
```

## T32: Búsqueda Cmd+K y presencia
```
Proyecto Loki, T32. Búsqueda global con Cmd/Ctrl+K (lupa en el header móvil): paleta con resultados agrupados (Mensajes, Tareas, Proyectos, Eventos, Personas, Acciones), full-text de Postgres en español (unaccent + índice GIN) vía RPC segura en migración nueva con tests; navegación con teclado, resaltado y búsquedas recientes. Presencia con Realtime Presence: punto verde en el avatar, "Última vez hace…" y estado personalizado. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T32: Búsqueda y presencia".
```

## T33: PWA y Android
```
Proyecto Loki, T33. PWA: manifest con íconos maskable, theme-color claro/oscuro, service worker con caché de la app y cola de mensajes sin conexión. Capacitor Android (appId cl.loki.app) sobre el export estático: status-bar, splash-screen, keyboard, haptics, push-notifications, share y camera; safe areas en la barra inferior; deep links a /invite; genera android/ y documenta en README cómo compilar el APK. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run build` sin errores y commit local "T33: PWA y Android".
```

## T34: Pulido visual
```
Proyecto Loki, T34. Revisión visual de todas las pantallas. Unifica tokens (espaciado 4/8/12/16/24/32, radios 8/12/16/24/pill, 2 sombras, Inter 13/15/17/20/28, lucide stroke 1.75). Agrega estados vacíos útiles, skeletons en listas, errores con reintento y microinteracciones con framer-motion de 150–250 ms (respeta prefers-reduced-motion). Mantener pulsado un mensaje abre un solo menú (emojis arriba, acciones abajo). Textos en español con tildes y sin inglés. Documenta el sistema en src/components/ui/README.md. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run build` sin errores y commit local "T34: Pulido visual".
```

## T35: Calidad y seguridad
```
Proyecto Loki, T35. Accesibilidad (ARIA, foco visible, teclado, contraste AA), rendimiento (listas virtualizadas con paginación por cursor, code splitting, bundle sin peso innecesario) y seguridad: tests RLS negativos (ajeno, no miembro, member haciendo acciones de admin), rate limiting en Edge Functions, validación con zod, sanitizar markdown y links, headers de seguridad y CSP, sin secretos en el repo. Error boundary por sección y un logger. CI de GitHub Actions (typecheck, lint, tests, test:rls, build) sin desplegar. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run test:rls` verde, `npm run build` sin errores y commit local "T35: Calidad y seguridad".
```

## T36: Preparación de lanzamiento
```
Proyecto Loki, T36. Sin desplegar nada: escribe docs/DEPLOY.md (Supabase real y migraciones, Auth con email y Google OAuth, secretos de Edge Functions: LLM y FCM, pg_cron, Firebase solo FCM, frontend en Vercel o Firebase Hosting, firma de APK/AAB). Agrega .env.example completo, scripts/check-env.mjs, página /legal (términos y privacidad), bienvenida de 3 pantallas, datos de demo opcionales y README profesional con diagrama mermaid. Reglas: TypeScript estricto, mismo diseño claro estilo Grok Bot, sin claves en el código, no push/deploy. Al final: `npm run build` sin errores y commit local "T36: Lanzamiento listo".
```
