/**
 * Analizador determinista de intenciones en español (sin LLM ni dependencias).
 *
 * Sintaxis "erasable" como `mentions.ts`: `tests/intent.test.mjs` lo importa
 * directo con Node >= 22 (type stripping). La Edge `loki-chat` usa la copia
 * idéntica en `supabase/functions/_shared/intent.ts` (el deploy no sale de
 * `supabase/functions`): si editas este archivo, copia el contenido tal cual
 * allá (el test `intent-sync` lo verifica).
 *
 * Zona horaria America/Santiago con horario de verano chileno (desde 2019:
 * empieza el primer sábado de septiembre a las 24:00 y termina el primer
 * sábado de abril a las 24:00; verano UTC-3, invierno UTC-4).
 */

export type IntentAction =
  | "remind"
  | "create_task"
  | "create_event"
  | "add_list"
  | "create_poll"
  | "remember"
  | "recall"
  | "device_command";

/** Tipos de encuesta que el analizador puede proponer sin modelo. */
export type PollIntentKind = "single" | "multiple" | "yesno" | "date";

/** Opción de la encuesta con su franja ya resuelta (solo kind 'date'). */
export interface PollIntentOption {
  text: string;
  /** ISO 8601 del inicio (null si el día no se pudo resolver). */
  startsAt: string | null;
  endsAt: string | null;
}

export interface IntentRecurrence {
  kind: "daily" | "weekly" | "monthly";
  /** 0=domingo..6=sábado (weekly). Día del mes 1-31 (monthly). */
  value: number;
  /** Hora local Santiago "HH:MM" si se dijo. */
  time: string | null;
}

export interface AnalyzedIntent {
  action: IntentAction;
  /** Título limpio (sin verbo, fecha ni menciones de lista). */
  title: string;
  /** ISO UTC del momento (una vez) o null. */
  dateISO: string | null;
  recurrence: IntentRecurrence | null;
  /** Tokens @mencionados normalizados (sin @). */
  mentions: string[];
  /** Nombre de la lista ("súper") en add_list, o null. */
  listName: string | null;
  /** Tipo de encuesta en create_poll, o null en el resto. */
  pollKind: PollIntentKind | null;
  /** Opciones en create_poll (vacío = sí/no o falta información). */
  pollOptions: PollIntentOption[];
  /** Acción del catálogo del PC en device_command, o null en el resto. */
  deviceAction: string | null;
  /** Argumentos de la acción (text/dir/level/muted/op), o {} en el resto. */
  deviceArgs: Record<string, string>;
  /** True = no hace falta llamar al modelo. */
  confident: boolean;
}

/** Minúsculas sin tildes para comparar. */
export function normalizeIntent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const WEEKDAYS: readonly string[] = [
  "domingo",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
];

function weekdayIndex(name: string): number {
  return WEEKDAYS.indexOf(name);
}

/** Primer sábado del mes (1-7) para un año/mes dados (mes 0-11). */
function firstSaturday(year: number, month: number): number {
  const day = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return ((6 - day + 7) % 7) + 1;
}

/**
 * Offset de Santiago en minutos (este, p. ej. -180) para un instante UTC.
 * Las transiciones ocurren a medianoche local del primer sábado de
 * septiembre (entra verano) y de abril (sale); se comparan por fecha UTC
 * con un día de holgura implícita (suficiente para intenciones del día a día).
 */
