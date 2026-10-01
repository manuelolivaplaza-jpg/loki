/**
 * Unitario del analizador determinista de intenciones (`src/lib/chat/intent.ts`).
 * Sin runner y sin dependencias: solo node:assert. Uso: `node tests/intent.test.mjs`.
 *
 * Incluye `intent-sync`: la copia de la Edge
 * (`supabase/functions/_shared/intent.ts`) debe ser idéntica al original.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeIntent,
  extractIntentMentions,
  santiagoOffsetMinutes,
} from "../src/lib/chat/intent.ts";

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

// Jueves 2026-10-01 12:00 UTC = 09:00 en Santiago (verano, UTC-3).
const NOW = new Date("2026-10-01T12:00:00.000Z");

// --- Zona horaria ----------------------------------------------------------
equal(santiagoOffsetMinutes(Date.UTC(2026, 0, 15)), -180, "enero es verano (UTC-3)");
equal(santiagoOffsetMinutes(Date.UTC(2026, 6, 15)), -240, "julio es invierno (UTC-4)");
equal(santiagoOffsetMinutes(Date.UTC(2026, 8, 1)), -240, "1 sept antes del cambio: invierno");
equal(santiagoOffsetMinutes(Date.UTC(2026, 8, 10)), -180, "10 sept tras el cambio: verano");
equal(santiagoOffsetMinutes(Date.UTC(2026, 3, 1)), -180, "1 abr antes del cambio: verano");
equal(santiagoOffsetMinutes(Date.UTC(2026, 3, 10)), -240, "10 abr tras el cambio: invierno");

// --- Recordatorio puntual ---------------------------------------------------
const r1 = analyzeIntent("recuérdame mañana a las 9 sacar la basura", { now: NOW });
ok(r1 !== null, "detecta recuérdame");
equal(r1.action, "remind", "acción remind");
equal(r1.title, "sacar la basura", "título limpio");
equal(r1.dateISO, "2026-10-02T12:00:00.000Z", "mañana 9:00 Santiago = 12:00Z");
equal(r1.confident, true, "seguro sin modelo");

// --- Lista -------------------------------------------------------------------
const l1 = analyzeIntent("agrega leche a la lista del súper", { now: NOW });
ok(l1 !== null, "detecta agregar a la lista");
equal(l1.action, "add_list", "acción add_list");
equal(l1.title, "leche", "ítem limpio");
equal(l1.listName, "super", "nombre de la lista");
equal(l1.dateISO, null, "sin fecha");
equal(l1.confident, true, "seguro sin modelo");

// --- Evento con día de semana y 24 h ------------------------------------------
const e1 = analyzeIntent("agenda reunión el viernes a las 17:30", { now: NOW });
ok(e1 !== null, "detecta agenda");
equal(e1.action, "create_event", "acción create_event");
equal(e1.title, "reunion", "conserva el sustantivo");
equal(e1.dateISO, "2026-10-02T20:30:00.000Z", "viernes 17:30 Santiago = 20:30Z");
equal(e1.confident, true, "seguro sin modelo");

// --- am/pm ---------------------------------------------------------------------
const e2 = analyzeIntent("recuérdame hoy a las 5pm comprar pan", { now: NOW });
ok(e2 !== null, "detecta 5pm");
equal(e2.dateISO, "2026-10-01T20:00:00.000Z", "5pm = 17:00 Santiago");
equal(e2.title, "comprar pan", "título con pm");

// --- Recurrencias --------------------------------------------------------------
const w1 = analyzeIntent("recuérdame cada lunes a las 8 el standup", { now: NOW });
ok(w1 !== null, "detecta cada lunes");
deep(w1.recurrence, { kind: "weekly", value: 1, time: "08:00" }, "recurrencia semanal lunes 8:00");
equal(w1.confident, true, "seguro sin modelo");

const d1 = analyzeIntent("recuérdame todos los días a las 8 tomar agua", { now: NOW });
ok(d1 !== null, "detecta todos los días");
deep(d1.recurrence, { kind: "daily", value: 0, time: "08:00" }, "recurrencia diaria 8:00");

const m1 = analyzeIntent("recuérdame el 5 de cada mes pagar el arriendo", { now: NOW });
ok(m1 !== null, "detecta el 5 de cada mes");
deep(m1.recurrence, { kind: "monthly", value: 5, time: null }, "recurrencia mensual día 5");

// --- Relativos ------------------------------------------------------------------
const h1 = analyzeIntent("recuérdame en 2 horas llamar a mamá", { now: NOW });
ok(h1 !== null, "detecta en 2 horas");
equal(h1.dateISO, "2026-10-01T14:00:00.000Z", "ahora + 2 h");

const p1 = analyzeIntent("avísame pasado mañana dentista", { now: NOW });
ok(p1 !== null, "detecta pasado mañana");
equal(p1.dateISO, "2026-10-03T12:00:00.000Z", "pasado mañana 9:00 por defecto");

// --- No seguro / no intención ----------------------------------------------------
const n1 = analyzeIntent("recuérdame a las 9", { now: NOW });
ok(n1 !== null && n1.confident === false, "sin qué: no seguro");
equal(analyzeIntent("hola cómo estás", { now: NOW }), null, "charla no es intención");
equal(analyzeIntent("qué tareas tengo", { now: NOW }), null, "lecturas van al modelo");

// --- Menciones ----------------------------------------------------------------------
deep(extractIntentMentions("recuérdale a @Juan comprar pan"), ["juan"], "extrae @mención");

// --- Sincronía con la Edge -------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../src/lib/chat/intent.ts"), "utf8");
const edge = readFileSync(
  resolve(here, "../supabase/functions/_shared/intent.ts"),
  "utf8",
);
equal(edge, src, "la copia de la Edge es idéntica al original");

console.log(`intent: ${checks} checks ok`);
