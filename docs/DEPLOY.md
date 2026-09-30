# Despliegue de Loki (T36)

> Solo documentación: ningún paso se ejecuta solo. No hay secretos aquí;
> los nombres de variables están en [`.env.example`](../.env.example) y
> [`supabase/functions/.env.example`](../supabase/functions/.env.example).

```mermaid
flowchart LR
    App["App Next.js\n(web + Capacitor)"] --> SB["Supabase\n(Postgres + Auth + Realtime + Storage)"]
    App --> Edge["Edge Functions\n(loki-chat, push-send)"]
    Edge --> SB
    Edge --> LLM["Proveedor LLM\n(OpenAI / Anthropic / Gemini)"]
    Edge --> FCM["FCM"]
    Edge --> GCal["Google Calendar"]
    GCal --> Edge
    FCM --> App
```

## 1. Crear el Supabase real y aplicar migraciones

1. Crea el proyecto en el panel de Supabase y anota `URL` + `anon key`.
2. Instala el CLI (`supabase/cli`) e inicia sesión.
3. Vincula y sube el esquema:
   ```bash
   supabase link --project-ref <REF>
   supabase db push   # aplica supabase/migrations en orden
   ```
4. Comprueba en el panel que existen las tablas (`workspaces`, `messages`,
   `events`, `tasks`, `projects`, `invites`, …) y los buckets (`chat-media`,
   `post-media`, `avatars`).

## 2. Auth: email + Google OAuth

- **Email**: activado por defecto; desactiva la confirmación solo en local
  (`supabase/config.toml` ya trae `enable_confirmations=false`).
- **Google**: en el panel (Authentication → Providers) crea el cliente OAuth
  de Google y registra las URLs de retorno:
  - Local: `http://localhost:3000`, `http://127.0.0.1:54321/auth/v1/callback`
  - Producción: tu dominio (`https://<tu-dominio>/auth/callback`) y el
    callback del proyecto (`https://<REF>.supabase.co/auth/v1/callback`).

## 3. Secretos de las Edge Functions

En el panel (Edge Functions → Secrets) o con `supabase secrets set`:

- Loki IA: `LLM_PROVIDER` (`openai|anthropic|gemini`), `LLM_MODEL`,
  `LLM_API_KEY`, `LLM_BASE_URL` (solo compatibles OpenAI), `AI_DAILY_LIMIT`
  (default 50). Sin `LLM_API_KEY`: 503 `not_configured`.
- Push: `FCM_SERVICE_ACCOUNT` (JSON de la cuenta de servicio). Sin él:
  503 `not_configured`.
- Despliega con `supabase functions deploy loki-chat` y
  `supabase functions deploy push-send` (más
  `supabase functions deploy google-calendar` si usas la sync de 7).

## 4. pg_cron (recordatorios y limpieza)

Activa la extensión `pg_cron` en el proyecto y programa los trabajos que
necesites (p. ej. aviso de `tasks.reminder_at`, purga de typing antiguo).
Los jobs viven en la base real, no en el repo: documéntalos en tu panel.

## 5. Firebase solo para FCM

Firebase **no guarda datos** (sin Firestore/Auth/Storage en la app):

1. Crea el proyecto, activa Cloud Messaging y descarga el JSON de la
   cuenta de servicio → secreto `FCM_SERVICE_ACCOUNT`.
2. Copia las claves web + VAPID a `.env.local` / al hosting
   (`NEXT_PUBLIC_FIREBASE_*`, ver `.env.example`).
3. El push es opt-in: la app solo registra el token con
   `NEXT_PUBLIC_PUSH_ENABLED=1`.

## 6. Frontend: Vercel o Firebase Hosting (build export)

- **Vercel**: importa el repo, pon `NEXT_PUBLIC_SUPABASE_URL` y
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (+ Firebase web si hay push) y despliega
  (`npm run build`).
- **Firebase Hosting**: `npm run build` y publica el export (`out/`,
  ver `firebase.json`). Sin SSR: todo es estático + Supabase cliente.

## 7. Google Calendar (sincronización bidireccional)