export function santiagoOffsetMinutes(utcMs: number): number {
  const date = new Date(utcMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  // Verano: septiembre (desde el día 5 aprox.) hasta marzo, más abril antes
  // del primer sábado y septiembre desde el primer sábado.
  if (month >= 4 && month <= 7) return -240; // may-ago: invierno seguro
  if (month >= 9 || month <= 2) return -180; // oct-mar: verano seguro
  if (month === 8) return day >= firstSaturday(year, 8) ? -180 : -240;
  // month === 3 (abril)
  return day < firstSaturday(year, 3) ? -180 : -240;
}

/** Componentes de la hora mural de Santiago para un instante UTC. */
function santiagoWall(utcMs: number): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutes: number;
} {
  const shifted = new Date(utcMs + santiagoOffsetMinutes(utcMs) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** Convierte una fecha mural de Santiago (día + minutos) a ISO UTC. */
function santiagoToISO(
  year: number,
  month: number,
  day: number,
  minutes: number,
): string {
  // Primera pasada con el offset de invierno; segunda con el del objetivo.
  const guessWinter = Date.UTC(year, month, day) + minutes * 60_000 - -240 * 60_000;
  const offset = santiagoOffsetMinutes(guessWinter);
  return new Date(Date.UTC(year, month, day) + minutes * 60_000 - offset * 60_000).toISOString();
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** "9" + posible sufijo -> minutos desde medianoche, o null. */
function parseHour(
  hourRaw: string,
  minuteRaw: string | undefined,
  suffixRaw: string | undefined,
): number | null {
  let hour = parseInt(hourRaw, 10);
  if (!Number.isFinite(hour) || hour > 23) return null;
  const minute = minuteRaw !== undefined ? parseInt(minuteRaw, 10) : 0;
  if (!Number.isFinite(minute) || minute > 59) return null;
  const suffix = (suffixRaw ?? "").replace(/\s+/g, "");
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  if (suffix === "manana" && hour > 12) return null;
  if ((suffix === "tarde" || suffix === "noche") && hour < 12) hour += 12;
  return hour * 60 + minute;
}

/**
 * Extrae hora del texto ("a las 5", "17:30", "5pm", "a las 9 de la noche").
 * Devuelve minutos y el fragmento matcheado para recortarlo del título.
 */
function extractTime(normalized: string): { minutes: number; span: string } | null {
  const patterns = [
    /a las (\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|de la manana|de la tarde|de la noche)?/,
    /(\d{1,2}):(\d{2})\s*(am|pm|hrs?|h)?/,
    /(\d{1,2})\s*(am|pm)\b/,
    /(\d{1,2})h\b/,
  ];
  for (const re of patterns) {
    const match = normalized.match(re);
    if (match === null) continue;
    const suffix = (match[3] ?? match[2] ?? "")
      .replace(/\./g, "")
      .replace("hrs", "")
      .replace("hr", "")
      .replace("h", "")
      .replace("de la ", "")
      .trim();
    const hasMinutes = match[2] !== undefined && /^\d{2}$/.test(match[2]);
    const minutes = parseHour(
      match[1] ?? "",
      hasMinutes ? match[2] : undefined,
      suffix === "" ? undefined : suffix,
    );
    if (minutes === null) continue;
    return { minutes, span: match[0] ?? "" };
  }
  return null;
}

function removeSpan(text: string, span: string): string {
  if (span === "") return text;
  // Siempre sobre el texto ya recortado: los índices del original no valen
  // tras el primer recorte (y los tildes cambian longitudes).
  const index = text.indexOf(span);
  if (index === -1) return text;
  return `${text.slice(0, index)}${text.slice(index + span.length)}`;
}

function cleanTitle(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:¡!¿?]+|[\s,.;:¡!¿?]+$/g, "")
    .trim()
    .slice(0, 200);
}

/** Unidades conocidas para "2 kg de pan" (minúsculas, sin tildes). */
const QUANTITY_UNITS: ReadonlySet<string> = new Set([
  "kg", "g", "gr", "mg", "l", "lt", "ml", "litro", "litros",
  "doc", "docena", "docenas", "paq", "paquete", "paquetes",
  "caja", "cajas", "botella", "botellas", "lata", "latas",
  "bolsa", "bolsas", "unidad", "unidades", "u", "ud", "uds",
  "kilo", "kilos", "gramo", "gramos", "taza", "tazas",
]);

export interface ParsedQuantity {
  /** "2" o "" si no había número. */
  quantity: string;
  /** "kg" o "" si no había unidad conocida. */
  unit: string;
  /** Resto ("pan"). */
  text: string;
}

/**
 * Separa "2 kg de pan" en cantidad/unidad/texto (sin IA). Solo cuando
 * empieza con número; "un par de" no cuenta como cantidad exacta.
 */
export function parseQuantity(raw: string): ParsedQuantity {
  const normalized = normalizeIntent(raw.trim());
  const match = normalized.match(/^(\d+(?:[.,]\d+)?)\s*([a-z]+)?\s+(.+)$/);
  if (match === null) {
    return { quantity: "", unit: "", text: raw.trim().slice(0, 200) };
  }
  const maybeUnit = (match[2] ?? "").trim();
  if (maybeUnit !== "" && !QUANTITY_UNITS.has(maybeUnit)) {
    // "3 huevos revueltos": número + texto (sin unidad).
    return {
      quantity: match[1] ?? "",
      unit: "",
      text: `${maybeUnit} ${match[3] ?? ""}`.trim().slice(0, 200),
    };
  }
  // Quita el "de" intermedio ("2 kg de pan" -> "pan").
  const rest = (match[3] ?? "").replace(/^de\s+/, "").trim();
  return {
    quantity: match[1] ?? "",
    unit: maybeUnit,
    text: (rest === "" ? match[3] ?? "" : rest).slice(0, 200),
  };
}

/** Extrae tokens @usuario normalizados (sin @). */
export function extractIntentMentions(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(/@[\p{L}\p{N}_.-]+/gu) ?? [];
  for (const token of matches) {
    const name = normalizeIntent(token.slice(1));
    if (name !== "" && !out.includes(name)) out.push(name);
  }
  return out;
}

export interface AnalyzeOptions {
  /** Instante de referencia (default: ahora). */
  now?: Date;
}

const REMIND_RE =
  /(recuerdame|recuerdale|recuerdanos|avisame|avisale|recordatorio|no (te|se) (olvide|olviden)|no olvidar)/;

// Memoria del espacio: "recuerda que la clave del wifi es…". Distinto de
// REMIND_RE porque aquí no hay fecha: es un dato, no una tarea con hora.
const REMEMBER_RE =
  /(recuerda que|recuerde que|recorda que|recuerda esto|apunta que|anota que|guarda en la memoria|guardar en la memoria|memori[ae]za)/;
// Pregunta por lo que el espacio ya sabe: "¿cuál era la clave del wifi?".
const RECALL_RE =
  /(cual era|cu[aá]l era|que recordaba|que sabemos de|te acuerdas de|recuerdas|recuerda (cual|que)|sabes (cual|la clave|mi |el |los |las )|dime (la|el|mi)|cual es la clave)/;
const REMEMBER_LEAD_RE =
  /^(?:por favor\s+)?(?:loki\s*,?\s*)?(?:recuerda que|recuerde que|recorda que|recuerda esto|apunta que|anota que|guarda en la memoria|guardar en la memoria|memori[ae]za)\s+/;

/**
 * Texto a recordar de "Loki, recuerda que la clave del wifi es X": quita el
 * saludo y el verbo, y devuelve solo el dato. `null` si no queda nada útil.
 */
function parseRemember(original: string, normalized: string): string | null {
  if (!REMEMBER_RE.test(normalized)) return null;
  // "guarda en la memoria" puede ir al final ("… es la clave; guárdalo en la
  // memoria"), así que también se recorta del final.
  const tail = normalized.match(/\s*(?:y\s+)?(?:guarda[r]?\s+en\s+la\s+memori[ae]za|guarda[r]?\s+esto\s+en\s+la\s+memori[ae]za)\s*$/);
  let rest = tail === null ? normalized : normalized.slice(0, tail.index);
  rest = rest.replace(REMEMBER_LEAD_RE, "");
  rest = rest.replace(/^loki\s*,?\s*/, "");
  if (rest.trim() === "") return null;
  return cleanTitle(restoreAccents(original, rest.trim()) || rest);
}
const TASK_RE = /(crea|crea|crear|agrega|agrega|anade|anota|suma)\s+(una\s+)?tarea/;
const EVENT_RE = /(agenda|agendar|crea|crear|agrega|anade|programa)\s+(un\s+)?(evento|cita|reunion|junta|llamada|clase)/;
const LIST_RE = /(agrega|agrega|anade|suma|anota|pon)\s+(.+?)\s+a la lista(?:\s+(?:(del|de la|de)\s+)?(.+))?$/;

function matchList(normalized: string): { item: string; list: string | null } | null {
  const match = normalized.match(LIST_RE);
  if (match === null) return null;
  const item = (match[2] ?? "").trim();
  const list = (match[4] ?? "").trim();
  if (item === "") return null;
  return { item, list: list === "" ? null : list };
}

// --- Encuestas (create_poll) -------------------------------------------------
//
// "haz una encuesta para elegir el día del asado entre viernes y sábado" se
// resuelve SIN modelo: la palabra "encuesta" da la acción, "entre X y Y" (o
// "X o Y", o "opciones: …") da las opciones, y si todas son días dichas se
// convierten en fechas de Santiago con la hora hablada (19:00 por defecto).
// La tarjeta de confirmación muestra y deja editar cada fecha.

const POLL_RE = /(encuesta|sondeo|votacion)/;
const POLL_YESNO_RE = /(aprob|aprueb|aprobacion|de acuerdo|estan de acuerdo|si o no)/;
const POLL_MULTI_RE = /(varias|multiple|mas de una opcion|pueden elegir mas de una)/;
const POLL_DATE_RE = /(elegir (el |la |los |las )?(dia|fecha)|que dia|fecha y hora|encuesta de fecha|agendar|reunirnos)/;
const POLL_BETWEEN_RE = /\bentre\s+(.+)$/;
const POLL_OPTIONS_RE = /\bopciones?\s*:?\s*(.+)$/;
const POLL_COLON_RE = /:\s*([^:]+)$/;
/** Última conjunción: "pizza o sushi", "viernes, sabado o domingo". */
const POLL_OR_TAIL_RE = /^(.+?)\s+o\s+(.+)$/;
const POLL_CONNECTOR_RE = /^(?:para|sobre|de|del|la|el|los|las|con|que|cual|cual es|que es)\s+/;
const POLL_LEAD_VERB_RE =
  /^(?:crea|crear|haz|hacer|armar|arma|manda|monta|montar|lanza|lanzar|sondea|sondear|propon|proponer|agrega|agregar|anade|anadir)\s+(?:una\s+|un\s+|unas\s+|unos\s+)?/;

function sentenceCase(text: string): string {
  const clean = cleanTitle(text);
  if (clean === "") return clean;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Recupera el texto ORIGINAL (con tildes) de un fragmento ya normalizado: se
 * busca la ventana del mismo largo que, sin tildes ni mayúsculas, coincide.
 * "Elegir el dia del asado" vuelve a ser "Elegir el día del asado".
 */
function restoreAccents(original: string, normalizedText: string): string {
  const target = normalizedText.trim();
  if (target === "") return "";
  for (let i = 0; i + target.length <= original.length; i += 1) {
    const window = original.slice(i, i + target.length);
    if (normalizeIntent(window) === target) return window;
  }
  return "";
}

/** "viernes y sabado", "rojo, verde o azul" -> opciones sueltas (máx 20). */
function splitPollOptions(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/\s*(?:,|;|\/|\||\bo\b|\by\b)\s*/)) {
    const text = cleanTitle(part).replace(/^(?:la|el|los|las)\s+/, "");
    if (text === "" || text.length > 120) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 20) break;
  }
  return out;
}

