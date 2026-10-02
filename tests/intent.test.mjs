/**
 * Unitario del analizador determinista de intenciones (`src/lib/chat/intent.ts`).
 * Sin runner y sin dependencias: solo node:assert. Uso: `node tests/intent.test.mjs`.
 *
 * Incluye `intent-sync`: la copia de la Edge
 * (`supabase/functions/_shared/intent.ts`) debe ser idéntica al original.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeIntent,
  extractIntentMentions,
  parseQuantity,
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

// --- Cantidades ----------------------------------------------------------------------
deep(
  parseQuantity("2 kg de pan"),
  { quantity: "2", unit: "kg", text: "pan" },
  "2 kg de pan se separa",
);
deep(
  parseQuantity("3 huevos"),
  { quantity: "3", unit: "", text: "huevos" },
  "número sin unidad",
);
deep(
  parseQuantity("1 docena de huevos"),
  { quantity: "1", unit: "docena", text: "huevos" },
  "docena como unidad",
);
deep(
  parseQuantity("leche"),
  { quantity: "", unit: "", text: "leche" },
  "sin número no hay cantidad",
);

// --- Listas: varios ítems y sin nombre -------------------------------------------
const l2 = analyzeIntent("agrega huevos y leche a la lista del súper", { now: NOW });
ok(l2 !== null, "detecta varios ítems");
equal(l2.action, "add_list", "acción add_list múltiple");
equal(l2.title, "huevos y leche", "título con los dos ítems");
equal(l2.listName, "super", "lista normalizada");
const l3 = analyzeIntent("agrega leche a la lista", { now: NOW });
ok(l3 !== null, "detecta lista sin nombre");
equal(l3.listName, null, "sin nombre de lista");

// --- Encuestas (create_poll) --------------------------------------------------------
// Jueves 2026-10-01: el viernes siguiente es el 2 y el sábado el 3.
const p10 = analyzeIntent("haz una encuesta para elegir el día del asado entre viernes y sábado", { now: NOW });
ok(p10 !== null, "detecta encuesta");
equal(p10.action, "create_poll", "acción create_poll");
equal(p10.title, "Elegir el día del asado", "pregunta con tildes");
equal(p10.pollKind, "date", "día dicho = encuesta de fecha");
equal(p10.confident, true, "seguro sin modelo");
deep(
  p10.pollOptions.map((o) => [o.text, o.startsAt]),
  [
    ["Viernes", "2026-10-02T22:00:00.000Z"],
    ["Sábado", "2026-10-03T22:00:00.000Z"],
  ],
  "viernes y sábado a las 19:00 Santiago (22:00Z)",
);

const p11 = analyzeIntent("crea una encuesta: pizza o sushi", { now: NOW });
equal(p11.action, "create_poll", "encuesta de dos opciones");
equal(p11.title, "Pizza o sushi", "la pregunta es el todo, no media opción");
equal(p11.pollKind, "single", "opción única");
deep(p11.pollOptions.map((o) => o.text), ["Pizza", "Sushi"], "opciones sueltas");

const p12 = analyzeIntent("armemos una encuesta para aprobar el diseño", { now: NOW });
equal(p12.action, "create_poll", "detecta aprobación");
equal(p12.pollKind, "yesno", "sí/no rápido");
equal(p12.pollOptions.length, 0, "el sí/no no trae opciones");
equal(p12.confident, true, "aprobación sin opciones es segura");

const p13 = analyzeIntent("encuesta de varias opciones: rojo, verde o azul", { now: NOW });
equal(p13.pollKind, "multiple", "varias opciones");
deep(p13.pollOptions.map((o) => o.text), ["Rojo", "Verde", "Azul"], "lista con comas y 'o'");

// Sin 'entre', con dos puntos: la pregunta es lo que va antes.
const p14 = analyzeIntent("pon una encuesta para saber qué hacemos el finde: asado o pizza", { now: NOW });
equal(p14.title, "Saber qué hacemos el finde", "pregunta antes de los dos puntos");
deep(p14.pollOptions.map((o) => o.text), ["Asado", "Pizza"], "opciones tras los dos puntos");

// Una opción que no es un día: mejor encuesta de texto que fecha inventada.
const p15 = analyzeIntent("haz una encuesta para elegir el día entre pizza y sushi", { now: NOW });
equal(p15.pollKind, "single", "sin día resoluble no se fuerza la fecha");
equal(p15.pollOptions.every((o) => o.startsAt === null), true, "opciones sin fecha");

// "encuesta" suelta no es intención de encuesta (ni de nada): sigue null.
equal(analyzeIntent("la encuesta de la semana pasada", { now: NOW }), null, "no fuerza encuesta");

// --- Memoria del espacio (sin LLM) ---------------------------------------------
const mem1 = analyzeIntent("Loki, recuerda que la clave del wifi es Wifi2026", { now: NOW });
ok(mem1 !== null, "detecta 'recuerda que'");
equal(mem1.action, "remember", "acción remember");
equal(mem1.title, "la clave del wifi es Wifi2026", "recupera el texto con tildes del original");
equal(mem1.dateISO, null, "recordar un dato no lleva fecha");
equal(mem1.confident, true, "seguro sin modelo");

const mem2 = analyzeIntent("anota que Tomás es alérgico al maní", { now: NOW });
ok(mem2 !== null, "detecta 'anota que'");
equal(mem2.action, "remember", "acción remember");
equal(mem2.title, "Tomás es alérgico al maní", "dato de salud limpio");

// "recuerda que" es memoria, NO recordatorio: no hay fecha que pedir.
const mem3 = analyzeIntent("recuerda que el portón es 1234", { now: NOW });
equal(mem3.action, "remember", "no cae en remind");

// El recordatorio clásico sigue siendo recordatorio.
const mem4 = analyzeIntent("recuérdame mañana a las 9 sacar la basura", { now: NOW });
equal(mem4.action, "remind", "recuérdame sigue siendo aviso con fecha");

const mem5 = analyzeIntent("¿cuál era la clave del wifi?", { now: NOW });
ok(mem5 !== null, "detecta la pregunta de recall");
equal(mem5.action, "recall", "acción recall");
equal(mem5.title, "cuál era la clave del wifi", "el recall busca la pregunta sin signos");

// Ambiguo ("acuérdate de la reunión" puede ser un aviso): sin una señal clara
// de memoria, el analizador no fuerza nada y sigue el camino del modelo.
equal(
  analyzeIntent("acuérdate de la reunión", { now: NOW }),
  null,
  "una frase ambigua no se fuerza a memoria",
);

// --- Comandos al PC (sin LLM) -------------------------------------------------
const pc1 = analyzeIntent("@mi-pc abre Spotify", { now: NOW });
ok(pc1 !== null, "detecta @mi-pc");
equal(pc1.action, "device_command", "acción device_command");
equal(pc1.deviceAction, "open_app", "abrir app");
equal(pc1.deviceArgs["text"], "Spotify", "la app con mayúscula del original");
equal(pc1.confident, true, "seguro sin modelo");

const pc2 = analyzeIntent("toma una captura de mi pc", { now: NOW });
ok(pc2 !== null, "detecta la marca al final");
equal(pc2.deviceAction, "screenshot", "captura");

const pc3 = analyzeIntent("mi-pc pon el volumen al 50", { now: NOW });
equal(pc3.deviceAction, "volume_set", "volumen");
equal(pc3.deviceArgs["level"], "50", "nivel como texto");

const pc4 = analyzeIntent("@mi-pc ejecuta el script respaldo", { now: NOW });
equal(pc4.deviceAction, "run_script", "script registrado");
equal(pc4.deviceArgs["text"], "respaldo", "nombre del script");

const pc5 = analyzeIntent("@mi-pc ejecuta: ls -la", { now: NOW });
equal(pc5.deviceAction, "arbitrary_exec", "terminal libre");
equal(pc5.confident, true, "se detecta (la confirmación la pide la tarjeta)");

const pc6 = analyzeIntent("@mi-pc abre https://example.com", { now: NOW });
equal(pc6.deviceAction, "open_url", "URL va por open_url");

const pc7 = analyzeIntent("pausa la música de mi pc", { now: NOW });
equal(pc7.deviceAction, "media_control", "multimedia");

// Sin marca al PC no hay comando (no roba "abre Spotify" normal).
equal(analyzeIntent("abre Spotify", { now: NOW })?.action ?? null, null, "sin marca no hay comando");
equal(analyzeIntent("@mi-pc", { now: NOW }), null, "marca sola no alcanza");

// --- Tareas recurrentes y turnos (create_series / shift_query) ------------------
// "cada martes saca la basura" -> serie semanal, sin rotación.
const s1 = analyzeIntent("cada martes saca la basura", { now: NOW });
ok(s1 !== null, "detecta serie");
equal(s1.action, "create_series", "acción create_series");
equal(s1.title, "saca la basura", "título de la serie");
deep(s1.series.weekdays, [2], "semanal los martes");
equal(s1.series.rotates, false, "sin rotación cuando no se pide");
equal(s1.confident, true, "seguro sin modelo");

// Con gente nombrada: rota entre ellos, en orden.
const s2 = analyzeIntent(
  "cada domingo alguien distinto riega las plantas: Sofi, Tomás y yo",
  { now: NOW },
);
ok(s2 !== null, "detecta turno rotativo");
equal(s2.action, "create_series", "acción create_series con rotación");
equal(s2.title, "riega las plantas", "título sin la lista de gente");
deep(s2.series.weekdays, [0], "semanal los domingos");
equal(s2.series.rotates, true, "pide que rote");
deep(s2.series.people, ["sofi", "tomas", "yo"], "gente en orden, con el yo");

// Mensual por día de mes y por "último día de la semana".
const s3 = analyzeIntent("el 5 de cada mes pagar la luz", { now: NOW });
equal(s3.series.kind, "monthly", "mensual por día");
equal(s3.series.monthDay, 5, "el día 5");

const s4 = analyzeIntent("el último viernes del mes revisamos cuentas", { now: NOW });
equal(s4.series.kind, "monthly", "mensual por día de la semana");
equal(s4.series.monthWeek, 5, "el último");
equal(s4.series.monthWeekday, 5, "viernes");

// Intervalo.
const s5 = analyzeIntent("cada 3 días revisar el correo", { now: NOW });
equal(s5.series.kind, "interval", "cada N días");
equal(s5.series.interval, 3, "N = 3");
equal(s5.series.unit, "days", "unidad días");

// Turno rotativo sin día: propone hoy y la tarjeta deja cambiarlo.
const s6 = analyzeIntent("turno rotativo para sacar la basura: Sofi y yo", { now: NOW });
equal(s6.series.rotates, true, "turno rotativo");
deep(s6.series.people, ["sofi", "yo"], "padrón de dos");

// "¿A quién le toca…?" no necesita modelo.
const q1 = analyzeIntent("¿a quién le toca la loza?", { now: NOW });
ok(q1 !== null, "detecta pregunta de turno");
equal(q1.action, "shift_query", "acción shift_query");
equal(q1.title, "loza", "la tarea preguntada");

// Un recordatorio con "le toca" sigue siendo recordatorio.
const q2 = analyzeIntent("recuérdale a Sofi que le toca la basura", { now: NOW });
equal(q2?.action ?? null, "remind", "el aviso no se convierte en pregunta");

// --- Sincronía con la Edge -------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../src/lib/chat/intent.ts"), "utf8");
const edge = readFileSync(
  resolve(here, "../supabase/functions/_shared/intent.ts"),
  "utf8",
);
equal(edge, src, "la copia de la Edge es idéntica al original");

// `memory.ts` también está duplicado (la Edge lo usa para las tarjetas): la
// copia debe ser idéntica byte a byte.
const memorySrc = readFileSync(resolve(here, "../src/lib/memory/memory.ts"), "utf8");
const memoryEdge = readFileSync(
  resolve(here, "../supabase/functions/_shared/memory.ts"),
  "utf8",
);
equal(memoryEdge, memorySrc, "la copia de memory.ts en la Edge es idéntica");

// `devices.ts` (catálogo del PC) también está duplicado: la Edge y la base
// (`device_action_risk`) espejan los mismos riesgos.
const devicesSrc = readFileSync(resolve(here, "../src/lib/devices/catalog.ts"), "utf8");
const devicesEdge = readFileSync(
  resolve(here, "../supabase/functions/_shared/devices.ts"),
  "utf8",
);
equal(devicesEdge, devicesSrc, "la copia de devices.ts en la Edge es idéntica");

console.log(`intent: ${checks} checks ok`);
