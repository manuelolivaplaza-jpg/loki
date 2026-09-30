import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor: Loki en Android sobre el export estático (`out/`).
 *
 * - appId "cl.loki.app", appName "Loki", webDir "out".
 * - Deep links: https://loki.cl/invite (App Links) + scheme loki://invite
 *   (ver el intent-filter en android/app/src/main/AndroidManifest.xml y
 *   `src/components/pwa/deep-links.tsx`).
 * - Push nativo con FCM: el `google-services.json` va en `android/app/`
 *   (no se sube al repo, ver README "Android (Capacitor)").
 * - Dev con cleartext (http://10.0.2.2 al Supabase local) solo como
 *   comentario: desactívalo en release.
 */
const config: CapacitorConfig = {
  appId: "cl.loki.app",
  appName: "Loki",
  webDir: "out",
  android: {
    // allowMixedContent: false por defecto en release.
  },
  server: {
    androidScheme: "https",
    // Solo DEV local (nunca en release):
    // cleartext: true,
    // url: "http://10.0.2.2:3000",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      launchAutoHide: true,
      backgroundColor: "#ffffff",
      androidSplashResourceName: "splash",
      showSpinner: false,
    },
    StatusBar: {
      style: "default",
      backgroundColor: "#ffffff",
    },
    Keyboard: {
      resize: "ionic",
      resizeOnFullScreen: true,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    // App: deep links vía `appUrlOpen` (ver DeepLinks). Sin opciones.
    // Haptics/Share/Camera sin opciones: se configuran por llamada.
  },
};

export default config;