/** Día de Santiago (año/mes/día) que corresponde a una opción dicha. */
type PollDay = { year: number; month: number; day: number };

/** "este viernes" / "mañana" / "12 de marzo" -> día en Santiago, o null. */
function pollDayOf(text: string, wall: PollDay & { weekday: number }): PollDay | null {
  // La hora dicha no cambia el día: "14 de marzo a las 20" es el 14 de marzo.
  const normalized = normalizeIntent(text)
    .replace(/\s*(?:a las|de las)\s*\d{1,2}(?::\d{2})?.*$/, "")
    .replace(/\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|h|hrs).*$/, "")
    .trim();
  if (normalized === "") return null;
  const relative = normalized.match(/^(?:este|el|proximo|próximo|la|este proximo)\s+(.+)$/);
  const qualifier = (relative?.[1] ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const target = (relative?.[2] ?? normalized).trim();
  if (target === "hoy") return { year: wall.year, month: wall.month, day: wall.day };
  if (target === "manana") {
    const base = new Date(Date.UTC(wall.year, wall.month, wall.day + 1));
    return { year: base.getUTCFullYear(), month: base.getUTCMonth(), day: base.getUTCDate() };
  }
  if (target === "pasado manana") {
    const base = new Date(Date.UTC(wall.year, wall.month, wall.day + 2));
    return { year: base.getUTCFullYear(), month: base.getUTCMonth(), day: base.getUTCDate() };
  }
  const weekday = weekdayIndex(target);
  if (weekday >= 0) {
    let delta = (weekday - wall.weekday + 7) % 7;
    // "el viernes" siendo viernes = hoy; "próximo" siempre salta 7 días.
    if (delta === 0 && qualifier !== "este") delta = qualifier.includes("proximo") ? 7 : 0;
    if (qualifier.includes("proximo") && delta < 7) delta += 7;
    const base = new Date(Date.UTC(wall.year, wall.month, wall.day + delta));
    return { year: base.getUTCFullYear(), month: base.getUTCMonth(), day: base.getUTCDate() };
  }
  const dayMonth = target.match(/^(\d{1,2})\s+de\s+([a-z]+)$/);
  if (dayMonth !== null) {
    const day = parseInt(dayMonth[1] ?? "0", 10);
    const months = [
      "enero", "febrero", "marzo", "abril", "mayo", "junio",
      "julio", "agosto", "septiembre", "setiembre", "octubre", "noviembre", "diciembre",
    ];
    const month = months.indexOf((dayMonth[2] ?? "").trim());
    if (month >= 0 && day >= 1 && day <= 31) {
      // Un día ya pasado este año es del año que viene.
      const passed = (month < wall.month) || (month === wall.month && day < wall.day);
      return { year: wall.year + (passed ? 1 : 0), month, day };
    }
  }
  return null;
}

