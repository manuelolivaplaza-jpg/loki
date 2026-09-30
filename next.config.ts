import type { NextConfig } from "next";

const isCapacitor = process.env.BUILD_TARGET === "capacitor";

/**
 * T35: cabeceras de seguridad (CSP, frame-ancestors, nosniff, referrer).
 *
 * Compatible con export estático + Supabase + Capacitor:
 * - `gap:`/`capacitor:` para el puente nativo, `blob:`/`data:` para
 *   adjuntos y avatares, `http://127.0.0.1:*` + `https:`/`wss:` para el
 *   Supabase local/real y FCM.
 * - `unsafe-inline`/`unsafe-eval` en scripts: los exige Next/Tailwind en
 *   cliente; el HTML de mensajes/posts nunca se inyecta (texto plano +
 *   `SafeText`), así que no hay XSS por contenido.
 * - Con `output: "export"` Next no sirve cabeceras en el archivo estático;
 *   aplican en `next dev`/`next start` y en el hosting (Vercel/Firebase).
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self' capacitor: gap:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' capacitor: gap:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "media-src 'self' blob: data: https:",
      "connect-src 'self' capacitor: gap: blob: data: http://127.0.0.1:* http://localhost:* https: wss: ws:",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];

const nextConfig: NextConfig = isCapacitor
  ? {
      output: "export",
      trailingSlash: true,
      images: { unoptimized: true },
    }
  : {
      devIndicators: false,
      headers: () => Promise.resolve([{ source: "/:path*", headers: securityHeaders }]),
    };

export default nextConfig;
