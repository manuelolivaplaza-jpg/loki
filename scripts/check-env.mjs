/**
 * Valida las variables de entorno sin imprimir secretos (T36).
 *
 * Uso: npm run check-env
 * Sale 0 si todo lo requerido existe; si falta algo, lo lista por nombre
 * (nunca muestra valores) y sale 1.
 *
 * Requerido siempre: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY.
 * Opcionales por función (solo avisan): push web (NEXT_PUBLIC_FIREBASE_* +
 * NEXT_PUBLIC_PUSH_ENABLED) y Loki IA (vive en supabase/functions/.env y no
 * se valida aquí porque ese archivo está fuera del frontend).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Carga `.env.local` (si existe) sin mostrar valores: `node` no lee los
// archivos env solo, Next sí. No usa dependencias.
function loadLocalEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (name !== "" && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

loadLocalEnv();

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];

const PUSH_WEB = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
];

const missing = REQUIRED.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === "";
});

if (missing.length > 0) {
  console.error("[check-env] faltan variables requeridas:");
  for (const name of missing) console.error(`[check-env]   · ${name}`);
  process.exit(1);
}

const pushMissing = PUSH_WEB.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === "";
});
const pushOptIn = (process.env.NEXT_PUBLIC_PUSH_ENABLED ?? "").trim();

console.log("[check-env] Supabase: OK");
if (pushMissing.length === 0 && pushOptIn === "1") {
  console.log("[check-env] Push web: OK (opt-in activo)");
} else if (pushMissing.length === 0) {
  console.log(
    "[check-env] Push web: claves presentes, opt-in desactivado (NEXT_PUBLIC_PUSH_ENABLED!=1)",
  );
} else {
  console.log(
    `[check-env] Push web: sin configurar (${pushMissing.length} claves faltan, la app muestra "Notificaciones no configuradas")`,
  );
}
console.log("[check-env] Loki IA: se configura en supabase/functions/.env (no se valida aquí)");
console.log(
  "[check-env] Voz a texto: se configura en supabase/functions/.env (STT_API_KEY)",
);
console.log("[check-env] OK");