type PollParse = {
  kind: PollIntentKind;
  question: string;
  options: PollIntentOption[];
};

/**
 * Parsea el pedido de encuesta sin modelo. Devuelve null si no se puede armar
 * algo decente (el llamador sigue al modelo).
 */
function parsePoll(
  original: string,
  normalized: string,
  wall: { year: number; month: number; day: number; weekday: number },
  minutes: number | null,
): PollParse | null {
  const found = normalized.match(POLL_RE);
  if (found === null || found.index === undefined) return null;
  // Todo lo que viene después de la palabra clave, sin el verbo inicial.
  let rest = normalized.slice(found.index + found[0].length).replace(/^[\s:,-]+/, "");
  rest = rest.replace(POLL_CONNECTOR_RE, "");
  rest = rest.replace(POLL_LEAD_VERB_RE, "").replace(POLL_CONNECTOR_RE, "");

  // 1. Opciones: "opciones: a, b", "entre a y b", "…: a o b" o la cola "a o b".
  let questionPart = rest;
  let rawOptions = "";
  let fromTail = false;
  const between = rest.match(POLL_BETWEEN_RE);
  const explicit = rest.match(POLL_OPTIONS_RE);
  const colon = rest.match(POLL_COLON_RE);
  if (explicit !== null) {
    rawOptions = explicit[1] ?? "";
    questionPart = rest.slice(0, explicit.index);
  } else if (between !== null) {
    rawOptions = between[1] ?? "";
    questionPart = rest.slice(0, between.index);
  } else if (colon !== null) {
    rawOptions = colon[1] ?? "";
    questionPart = rest.slice(0, colon.index);
  } else {
    const orTail = rest.match(POLL_OR_TAIL_RE);
    if (orTail !== null) {
      rawOptions = rest;
      questionPart = (orTail[1] ?? "").trim();
      fromTail = true;
    }
  }

  const texts = splitPollOptions(rawOptions);
  const wantsYesNo = POLL_YESNO_RE.test(normalized);
  const wantsDate = POLL_DATE_RE.test(normalized);

  // Sin opciones y sin aire de aprobación: no hay nada que proponer.
  if (texts.length < 2 && !wantsYesNo) return null;
  // Sin pregunta propia se usa el resto del pedido como pregunta. El texto se
  // recupera del original para que las tildes se pierdan lo menos posible.
  // "encuesta: pizza o sushi" no deja media opción como título.
  let questionRaw = questionPart.trim() === "" ? rest : questionPart;
  if (fromTail && texts.some((text) => text.toLowerCase() === questionPart.trim().toLowerCase())) {
    questionRaw = rest;
  }
  const question = sentenceCase(restoreAccents(original, questionRaw) || questionRaw);
  if (question === "") return null;

  if (wantsYesNo) {
    return { kind: "yesno", question, options: [] };
  }

  const asText = (raw: string): string => sentenceCase(restoreAccents(original, raw) || raw);

  // Fechas: solo si el pedido habla de día/fecha Y todas las opciones son un
  // día dicho. Si alguna no se puede resolver, es una encuesta de texto.
  if (wantsDate && texts.length >= 2) {
    const minutesOfDay = minutes ?? 19 * 60;
    const dated: PollIntentOption[] = [];
    for (const text of texts) {
      const day = pollDayOf(text, wall);
      if (day === null) {
        return {
          kind: "single",
          question,
          options: texts.map((t) => ({ text: asText(t), startsAt: null, endsAt: null })),
        };
      }
      const startsAt = santiagoToISO(day.year, day.month, day.day, minutesOfDay);
      dated.push({
        text: asText(text),
        startsAt,
        endsAt: new Date(new Date(startsAt).getTime() + 2 * 3_600_000).toISOString(),
      });
    }
    return { kind: "date", question, options: dated };
  }

  const kind: PollIntentKind = POLL_MULTI_RE.test(normalized) ? "multiple" : "single";
  return {
    kind,
    question,
    options: texts.map((text) => ({ text: asText(text), startsAt: null, endsAt: null })),
  };
}

