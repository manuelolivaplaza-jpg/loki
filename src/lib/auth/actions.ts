"use client";

/**
 * Acciones de autenticación sobre Supabase Auth (T20).
 *
 * Sustituye a las de Firebase Auth manteniendo EXACTAMENTE la misma API
 * pública (`signUpWithEmail`, `signInWithEmail`, `signInWithGoogle`,
 * `signOutUser`, `getAuthErrorMessage`) para que login, registro, perfil y
 * configuración no cambien. Los errores se traducen al español aquí, en un
 * solo sitio.
 */

import { AuthError, type Session, type User } from "@supabase/supabase-js";
import { getSupabaseClient, isExternalProviderEnabled } from "@/lib/supabase/client";
import { useSessionStore, type SessionUser } from "@/stores/session-store";

/**
 * Códigos de error de GoTrue traducidos. Se mira primero `error.code` (estable)
 * y luego el texto, porque según la versión el mismo fallo llega como
 * `email_exists` o como "User already registered".
 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Correo o contraseña incorrectos.",
  email_not_confirmed: "Confirma tu correo antes de entrar.",
  email_exists: "Este correo ya está registrado. Inicia sesión.",
  user_already_exists: "Este correo ya está registrado. Inicia sesión.",
  weak_password: "La contraseña debe tener al menos 6 caracteres.",
  over_email_send_rate_limit:
    "Demasiados envíos. Espera un momento e inténtalo de nuevo.",
  over_request_rate_limit:
    "Demasiados intentos. Espera un momento e inténtalo de nuevo.",
  too_many_requests:
    "Demasiados intentos. Espera un momento e inténtalo de nuevo.",
  validation_failed: "Revisa los datos: no son válidos.",
  signup_disabled: "El registro está desactivado en este entorno.",
  email_address_invalid: "Ingresa un correo válido.",
  bad_json: "Ocurrió un error. Inténtalo de nuevo.",
  network_error: "Error de red. Revisa tu conexión e inténtalo de nuevo.",
  session_not_found: "Tu sesión expiró. Vuelve a iniciar sesión.",
  provider_not_supported: "Ese proveedor de acceso no está disponible.",
  manual_linking_disabled: "Ese proveedor de acceso no está disponible.",
};

/**
 * Error con el mensaje YA traducido al español.
 *
 * Las acciones lanzan esto para que el `catch` que las envuelve pueda
 * distinguir "esto es un fallo de GoTrue por traducir" de "esto ya es un
 * mensaje para la persona". Sin la marca, el mensaje en español se volvería a
 * pasar por `getAuthErrorMessage` y acabaría en el genérico.
 */
class AuthMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthMessageError";
  }
}

function fail(error: unknown): never {
  throw error instanceof AuthMessageError
    ? error
    : new AuthMessageError(getAuthErrorMessage(error));
}

/** Traduce un error de GoTrue al mensaje que ve la persona en pantalla. */
export function getAuthErrorMessage(error: unknown): string {
  if (error instanceof AuthMessageError) return error.message;
  const code = typeof error === "object" && error !== null ? errorCode(error) : null;
  if (code !== null) {
    const known = AUTH_ERROR_MESSAGES[code];
    if (known !== undefined) return known;
    const lower = code.toLowerCase();
    for (const [key, message] of Object.entries(AUTH_ERROR_MESSAGES)) {
      if (lower.includes(key)) return message;
    }
  }
  const raw = rawMessage(error).toLowerCase();
  if (raw.includes("already registered") || raw.includes("already been registered")) {
    return "Este correo ya está registrado. Inicia sesión.";
  }
  if (raw.includes("invalid login credentials") || raw.includes("invalid credentials")) {
    return "Correo o contraseña incorrectos.";
  }
  if (raw.includes("password should be at least") || raw.includes("weak_password")) {
    return "La contraseña debe tener al menos 6 caracteres.";
  }
  if (raw.includes("email not confirmed")) {
    return "Confirma tu correo antes de entrar.";
  }
  if (raw.includes("fetch failed") || raw.includes("failed to fetch") || raw.includes("network")) {
    return "Error de red. Revisa tu conexión e inténtalo de nuevo.";
  }
  return "Ocurrió un error. Inténtalo de nuevo.";
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code !== "") return code;
  if (typeof code === "number") return String(code);
  return null;
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/** Nombre de la persona a partir del usuario de Supabase Auth. */
export function toSessionUser(user: User): SessionUser {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const displayName =
    typeof meta["display_name"] === "string" ? meta["display_name"] : null;
  const avatarUrl =
    typeof meta["avatar_url"] === "string" ? meta["avatar_url"] : null;
  return {
    uid: user.id,
    email: user.email ?? null,
    displayName,
    photoURL: avatarUrl,
  };
}

