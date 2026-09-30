# functions/ (histórico)

Aquí vivía el backend de Loki IA con Cloud Functions (T18: `aiChat`,
`onMention`, recordadores). La migración a Supabase lo sustituye:

- **Loki IA real** → Edge Function `supabase/functions/loki-chat`
  (Deno, `npm run sb:functions`). Proveedor por entorno, secretos solo en
  `supabase/functions/.env`.
- **Push** → Edge Function `supabase/functions/push-send` (FCM HTTP v1,
  desactivada por defecto) + `push_tokens` en Postgres.
- **Datos, auth, realtime y storage** → Postgres + RLS + Realtime + Storage
  (`supabase/migrations`, `npm run sb:start`).

Firebase queda **solo para el push FCM en el cliente** (`src/lib/push/fcm.ts`
con `firebase/messaging`). Este directorio se conserva vacío a propósito (no
se borran carpetas): no desplegar nada desde aquí.
