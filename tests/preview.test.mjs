/**
 * T18: unitario ligero de la regla del preview de la lista de chats
 * (`preview.ts`). Sin runner (ni node --test ni vitest) y sin firebase: solo
 * node:assert.
 * Uso: `node tests/preview.test.mjs` (o `npm run test:preview`).
 *
 * Lo que se comprueba aquí es la decisión pura; que `sendMessage`
 * (`src/lib/data/chat.ts`) la aplique al batch lo une el typecheck.
 */
import assert from "node:assert/strict";

import { updatesChatPreview } from "../src/lib/chat/preview.ts";
import { LOKI_DISABLED_MENTION, buildLokiDisabledMessage } from "../src/lib/chat/mentions.ts";

let checks = 0;
function ok(value, message) {
  checks += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}
function deep(actual, expected, message) {
  checks += 1;
  assert.deepEqual(actual, expected, message);
}

// --- El tipo por defecto (mensaje normal) sí actualiza el preview -----------
equal(updatesChatPreview(), true, "sin type se asume 'user' y actualiza");
equal(updatesChatPreview("user"), true, "'user' actualiza el preview");
equal(updatesChatPreview("post"), true, "'post' (T17) actualiza el preview");
equal(updatesChatPreview("ai"), true, "'ai' (backend con Admin SDK) actualiza el preview");

// --- Un mensaje de sistema NO lo actualiza ---------------------------------
equal(updatesChatPreview("system"), false, "'system' NO actualiza lastMessage/updatedAt");

// El aviso real de IA desactivada: al ser type "system" deja el preview del
// chat en el último mensaje real del usuario ("Manu Oliva: oye @Loki …").
{
  const aviso = buildLokiDisabledMessage("user-1", "Manu Oliva");
  equal(aviso.type, "system", "el aviso es type system");
  deep(aviso.mentions, [LOKI_DISABLED_MENTION], "con la marca loki-disabled");
  ok(
    !updatesChatPreview(aviso.type),
    "el aviso 'Loki está desactivada…' deja el preview del último mensaje real",
  );
}

console.log(`preview.test.mjs: ${checks} checks OK`);
