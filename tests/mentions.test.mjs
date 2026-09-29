/**
 * T15: unitario ligero del parser de menciones.
 * Sin runner (ni node --test ni vitest) y sin firebase: solo node:assert.
 * Uso: `node tests/mentions.test.mjs` (o `npm run test:mentions`).
 */
import assert from "node:assert/strict";

import {
  LOKI_CANDIDATE,
  LOKI_DISABLED_MENTION,
  LOKI_DISABLED_TEXT,
  LOKI_DISPLAY_NAME,
  LOKI_MENTION_ID,
  MENTION_COLOR,
  buildLokiDisabledMessage,
  buildMentionToken,
  filterMentionCandidates,
  getMentionQuery,
  insertMention,
  isAiEnabled,
  mentionsLoki,
  normalizeMention,
  parseMentionSegments,
  resolveMentionIds,
} from "../src/lib/chat/mentions.ts";

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

const MEMBERS = [
  { id: "ana-uid", displayName: "Ana" },
  { id: "bruno-uid", displayName: "Bruno Díaz" },
  { id: "nino-uid", displayName: "Niño" },
];
const ALL = [LOKI_CANDIDATE, ...MEMBERS];

// --- getMentionQuery ---------------------------------------------------------
deep(getMentionQuery("hola @", 6), { start: 5, query: "" }, "arroba al final abre");
deep(getMentionQuery("hola @an", 8), { start: 5, query: "an" }, "query parcial");
deep(
  getMentionQuery("hola @an resto", 8),
  { start: 5, query: "an" },
  "caret en medio del token",
);
equal(getMentionQuery("hola mundo", 10), null, "sin arroba no hay query");
equal(getMentionQuery("mail a@b.com", 8), null, "email no abre menú");
equal(getMentionQuery("hola @an!", 9), null, "signo corta el token");
deep(getMentionQuery("@lok", 4), { start: 0, query: "lok" }, "arroba al inicio");
deep(
  getMentionQuery("(@br", 4),
  { start: 1, query: "br" },
  "tras paréntesis abre",
);

// --- filterMentionCandidates -------------------------------------------------
deep(filterMentionCandidates(ALL, ""), ALL, "query vacía trae todo");
deep(filterMentionCandidates(ALL, "lok"), [LOKI_CANDIDATE], "@lok filtra a Loki");
deep(filterMentionCandidates(ALL, "ai"), [LOKI_CANDIDATE], "@ai filtra a Loki");
deep(
  filterMentionCandidates(ALL, "AN"),
  [{ id: "ana-uid", displayName: "Ana" }],
  "filtro insensible a mayúsculas",
);
deep(
  filterMentionCandidates(ALL, "nino"),
  [{ id: "nino-uid", displayName: "Niño" }],
  "filtro sin tildes",
);
deep(filterMentionCandidates(ALL, "zzz"), [], "sin resultados = [] (cierra menú)");

// --- resolveMentionIds -------------------------------------------------------
deep(resolveMentionIds("hola @Ana", ALL), ["ana-uid"], "resuelve uid de miembro");
deep(
  resolveMentionIds("@Loki ayuda", ALL),
  [LOKI_MENTION_ID],
  "@Loki resuelve a loki",
);
deep(resolveMentionIds("oye @ai", ALL), [LOKI_MENTION_ID], "@ai resuelve a loki");
deep(
  resolveMentionIds("@BrunoDíaz ven", ALL),
  ["bruno-uid"],
  "resuelve nombre compuesto sin espacio",
);
deep(resolveMentionIds("hola mundo", ALL), [], "sin tokens no hay uids");
deep(resolveMentionIds("hola @Zzz", ALL), [], "token desconocido no resuelve");