// --- Comandos al PC (device_command) ----------------------------------------
//
// "@mi-pc abre Spotify" o "toma una captura de mi pc" se resuelven SIN modelo:
// la marca al PC da el destino y el verbo da la acción del catálogo cerrado
// (ver `src/lib/devices/catalog.ts`, espejo en `_shared/devices.ts`). Lo
// sensible (mandar archivos, scripts, terminal) viaja igual por tarjeta +
// aprobación en el teléfono; aquí solo se detecta, nunca se ejecuta.

const DEVICE_MARK_RE = /(^|[\s,.;:¡!¿?])(@mi-?pc|@mipc|mi-?pc)\b/;

type DeviceParse = {
  action: string;
  title: string;
  args: Record<string, string>;
  confident: boolean;
};

/** Quita la marca al PC del inicio o del final ("@mi-pc abre X", "X de mi pc"). */
function stripDeviceMark(normalized: string): string {
  let rest = normalized
    .replace(/^[\s,.;:¡!¿?]*(loki\s*,?\s*)?(@mi-?pc|@mipc|mi-?pc)\b[\s,.;:¡!¿?]*/, "")
    .replace(/[\s,.;:¡!¿?]+(de |a |en |al )?mi-?pc[\s,.;:¡!¿?]*$/, "")
    .replace(/^(por favor\s+)?(loki\s*,?\s*)?/, "")
    .trim();
  // "abre spotify en mi pc": la cola ya se quitó; "en mi pc abre X" al inicio
  // también (primer replace). Recorta restos intermedios comunes.
  rest = rest.replace(/\s+en mi-?pc(\s+|$)/, " ").trim();
  return rest;
}

function deviceTargetText(original: string, normalizedRest: string): string {
  return cleanTitle(restoreAccents(original, normalizedRest) || normalizedRest).slice(0, 200);
}

/**
 * Parsea una orden al PC sin modelo. Devuelve null si no hay marca al PC o no
 * se reconoce el verbo (el llamador sigue al modelo).
 */
