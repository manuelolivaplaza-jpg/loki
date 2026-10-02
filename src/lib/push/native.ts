"use client";

/**
 * Push nativo (Android vía Capacitor + FCM).
 *
 * Flujo: pide permiso, obtiene el token con el plugin PushNotifications y lo
 * guarda en `push_tokens` (upsert por usuario+token, plataforma "android" o
 * "ios") reutilizando la misma tabla que el push web (`src/lib/push/fcm.ts`).
 * Sin sesión no se guarda nada.
 *
 *   - pushNotificationReceived → avisa con el callback + evento
 *     `loki:push-received` (el inbox/toast existente llega por realtime de
 *     todos modos; esto es solo el aviso en primer plano).
 *   - pushNotificationActionPerformed → navega al link del payload
 *     (`data.link`, o `/notificaciones` si no trae).
 *
 * Sin claves reales aquí: el `google-services.json` de FCM va en
 * `android/app/` (ver README "Android (Capacitor)"), nunca en el repo.
 */

import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  ActionPerformed,
  PushNotificationSchema,
} from "@capacitor/push-notifications";

export type NativePushHandlers = {
  onNotification?: (title: string, body: string, link: string) => void;
  onAction?: (link: string) => void;
};

export type PushReceivedDetail = { title: string; body: string; link: string };

function notificationLink(
  notification: PushNotificationSchema,
): string {
  const data = (notification.data ?? {}) as Record<string, unknown>;
  const link = data["link"];
  if (typeof link === "string" && link.startsWith("/")) return link;
  return "/notificaciones";
}

function notificationText(notification: PushNotificationSchema): {
  title: string;
  body: string;
} {
  const title =
    typeof notification.title === "string" && notification.title !== ""
      ? notification.title
      : "Loki";
  const body =
    typeof notification.body === "string" ? notification.body : "";
  return { title, body };
}

/** ¿Corre en nativo? (import dinámico para no romper el bundle web). */
export async function isNativePlatform(): Promise<boolean> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function rgbToHex(rgb: string): string | null {
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(rgb);
  if (match === null) return null;
  const toHex = (n: number): string =>
    Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${toHex(Number(match[1]))}${toHex(Number(match[2]))}${toHex(Number(match[3]))}`;
}

/**
 * Marco nativo (Android): la barra de estado no se monta sobre la app
 * (`overlay: false`, el WebView empieza debajo de la batería/hora) y toma
 * el color de fondo del tema actual. Sin esto el `env(safe-area-inset-top)`
 * vale 0 en el WebView y el contenido queda tapado.
 */
export async function setupNativeChrome(): Promise<void> {
  const { Capacitor } = await import("@capacitor/core");
  if (!Capacitor.isNativePlatform() || typeof document === "undefined") return;
  const { StatusBar, Style } = await import("@capacitor/status-bar");
  await StatusBar.setOverlaysWebView({ overlay: false });
  const dark = document.documentElement.classList.contains("dark");
  await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  const bg = rgbToHex(getComputedStyle(document.body).backgroundColor);
  if (bg !== null) {
    try {
      await StatusBar.setBackgroundColor({ color: bg });
    } catch {
      // Versiones viejas sin soporte: el fondo del config basta.
    }
  }
}

/**
 * Registra el push nativo y deja los listeners puestos. Lanza en español si
 * no es nativo, si no hay permiso o si no hay sesión.
 *
 * @param navigate navegar al link (p. ej. `router.push`).
 */
export async function registerNativePush(
  navigate: (link: string) => void,
  handlers?: NativePushHandlers,
): Promise<string> {
  const { Capacitor } = await import("@capacitor/core");
  if (!Capacitor.isNativePlatform()) {
    throw new Error("El push nativo solo funciona en la app Android.");
  }
  const { PushNotifications } = await import("@capacitor/push-notifications");

  // Canal de Android (importancia alta + sonido): el servidor manda
  // `channel_id: "loki_default"`. Sin canal, algunos equipos lo silencian.
  //
  // Botón "Hecho" en la push: hoy NO. Un botón necesita que el servidor mande
  // `android.notification.actions` y que la app tenga un receptor nativo que
  // ejecute la acción (el plugin solo gestiona el toque). Como no lo hay, el
  // aviso de turno abre la tarea directa (`data.link`), que es exactamente lo
  // que hace `pushNotificationActionPerformed` más abajo. Cuando se añada el
  // receptor, aquí se documenta el contrato: `action: "complete_task"` +
  // `data.task_id`, y la acción se resuelve con el JWT del usuario.
  try {
    await PushNotifications.createChannel({
      id: "loki_default",
      name: "Avisos de Loki",
      description: "Menciones, respuestas, tareas y recordatorios.",
      importance: 4,
      sound: "default",
      vibration: true,
    });
  } catch {
    // Ya existe o la plataforma no usa canales: se sigue igual.
  }

  const current = await PushNotifications.checkPermissions();
  const granted =
    current.receive === "granted"
      ? current
      : await PushNotifications.requestPermissions();
  if (granted.receive !== "granted") {
    throw new Error("Sin permiso no hay notificaciones.");
  }

  const token = await new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      fn();
    };
    void PushNotifications.addListener("registration", (event) => {
      finish(() => resolve(event.value));
    });
    void PushNotifications.addListener("registrationError", (event) => {
      finish(() => reject(new Error("No se pudo registrar el push.")));
      void event;
    });
    void PushNotifications.register().catch((error: unknown) => {
      finish(() => {
        reject(
          error instanceof Error
            ? error
            : new Error("No se pudo registrar el push."),
        );
      });
    });
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
      { user_id: uid, token, platform: Capacitor.getPlatform() },
      { onConflict: "user_id,token" },
    );
  if (error !== null) {
    throw new Error("No se pudo guardar el token de notificaciones.");
  }

  await PushNotifications.addListener(
    "pushNotificationReceived",
    (notification) => {
      const { title, body } = notificationText(notification);
      const link = notificationLink(notification);
      handlers?.onNotification?.(title, body, link);
      if (typeof window !== "undefined") {
        const detail: PushReceivedDetail = { title, body, link };
        window.dispatchEvent(
          new CustomEvent<PushReceivedDetail>("loki:push-received", {
            detail,
          }),
        );
      }
    },
  );

  await PushNotifications.addListener(
    "pushNotificationActionPerformed",
    (action: ActionPerformed) => {
      const link = notificationLink(action.notification);
      handlers?.onAction?.(link);
      navigate(link);
    },
  );

  return token;
}
