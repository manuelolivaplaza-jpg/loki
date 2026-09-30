/* Service worker de la PWA de Loki (export estático).
 *
 * Estrategia:
 *   - Navegación: network-first con fallback offline a /inicio (y si ni eso
 *     está en caché, una página offline mínima inline).
 *   - Estáticos del export (/_next/static, /icons, /*.png, /*.svg, /*.css,
 *     /*.js): cache-first con actualización en segundo plano.
 *   - Todo lo demás (Supabase, FCM): solo red, sin caché.
 *
 * La cola de mensajes sin conexión NO vive aquí (el export no tiene backend):
 * vive en el cliente (`src/lib/offline/outbox.ts` con localStorage + reintento
 * con `sendMessage` al volver online). Este worker solo cachea la app y pinta
 * la página offline mínima.
 */

const CACHE = "loki-app-v1";
const NAV_FALLBACKS = ["/inicio", "/inicio/", "/index.html", "/"];

function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.webmanifest" ||
    /\.(png|svg|ico|css|js|woff2?)$/.test(pathname)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(["/inicio", "/manifest.webmanifest"]).catch(() => undefined),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => (key === CACHE ? undefined : caches.delete(key))),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function offlinePage() {
  return new Response(
    "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>Sin conexión · Loki</title>" +
      "<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;" +
      "align-items:center;justify-content:center;margin:0;background:#fff;color:#0f1419}" +
      "main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}" +
      "p{font-size:15px;opacity:.7;margin:0 0 16px}" +
      "a{display:inline-block;padding:10px 20px;border-radius:999px;background:#0f1419;" +
      "color:#fff;text-decoration:none}</style></head>" +
      "<body><main><h1>Sin conexión</h1>" +
      "<p>Tus mensajes se guardan y se envían al volver la red.</p>" +
      "<a href=\"/inicio\">Ir a Inicio</a></main></body></html>",
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase/FCM: solo red.

  // Navegación: red primero, caché después, /inicio al final.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
          return res;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) =>
              cached ??
              caches
                .match("/inicio")
                .then((fallback) => fallback ?? offlinePage()),
          ),
        ),
    );
    return;
  }

  // Estáticos del export: caché primero.
  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches
                .open(CACHE)
                .then((cache) => cache.put(request, copy))
                .catch(() => undefined);
            }
            return res;
          })
          .catch(() => cached);
        return cached ?? network;
      }),
    );
  }
});