La Edge Function `google-calendar` importa (pull) y exporta (push) eventos
entre Loki y Google Calendar. Sin los secretos responde 503
`not_configured` y la app sigue funcionando solo con Loki.

### 7.1. Google Cloud (lo hace Manu en la consola)

1. Crea un proyecto en [Google Cloud](https://console.cloud.google.com/)
   (o usa uno existente).
2. Activa la **Google Calendar API** (APIs y servicios → Biblioteca →
   busca "Google Calendar API" → Habilitar).
3. Crea el cliente OAuth (APIs y servicios → Credenciales → Crear
   credenciales → ID de cliente OAuth):
   - Tipo de aplicación: **Web**.
   - En **Orígenes autorizados de JavaScript** añade tu dominio
     (`https://<vercel>` y `http://localhost:3000` para local).
   - En **URIs de redirección autorizados** añade la URL EXACTA:
     `https://<vercel>/auth/google/callback`
     (local: `http://localhost:3000/auth/google/callback`).
     Tiene que coincidir carácter por carácter con `GOOGLE_REDIRECT_URL`.
4. En la pantalla de consentimiento (OAuth consent screen):
   - Tipo: Externo, con tu email de prueba en "Test users" mientras esté
     en modo de prueba.
   - Scopes: `https://www.googleapis.com/auth/calendar.events`
     (ver, crear y editar tus eventos de calendario; no se toca nada más).
5. Anota el **Client ID** y el **Client Secret**.

### 7.2. Secretos (Edge Function `google-calendar`)

En el panel (Edge Functions → Secrets) o con `supabase secrets set`:

- `GOOGLE_CLIENT_ID`: el Client ID del paso anterior.
- `GOOGLE_CLIENT_SECRET`: el Client Secret. Sin él: 503 `not_configured`.
- `GOOGLE_REDIRECT_URL`: la URL exacta de 7.1
  (`https://<vercel>/auth/google/callback`).
- `GOOGLE_TOKEN_KEY`: texto cualquiera de 32+ caracteres. Cifra el refresh
  token (AES-GCM); no lo cambies una vez conectado o los tokens guardados
  dejarán de leerse.

Despliega con `supabase functions deploy google-calendar` y aplica la
migración (`supabase db push`: crea `calendar_connections` y las columnas
`events.external_id` / `events.external_source`).

### 7.3. Frontend (Vercel)

No hace falta variable pública para el flujo actual (la URL OAuth la genera
la Edge). Reservada para uso futuro: `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
Lo único que debe coincidir es que la app esté servida en el dominio cuya
ruta `/auth/google/callback` registraste como `GOOGLE_REDIRECT_URL`.

### 7.4. Cómo funciona

- **Conectar**: Configuración → Google Calendar → Conectar (redirige a
  Google, vuelve a `/auth/google/callback`, que intercambia el `?code=`).
- **Pull** (Google → Loki): próximos 30 días al espacio actual; borra de
  Loki los que Google eliminó (solo `external_source = 'google'`). Auto-pull
  al abrir el Calendario si el último sync tiene más de 15 min.
- **Push** (Loki → Google): al crear/editar un evento con la conexión
  activa (fire-and-forget con aviso discreto si falla); al borrar un evento
  con espejo se borra también en Google.

## 8. Firma del APK/AAB (Android, `cl.loki.app`)

1. Genera el keystore una vez (fuera del repo, con backup):
   ```bash
   keytool -genkeypair -alias loki -keyalg RSA -keysize 2048 -validity 10000 -keystore loki.keystore
   ```
2. Configura `android/key.properties` (gitignored) con `storeFile`,
   `storePassword`, `keyAlias` y `keyPassword`.
3. `npm run build:capacitor`, abre `android/` en Android Studio y compila
   `assembleRelease` (APK) o `bundleRelease` (AAB para Play).
4. El `google-services.json` de Firebase va en `android/app/` (gitignored).

## 9. Chequeo previo al lanzamiento

```bash
npm run check-env   # env sin imprimir secretos
npm run typecheck && npm run build && npm run test:rls
```