function parseDevice(original: string, normalized: string): DeviceParse | null {
  if (!DEVICE_MARK_RE.test(normalized)) return null;
  const rest = stripDeviceMark(normalized);
  if (rest === "") return null;
  const none: Record<string, string> = {};

  // Estado: "cómo está mi pc", "batería de mi pc".
  if (/(como est|estado|bateria|encendido|\bcpu\b|memoria|uso de)/.test(rest)) {
    return { action: "pc_status", title: "Estado del PC", args: none, confident: true };
  }
  // Captura: "toma una captura de mi pc", "pantallazo".
  if (/(captura|pantallazo|screenshot|foto de la pantalla)/.test(rest)) {
    return { action: "screenshot", title: "Captura de pantalla", args: none, confident: true };
  }
  // Bloqueo: "bloquea mi pc".
  if (/^(bloquea|bloquear|bloquea la pantalla)\b/.test(rest)) {
    return { action: "lock_screen", title: "Bloquear pantalla", args: none, confident: true };
  }
  // Volumen: "pon el volumen al 50", "silencia mi pc".
  if (/volumen|silencia|mute/.test(rest)) {
    if (/(silencia|mute|volumen (cero|0)|sin volumen)/.test(rest)) {
      return { action: "volume_set", title: "Volumen: silenciar", args: { muted: "1" }, confident: true };
    }
    const level = rest.match(/(\d{1,3})\s*(por ciento|%|porciento)?/);
    if (level !== null) {
      const n = Math.max(0, Math.min(100, parseInt(level[1] ?? "0", 10)));
      return { action: "volume_set", title: `Volumen: ${n}`, args: { level: String(n) }, confident: true };
    }
    // "sube/baja el volumen" sin número: lo resuelve el modelo.
    return { action: "volume_set", title: "Volumen", args: none, confident: false };
  }
  // Multimedia: "pausa la música de mi pc", "siguiente canción".
  if (/(pausa|pausar|pon en pausa)/.test(rest)) {
    return { action: "media_control", title: "Multimedia: pausa", args: { op: "pause" }, confident: true };
  }
  if (/(reproduce|reproducir|reanuda|reanudar|dale play|pon (la |el )?(musica|video|play))/.test(rest)) {
    return { action: "media_control", title: "Multimedia: reproducir", args: { op: "play" }, confident: true };
  }
  if (/(siguiente|proxima).*(cancion|tema|video)|cancion siguiente/.test(rest)) {
    return { action: "media_control", title: "Multimedia: siguiente", args: { op: "next" }, confident: true };
  }
  if (/(anterior|previa).*(cancion|tema|video)|cancion anterior/.test(rest)) {
    return { action: "media_control", title: "Multimedia: anterior", args: { op: "prev" }, confident: true };
  }
  // Buscar archivos: "busca el archivo informe en mi pc".
  {
    const find = rest.match(/^(busca|buscar|encuentra|encontrar)\s+(el\s+|la\s+|los\s+|un\s+)?(archivo\s+|archivos\s+|fichero\s+)?(.+)$/);
    if (find !== null) {
      const query = deviceTargetText(original, (find[4] ?? "").trim());
      if (query === "") return null;
      return { action: "find_files", title: `Buscar: ${query}`, args: { text: query }, confident: true };
    }
  }
  // Mandar archivo al chat: "manda el informe a este chat".
  {
    const send = rest.match(/^(manda|mandar|envia|enviar|sube|subir)\s+(el\s+|la\s+|este\s+)?(archivo\s+)?(.+?)(\s+(a|al|a este|al) (chat|grupo|conversacion))?$/);
    if (send !== null && /(archivo|manda|envia|sube)/.test(rest)) {
      const target = deviceTargetText(original, (send[4] ?? "").trim());
      if (target === "") return null;
      return { action: "send_file", title: `Mandar: ${target}`, args: { text: target }, confident: true };
    }
  }
  // Scripts registrados: "ejecuta el script respaldo".
  {
    const script = rest.match(/^(ejecuta|ejecutar|corre|correr|lanza|lanzar)\s+(el\s+)?script\s+(.+)$/);
    if (script !== null) {
      const name = deviceTargetText(original, (script[3] ?? "").trim());
      if (name === "") return null;
      return { action: "run_script", title: `Script: ${name}`, args: { text: name }, confident: true };
    }
  }
  // Terminal libre: "ejecuta en mi pc: ls" (siempre sensible + confirmación).
  {
    const term = rest.match(/^(ejecuta|ejecutar|corre|correr|comando|en la terminal:?)\s*:?\s*(.+)$/);
    if (term !== null) {
      const command = deviceTargetText(original, (term[2] ?? "").trim());
      if (command === "") return null;
      return { action: "arbitrary_exec", title: `Terminal: ${command.slice(0, 80)}`, args: { text: command }, confident: true };
    }
  }
  // Abrir app o URL: "abre spotify", "abre https://…".
  {
    const open = rest.match(/^(abre|abrir|inicia|iniciar|lanza|lanzar)\s+(.+)$/);
    if (open !== null) {
      const target = deviceTargetText(original, (open[2] ?? "").trim());
      if (target === "") return null;
      const bare = normalizeIntent(target);
      if (/^(https?:\/\/|www\.|[a-z0-9-]+\.(com|cl|org|net|dev|io|app|gob|edu)(\/\S*)?$)/.test(bare)) {
        const url = bare.startsWith("http") ? target : `https://${target}`;
        return { action: "open_url", title: `Abrir: ${target}`, args: { text: url }, confident: true };
      }
      return { action: "open_app", title: `Abrir: ${target}`, args: { text: target }, confident: true };
    }
  }
  return null;
}

