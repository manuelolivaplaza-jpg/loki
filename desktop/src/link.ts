/**
 * Intercambio del código corto de vinculación.
 *
 * El dueño genera el código en Loki (Configuración → Mis dispositivos →
 * Vincular un PC, un solo uso, 5 min) y aquí se pega. Se canjea contra la
 * Edge Function `device-pair`, que devuelve la credencial del dispositivo
 * (email + secreto largo, que viaja UNA sola vez) y se guarda en el almacén
 * seguro del sistema (nunca en texto plano).
 */

import { DESKTOP_VERSION, loadLocalConfig, saveLocalConfig } from "./config.js";
import { saveCredential } from "./secure-store.js";
import { platformName } from "./supabase-device.js";

interface PairResponse {
  device_id: string;
  email: string;
  secret: string;
}

function friendlyPairError(status: number, code: string, message: string): string {
  if (status === 404 || code === "invalid_code") return "Ese código no existe. Revisa que lo copiaste bien.";
  if (status === 410 || code === "expired_code" || code === "used_code") {
    return "Ese código venció o ya se usó. Genera otro en Loki.";
  }
  if (status === 403) return "Ese código no es de tu cuenta.";
  if (status === 429 || code === "rate_limited") {
    return "Demasiados intentos. Espera un minuto e inténtalo de nuevo.";
  }
  if (message !== "") return message.slice(0, 200);
  return "No se pudo vincular. Inténtalo de nuevo.";
}

export async function pairWithCode(rawCode: string, deviceName?: string): Promise<string> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) {
    throw new Error("Ese código no es válido: son 6 letras o números (sin 0, O, 1 ni I).");
  }
  const cfg = loadLocalConfig();
  const url = (process.env["LOKI_SUPABASE_URL"] ?? cfg.supabaseUrl).replace(/\/+$/, "");
  const anonKey = process.env["LOKI_SUPABASE_ANON_KEY"] ?? cfg.anonKey;
  if (anonKey === "") {
    throw new Error(
      "Falta la clave pública de Supabase (anon). Pon LOKI_SUPABASE_ANON_KEY o vincúlalo con --url y --anon.",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${url}/functions/v1/device-pair`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anonKey },
      body: JSON.stringify({
        code,
        device_name: (deviceName ?? cfg.deviceName).slice(0, 60),
        platform: platformName(),
        app_version: DESKTOP_VERSION,
      }),
    });
  } catch {
    throw new Error("No se pudo llegar a Loki. Revisa que Supabase local esté arriba (npm run sb:start y sb:functions).");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const errCode = typeof body["code"] === "string" ? body["code"] : "";
    const msg = typeof body["message"] === "string" ? body["message"] : "";
    throw new Error(friendlyPairError(res.status, errCode, msg));
  }
  const parsed = body as Partial<PairResponse>;
  if (
    typeof parsed.device_id !== "string" ||
    typeof parsed.email !== "string" ||
    typeof parsed.secret !== "string" ||
    parsed.secret === ""
  ) {
    throw new Error("La respuesta de vinculación vino incompleta. Inténtalo de nuevo.");
  }
  await saveCredential({
    deviceId: parsed.device_id,
    email: parsed.email,
    secret: parsed.secret,
    supabaseUrl: url,
  });
  saveLocalConfig({ deviceId: parsed.device_id, supabaseUrl: url, anonKey });
  return parsed.device_id;
}
