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
  | "add_list";

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

/**
 * Analiza un pedido en español. Si `confident` es true, el llamador puede
 * actuar sin modelo (crear con confirmación o responder con plantilla).
 */
export function analyzeIntent(text: string, options?: AnalyzeOptions): AnalyzedIntent | null {
  const nowMs = options?.now instanceof Date ? options.now.getTime() : Date.now();
  const normalized = normalizeIntent(text);
  const mentions = extractIntentMentions(text);
  const wall = santiagoWall(nowMs);

  const isRemind = REMIND_RE.test(normalized);
  const listMatch = matchList(normalized);
  const isEvent = EVENT_RE.test(normalized);
  const isTask = !isRemind && !isEvent && TASK_RE.test(normalized);

  let action: IntentAction | null = null;
  if (isRemind) action = "remind";
  else if (listMatch !== null) action = "add_list";
  else if (isEvent) action = "create_event";
  else if (isTask) action = "create_task";
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

  return { action, title, dateISO, recurrence, mentions, listName, confident };
}
