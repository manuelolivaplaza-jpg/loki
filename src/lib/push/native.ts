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