/**
 * Actualiza la sesión guardada en el store de zustand.
 * La usa `AuthListener` con `onAuthStateChange` y también estas acciones,
 * para que la navegación no espere al evento.
 */
function syncSession(session: Session | null): void {
  if (session === null) {
    useSessionStore.getState().clear();
    return;
  }
  useSessionStore.getState().setUser(toSessionUser(session.user));
}

/**
 * Registro con email y contraseña.
 *
 * `options.data.display_name` es lo que lee el trigger `handle_new_user` para
 * crear la fila de `profiles` con el nombre ya puesto.
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  displayName: string,
): Promise<void> {
  try {
    const name = displayName.trim();
    const { data, error } = await getSupabaseClient().auth.signUp({
      email: email.trim(),
      password,
      options: name === "" ? {} : { data: { display_name: name } },
    });
    if (error !== null) fail(error);
    // En local `[auth.email] enable_confirmations = false`, así que la sesión
    // viene ya en la respuesta. Si algún entorno exigiera confirmar el
    // correo, avisamos en vez de dejar al usuario en un limbo sin sesión.
    if (data.session === null) {
      throw new AuthMessageError(
        "Te enviamos un correo para confirmar la cuenta. Confírmalo y entra.",
      );
    }
    syncSession(data.session);
  } catch (error: unknown) {
    fail(error);
  }
}

/** Inicio de sesión con email y contraseña. */
export async function signInWithEmail(
  email: string,
  password: string,
): Promise<void> {
  try {
    const { data, error } = await getSupabaseClient().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error !== null) fail(error);
    syncSession(data.session);
  } catch (error: unknown) {
    fail(error);
  }
}

/**
 * "Continuar con Google".
 *
 * `signInWithOAuth` devuelve la URL del proveedor y la navegación se hace
 * aquí, para que el botón pueda comprobar si el proveedor está habilitado
 * antes de sacar a la persona de la app. En el stack local Google está
 * desactivado (sin credenciales reales), así que el mensaje es explícito.
 */
export async function signInWithGoogle(): Promise<void> {
  // Se comprueba ANTES de pedir la URL: en local Google está desactivado y
  // saltaría a un JSON de error del servidor en otra pestaña.
  if (!(await isExternalProviderEnabled("google"))) {
    throw new AuthMessageError(GOOGLE_NOT_CONFIGURED);
  }
  const supabase = getSupabaseClient();
  const redirectTo = typeof window === "undefined" ? undefined : googleRedirectTo();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error !== null) {
    throw new AuthMessageError(googleErrorMessage(error));
  }
  if (data === null || typeof data.url !== "string" || data.url === "") {
    throw new AuthMessageError(GOOGLE_NOT_CONFIGURED);
  }
  if (typeof window !== "undefined") {
    window.location.assign(data.url);
  }
}

/** Aviso cuando el proveedor OAuth no está habilitado en este entorno. */
export const GOOGLE_NOT_CONFIGURED =
  "Google no está configurado en este entorno. Entra con tu correo y contraseña.";

/**
 * A dónde vuelve Google tras autenticar. La web y el export estático usan el
 * origen real; en Capacitor es `capacitor://localhost`.
 */
function googleRedirectTo(): string {
  return `${window.location.origin}/inicio`;
}

function googleErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === "validation_failed" || code === "provider_not_supported") {
    return GOOGLE_NOT_CONFIGURED;
  }
  if (error instanceof AuthError && error.status === 400) {
    return GOOGLE_NOT_CONFIGURED;
  }
  const message = getAuthErrorMessage(error);
  if (message === "Ese proveedor de acceso no está disponible.") {
    return GOOGLE_NOT_CONFIGURED;
  }
  return message;
}

/** Cierre de sesión. Limpia además los stores de perfil y espacios. */
export async function signOutUser(): Promise<void> {
  try {
    const { error } = await getSupabaseClient().auth.signOut();
    if (error !== null) fail(error);
    syncSession(null);
  } catch (error: unknown) {
    fail(error);
  }
}
