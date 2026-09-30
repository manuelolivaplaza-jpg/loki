"use client";

/**
 * Push FCM (lo único que queda en Firebase).
 *
 * Solo se activa con config completa (`NEXT_PUBLIC_FIREBASE_*` + VAPID). Sin
 * ella, `isPushConfigured()` es false y la UI muestra "Notificaciones no
 * configuradas en este entorno" sin intentar nada. El token se guarda en
 * `push_tokens` (upsert por usuario+token); el aislamiento lo pone la RLS.
 */

import { getSupabaseClient } from "@/lib/supabase/client";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** ¿Hay config de Firebase + VAPID para registrar el token? */
export function isPushConfigured(): boolean {
  return (
    env("NEXT_PUBLIC_FIREBASE_API_KEY") !== "" &&
    env("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN") !== "" &&
    env("NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== "" &&
    env("NEXT_PUBLIC_FIREBASE_APP_ID") !== "" &&
    env("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID") !== "" &&
    env("NEXT_PUBLIC_FIREBASE_VAPID_KEY") !== ""
  );
}

/**
 * Registra el token FCM de este navegador en `push_tokens`.
 * Lanza en español si no hay config, sin permiso o sin soporte.
 */
export async function registerPushToken(): Promise<string> {
  if (!isPushConfigured()) {
    throw new Error("Notificaciones no configuradas en este entorno.");
  }
  if (typeof window === "undefined" || !("Notification" in window)) {
    throw new Error("Este navegador no soporta notificaciones.");
  }
  const { initializeApp, getApps } = await import("firebase/app");
  const app =
    getApps()[0] ??
    initializeApp({
      apiKey: env("NEXT_PUBLIC_FIREBASE_API_KEY"),
      authDomain: env("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
      projectId: env("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
      messagingSenderId: env("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
      appId: env("NEXT_PUBLIC_FIREBASE_APP_ID"),
    });
  const { isSupported, getMessaging, getToken } = await import("firebase/messaging");
  if (!(await isSupported())) {
    throw new Error("Este navegador no soporta notificaciones.");
  }
  if (Notification.permission === "denied") {
    throw new Error("Bloqueaste las notificaciones en el navegador.");
  }
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Sin permiso no hay notificaciones.");
    }
  }
  // Service worker SIN claves (lee la config de la query): necesario para
  // que el push llegue con la app cerrada.
  const params = new URLSearchParams({
    apiKey: env("NEXT_PUBLIC_FIREBASE_API_KEY"),
    authDomain: env("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
    projectId: env("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
    messagingSenderId: env("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
    appId: env("NEXT_PUBLIC_FIREBASE_APP_ID"),
  });
  const registration = await navigator.serviceWorker.register(
    `/firebase-messaging-sw.js?${params.toString()}`,
  );
  const messaging = getMessaging(app);
  const token = await getToken(messaging, {
    vapidKey: env("NEXT_PUBLIC_FIREBASE_VAPID_KEY"),
    serviceWorkerRegistration: registration,
  });
  if (token === "") {
    throw new Error("No se pudo obtener el token de notificaciones.");
  }
  const { data } = await getSupabaseClient().auth.getSession();
  const uid = data.session?.user.id ?? "";
  if (uid === "") {
    throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  const { error } = await getSupabaseClient()
    .from("push_tokens")
    .upsert(
      { user_id: uid, token, platform: "web" },
      { onConflict: "user_id,token" },
    );
  if (error !== null) {
    throw new Error("No se pudo guardar el token de notificaciones.");
  }
  return token;
}
