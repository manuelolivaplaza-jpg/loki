/**
 * T18: cortafuegos de despliegue.
 *
 * En la fase 1-2 el backend de Loki IA está APAGADO a propósito: la UI
 * funciona con el streaming simulado (`NEXT_PUBLIC_AI_ENABLED !== "true"`)
 * y el proyecto Blaze solo se activa en una fase posterior. Este script
 * está enganchado a `predeploy` en `firebase.json` (raíz) y a `npm run
 * deploy` aquí, así que un `firebase deploy` accidental para antes de
 * escribir un mensaje claro en vez de publicar funciones contra un
 * proyecto real.
 *
 * OJO con la ruta del hook: firebase-tools corre los hooks desde la RAÍZ
 * del proyecto, así que `predeploy` tiene que llamar a este archivo con
 * `"$RESOURCE_DIR"` (la variable que apunta a `functions.source`), no con
 * un `scripts/no-deploy.cjs` a secas. Con comillas dobles porque en
 * Windows el hook pasa por cmd.exe.
 */
"use strict";

process.exitCode = 1;
process.stderr.write(
  [
    "",
    "  DEPLOY PROHIBIDO en las fases 1-2 de Loki IA.",
    "",
    "  Las Cloud Functions de functions/ (aiChat, onMention, smartReminders)",
    "  compilan con `npm run build` pero no se despliegan: el proyecto sigue",
    "  en el plan gratuito y la IA está apagada por diseño",
    "  (NEXT_PUBLIC_AI_ENABLED=false).",
    "",
    "  Para el despliegue hay que (a) pasar el proyecto al plan Blaze,",
    "  (b) definir los secretos GEMINI_API_KEY / ANTHROPIC_API_KEY y",
    "  AI_PROVIDER, y (c) poner NEXT_PUBLIC_AI_ENABLED=true en el build de",
    "  la app. Ver functions/README.md.",
    "",
  ].join("\n"),
);