// --- T15 intento 2: token compacto "@LuciaRuiz" (bug E2E verificado) --------
const LUCIA = { id: "lucia-uid", displayName: "Lucia Ruiz" };
const ALL_LUCIA = [LOKI_CANDIDATE, ...MEMBERS, LUCIA];
equal(
  buildMentionToken(LUCIA),
  "@LuciaRuiz",
  "inserta Lucia Ruiz -> token @LuciaRuiz (sin espacio)",
);
{
  // Simula elegir "Lucia Ruiz" del menú con query "@Lu": reemplaza [5,8).
  const inserted = insertMention("hola @Lu", 5, 8, LUCIA);
  deep(
    inserted,
    { text: "hola @LuciaRuiz ", caret: 5 + "@LuciaRuiz".length + 1 },
    "insertMention compacta el displayName y deja espacio separador",
  );
  deep(
    resolveMentionIds(inserted.text, ALL_LUCIA),
    ["lucia-uid"],
    "resolveMentionIds incluye uid de Lucia desde @LuciaRuiz",
  );
  ok(
    !inserted.text.includes("@Lucia Ruiz"),
    "el token insertado no conserva el espacio (regex OK)",
  );
}
deep(
  resolveMentionIds("hola @Lucia", ALL_LUCIA),
  ["lucia-uid"],
  "@Lucia (primer nombre único) resuelve a Lucia Ruiz",
);
{
  const DUP = [
    LOKI_CANDIDATE,
    LUCIA,
    { id: "lucia2-uid", displayName: "Lucia Gomez" },
  ];
  deep(
    resolveMentionIds("hola @Lucia", DUP),
    [],
    "@Lucia ambiguo (2 Lucías) no resuelve",
  );
  deep(
    resolveMentionIds("hola @LuciaGomez", DUP),
    ["lucia2-uid"],
    "@LuciaGomez compacto sí resuelve",
  );
}
{
  const insertedLoki = insertMention("oye @", 4, 5, LOKI_CANDIDATE);
  equal(insertedLoki.text, "oye @Loki ", "inserta @Loki con espacio separador");
  deep(
    resolveMentionIds(insertedLoki.text, ALL_LUCIA),
    [LOKI_MENTION_ID],
    "@Loki insertado resuelve a loki",
  );
  deep(
    resolveMentionIds("@loki", ALL_LUCIA),
    [LOKI_MENTION_ID],
    "@loki minúsculas resuelve a loki",
  );
}

// --- parseMentionSegments ----------------------------------------------------
deep(parseMentionSegments("hola mundo"), [{ text: "hola mundo", isMention: false }], "texto plano intacto");
deep(parseMentionSegments(""), [], "vacío sin segmentos");
{
  const segments = parseMentionSegments("hola @Ana, ven");
  deep(
    segments,
    [
      { text: "hola ", isMention: false },
      { text: "@Ana", isMention: true },
      { text: ", ven", isMention: false },
    ],
    "parte mención conocida",
  );
  equal(
    segments.map((s) => s.text).join(""),
    "hola @Ana, ven",
    "los segmentos rearmam el original",
  );
}
{
  const segments = parseMentionSegments("@loki ayuda");
  ok(segments[0]?.isMention === true, "@loki siempre resalta");
}
{
  const segments = parseMentionSegments("hola @Zzz", ["Ana"], ["x-uid"]);
  ok(segments[1]?.isMention === true, "lookup por mentions[] resalta");
}
{
  const segments = parseMentionSegments("hola @Zzz", ["Ana"], []);
  ok(segments[1]?.isMention === false, "nombre fuera de conocidos no resalta");
}

// --- mentionsLoki ------------------------------------------------------------
ok(mentionsLoki("@Loki ayuda"), "token @Loki");
ok(mentionsLoki("oye @ai"), "token @ai");
ok(mentionsLoki("hola loki"), "palabra loki");
ok(mentionsLoki("hola", ["loki"]), "id loki en mentions[]");
ok(!mentionsLoki("hola mundo"), "texto neutro no menciona");
ok(!mentionsLoki("hay pan"), "'hay' no es 'ai'");

// --- T18: el aviso no resaltada sus propias "@palabras" ------------------------
{
  // Con nombres conocidos (como los miembros del espacio) y solo la marca del
  // aviso, un "@Nombre" desconocido NO se resalta: la marca no arrastra.
  const segments = parseMentionSegments("hola @Zzz", ["Ana"], [LOKI_DISABLED_MENTION]);
  equal(
    segments[1]?.isMention,
    false,
    'la marca "loki-disabled" no hace resaltar un "@nombre" (el aviso es sutil)',
  );
  deep(
    parseMentionSegments("@loki ayuda", undefined, [LOKI_DISABLED_MENTION]),
    [{ text: "@loki", isMention: true }, { text: " ayuda", isMention: false }],
    "con la marca del aviso, @loki/@ai sigue resaltando (es token de Loki)",
  );
}

// --- flag + aviso ------------------------------------------------------------
equal(isAiEnabled("true"), true, "flag true habilita");
equal(isAiEnabled("false"), false, "flag false deshabilita");
equal(isAiEnabled(undefined), false, "sin flag deshabilita (default)");
equal(LOKI_DISABLED_TEXT, "Loki está desactivada. Actívala en Configuración → Loki IA.", "texto exacto del aviso");
equal(LOKI_DISABLED_MENTION, "loki-disabled", "marca del aviso");
equal(MENTION_COLOR, "#1D9BF0", "color de resaltado");
equal(LOKI_DISPLAY_NAME, "Loki", "nombre visible de la IA");
{
  const payload = buildLokiDisabledMessage("user-1", "Ana");
  deep(
    payload,
    {
      authorId: "user-1",
      authorName: "Ana",
      text: LOKI_DISABLED_TEXT,
      mentions: [LOKI_DISABLED_MENTION],
      type: "system",
    },
    "aviso type system con authorId propio (reglas OK)",
  );
}
equal(normalizeMention("Niño"), "nino", "normalize quita tildes");

console.log(`mentions.test.mjs: ${checks} checks OK`);