/**
 * Analiza un pedido en español. Si `confident` es true, el llamador puede
 * actuar sin modelo (crear con confirmación o responder con plantilla).
 */
export function analyzeIntent(text: string, options?: AnalyzeOptions): AnalyzedIntent | null {
  const nowMs = options?.now instanceof Date ? options.now.getTime() : Date.now();
  const normalized = normalizeIntent(text);
  const mentions = extractIntentMentions(text);
  const wall = santiagoWall(nowMs);

  // Comandos al PC: "@mi-pc abre Spotify" se resuelve sin modelo (el que pide
  // manda a su propio PC; lo sensible igual pide aprobación en el teléfono).
  const device = parseDevice(text, normalized);
  if (device !== null) {
    return {
      action: "device_command",
      title: device.title,
      dateISO: null,
      recurrence: null,
      mentions,
      listName: null,
      pollKind: null,
      pollOptions: [],
      deviceAction: device.action,
      deviceArgs: device.args,
      confident: device.confident,
    };
  }

  // Encuesta: tiene su propio camino (pregunta + opciones, a veces con
  // fecha) y no necesita el análisis de recordatorio/evento de más abajo.
  const poll = parsePoll(text, normalized, wall, extractTime(normalized)?.minutes ?? null);
  if (poll !== null) {
    return {
      action: "create_poll",
      title: poll.question,
      dateISO: null,
      recurrence: null,
      mentions,
      listName: null,
      pollKind: poll.kind,
      pollOptions: poll.options,
      deviceAction: null,
      deviceArgs: {},
      confident: poll.kind === "yesno" || poll.options.length >= 2,
    };
  }

  // Memoria: "recuerda que…" guarda un dato del espacio. Va antes del
  // recordatorio porque "recuerda que la clave es X" NO es un aviso con fecha.
  const memory = parseRemember(text, normalized);
  if (memory !== null) {
    return {
      action: "remember",
      title: memory,
      dateISO: null,
      recurrence: null,
      mentions,
      listName: null,
      pollKind: null,
      pollOptions: [],
      deviceAction: null,
      deviceArgs: {},
      confident: true,
    };
  }

  const isRemind = REMIND_RE.test(normalized);
  const listMatch = matchList(normalized);
  const isEvent = EVENT_RE.test(normalized);
  const isTask = !isRemind && !isEvent && TASK_RE.test(normalized);

  let action: IntentAction | null = null;
  if (isRemind) action = "remind";
  else if (listMatch !== null) action = "add_list";
  else if (isEvent) action = "create_event";
  else if (isTask) action = "create_task";
  else if (RECALL_RE.test(normalized)) action = "recall";
  if (action === null) return null;

  const time = extractTime(normalized);
  let dateISO: string | null = null;
  let recurrence: IntentRecurrence | null = null;
  let rest = normalized;

  // --- Recurrencias (antes que fechas puntuales) ---
  const dailyMatch = normalized.match(
    /(todos los dias|cada dia|cada día|diariamente)(\s+a las.*)?/,
  );
  const weeklyMatch = normalized.match(
    /cada\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)/,
  );
  const monthlyMatch = normalized.match(/el (\d{1,2}) de cada mes/);
  if (dailyMatch !== null) {
    const hhmm = time === null
      ? null
      : `${pad2(Math.floor(time.minutes / 60))}:${pad2(time.minutes % 60)}`;
    recurrence = { kind: "daily", value: 0, time: hhmm };
    rest = removeSpan(rest, dailyMatch[0] ?? "");
  } else if (weeklyMatch !== null) {
    const weekday = weekdayIndex(weeklyMatch[1] ?? "");
    if (weekday >= 0) {
      const hhmm = time === null
        ? null
        : `${pad2(Math.floor(time.minutes / 60))}:${pad2(time.minutes % 60)}`;
      recurrence = { kind: "weekly", value: weekday, time: hhmm };
      rest = removeSpan(rest, weeklyMatch[0] ?? "");
    }
  } else if (monthlyMatch !== null) {
    const dayNum = parseInt(monthlyMatch[1] ?? "0", 10);
    if (dayNum >= 1 && dayNum <= 28) {
      const hhmm = time === null
        ? null
        : `${pad2(Math.floor(time.minutes / 60))}:${pad2(time.minutes % 60)}`;
      recurrence = { kind: "monthly", value: dayNum, time: hhmm };
      rest = removeSpan(rest, monthlyMatch[0] ?? "");
    }
  }

  // --- Fechas puntuales ---
  if (recurrence === null) {
    let dayOffset: number | null = null;
    let span = "";
    const relMatch = normalized.match(/pasado manana|manana|hoy/);
    if (relMatch !== null) {
      dayOffset = relMatch[0] === "hoy" ? 0 : relMatch[0] === "manana" ? 1 : 2;
      span = relMatch[0] ?? "";
    } else {
      const weekMatch = normalized.match(
        /(este|el|este proximo|el proximo|proximo)\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)/,
      );
      if (weekMatch !== null) {
        const target = weekdayIndex(weekMatch[2] ?? "");
        if (target >= 0) {
          let delta = (target - wall.weekday + 7) % 7;
          const qualifier = weekMatch[1] ?? "";
          // "el viernes" siendo viernes = hoy; "próximo" siempre salta 7.
          if (delta === 0 && qualifier !== "este") delta = qualifier.includes("proximo") ? 7 : 0;
          if (qualifier.includes("proximo") && delta < 7) delta += 7;
          dayOffset = delta;
          span = weekMatch[0] ?? "";
        }
      } else {
        const inMatch = normalized.match(
          /en (\d+|una|un|un par de)\s+(minutos?|horas?)/,
        );
        if (inMatch !== null) {
          const qtyRaw = inMatch[1] ?? "1";
          const qty = qtyRaw === "una" || qtyRaw === "un" ? 1 : qtyRaw === "un par de" ? 2 : parseInt(qtyRaw, 10);
          if (Number.isFinite(qty) && qty > 0 && qty <= 72) {
            const isHours = (inMatch[2] ?? "").startsWith("hora");
            dateISO = new Date(nowMs + qty * (isHours ? 3_600_000 : 60_000)).toISOString();
            rest = removeSpan(rest, inMatch[0] ?? "");
          }
        }
      }
    }
    if (dayOffset !== null) {
      const base = new Date(Date.UTC(wall.year, wall.month, wall.day));
      base.setUTCDate(base.getUTCDate() + dayOffset);
      // Hora dicha o default: 9:00 para recordatorios/eventos.
      const minutes = time === null ? 9 * 60 : time.minutes;
      dateISO = santiagoToISO(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        minutes,
      );
      rest = removeSpan(rest, span);
    }
  }

  if (time !== null && dateISO === null && recurrence === null) {
    // Hora sin día ("recuérdame a las 9"): hoy si falta, si no mañana.
    const todayISO = santiagoToISO(wall.year, wall.month, wall.day, time.minutes);
    if (new Date(todayISO).getTime() > nowMs) {
      dateISO = todayISO;
    } else {
      const base = new Date(Date.UTC(wall.year, wall.month, wall.day));
      base.setUTCDate(base.getUTCDate() + 1);
      dateISO = santiagoToISO(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        time.minutes,
      );
    }
  }
  if (time !== null) rest = removeSpan(rest, time.span);

  // --- Título ---
  let title: string;
  let listName: string | null = null;
  if (action === "add_list" && listMatch !== null) {
    title = listMatch.item;
    listName = listMatch.list;
  } else if (action === "recall") {
    // Una pregunta de recall se busca tal cual: no se le quita el verbo ni la
    // interrogación (el texto completo es lo que entiende el buscador).
    title = text.trim().slice(0, 200);
  } else {
    title = rest;
    for (const verb of [
      /^(por favor\s+)?recuerdame\s+/,
      /^(por favor\s+)?recuerdale(\s+a\s+\S+)?\s+/,
      /^(por favor\s+)?avisame\s+/,
      // Se quita verbo + artículo pero NO el sustantivo ("reunión",
      // "tarea"): suele ser parte del título ("agenda reunión con Juan").
      /^(por favor\s+)?(crea|crear|agrega|anade|anota|suma|agenda|programa)\s+(un\s+|una\s+)?/,
    ]) {
      title = title.replace(verb, "");
    }
    title = title.replace(/^(que|de que|para)\s+/, "");
  }
  // Saca menciones del título.
  title = title.replace(/@[\p{L}\p{N}_.-]+/gu, "");
  title = cleanTitle(title);

  // --- Confianza ---
  let confident = title !== "";
  if (action === "remind" && dateISO === null && recurrence === null) {
    confident = false; // Sin cuándo, hay que preguntar.
  }

  return {
    action,
    title,
    dateISO,
    recurrence,
    mentions,
    listName,
    pollKind: null,
    pollOptions: [],
    deviceAction: null,
    deviceArgs: {},
    confident,
  };
}
