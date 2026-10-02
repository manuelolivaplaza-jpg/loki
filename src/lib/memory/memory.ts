/**
 * Memoria del espacio: categorías, validación y utilidades puras (sin React,
 * sin imports). Compartido por la capa de datos, la pantalla Memoria, el menú
 * del mensaje y la tarjeta de confirmación de Loki IA.
 *
 * Sintaxis "erasable" como `intent.ts`: sin imports (ni de tipos) para que
 * `tests/intent.test.mjs` lo pueda cargar con Node >= 22. Los tipos se repiten
 * aquí y son estructuralmente los mismos de `src/types/organizer.ts`.
 *
 * La Edge `loki-chat` NO importa este archivo (el bundle no sale de
 * `supabase/functions`): su copia idéntica vive en
 * `supabase/functions/_shared/memory.ts` y el test `memory-sync` de
 * `tests/intent.test.mjs` verifica que las dos copias coincidan.
 */

/** Categoría del recuerdo (las cinco de la tabla). */
export type MemoryCategoryValue = "salud" | "casa" | "contactos" | "trabajo" | "otros";

/** 'espacio' lo ven los miembros; 'privado' solo quien lo guardó. */
export type MemoryVisibilityValue = "espacio" | "privado";

/** Categorías con su etiqueta en español (las cinco de la tabla). */
export const MEMORY_CATEGORIES: readonly {
  value: MemoryCategoryValue;
  label: string;
  emoji: string;
}[] = [
  { value: "salud", label: "Salud", emoji: "🩺" },
  { value: "casa", label: "Casa", emoji: "🏠" },
  { value: "contactos", label: "Contactos", emoji: "📇" },
  { value: "trabajo", label: "Trabajo", emoji: "💼" },
  { value: "otros", label: "Otros", emoji: "💡" },
];

const CATEGORY_VALUES: readonly string[] = MEMORY_CATEGORIES.map((entry) => entry.value);

/** Etiqueta de una categoría (o "Otros" si llega algo raro del servidor). */
export function memoryCategoryLabel(category: string): string {
  const found = MEMORY_CATEGORIES.find((entry) => entry.value === category);
  return found?.label ?? "Otros";
}

/** Emoji de una categoría (mismo criterio que `memoryCategoryLabel`). */
export function memoryCategoryEmoji(category: string): string {
  const found = MEMORY_CATEGORIES.find((entry) => entry.value === category);
  return found?.emoji ?? "💡";
}

/** Normaliza a una categoría válida de la tabla. */
export function normalizeMemoryCategory(value: string): MemoryCategoryValue {
  return CATEGORY_VALUES.includes(value) ? (value as MemoryCategoryValue) : "otros";
}

/** Normaliza la visibilidad ('espacio' por defecto). */
export function normalizeMemoryVisibility(value: string): MemoryVisibilityValue {
  return value === "privado" ? "privado" : "espacio";
}

export const MEMORY_MAX_CONTENT = 1000;
export const MEMORY_MIN_CONTENT = 1;

/**
 * Recorta y limpia el texto de un recuerdo. Sin texto útil devuelve `null`
 * (el mensaje en español lo pone quien llama).
 */
export function cleanMemoryContent(raw: string): string | null {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length < MEMORY_MIN_CONTENT) return null;
  return clean.slice(0, MEMORY_MAX_CONTENT);
}

// --- Caducidad ----------------------------------------------------------------

/** Fecha en el formato de `<input type="date">` (hora local). */
export function toDateInput(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Convierte el valor de `<input type="date">` a instante (mediodía local, para
 * que el día no cambie por zona horaria). Vacío o inválido → `null`.
 */
export function fromDateInput(value: string): Date | null {
  const clean = value.trim();
  if (clean === "") return null;
  const parsed = new Date(`${clean}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `true` si el recuerdo ya venció (o vence hoy). */
export function isMemoryExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  if (expiresAt === null) return false;
  return expiresAt.getTime() <= now.getTime();
}

/** "Vence el 14 de marzo" o "Vencido el 2 de enero" (o "" si no caduca). */
export function memoryExpiryLabel(
  expiresAt: Date | null,
  now: Date = new Date(),
): string {
  if (expiresAt === null) return "";
  const day = expiresAt.toLocaleDateString("es", { day: "numeric", month: "short" });
  return isMemoryExpired(expiresAt, now) ? `Vencido el ${day}` : `Vence el ${day}`;
}

// --- Texto visible ------------------------------------------------------------

/**
 * Texto de un recuerdo sensible mientras está oculto: nunca el contenido, solo
 * la categoría. Es lo que se pinta (y lo que se lee en voz alta) antes de que
 * alguien pulse "Mostrar".
 */
export function maskedMemoryText(category: string): string {
  return `Recuerdo sensible · ${memoryCategoryLabel(category).toLowerCase()}`;
}

/**
 * Cuántos días faltan para caducar (`null` si no caduca). Negativo = vencido.
 */
export function memoryDaysToExpiry(
  expiresAt: Date | null,
  now: Date = new Date(),
): number | null {
  if (expiresAt === null) return null;
  const day = 86_400_000;
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOfDay(expiresAt) - startOfDay(now)) / day);
}

/**
 * Palabras que sugieren que un recuerdo es sensible (clave, salud, cuentas).
 * Es una AYUDA para premarcar la casilla, no una decisión: quien guarda
 * siempre confirma en la tarjeta o en el formulario, y puede destildarla.
 */
const SENSITIVE_HINTS: readonly RegExp[] = [
  /(clave|contrase|password|passcode|\bpin\b|c[oó]digo (de|del|para)|wifi|wi-?fi|token|api ?key|secret|llave)/i,
  /(al[eé]rg|al[eé]rgic|medicament|medicament|diagn[oó]stic|tratamiento|pediatra|m[eé]dico|doctor|dentista|psic[oó]log|terapia|salud)/i,
  /(cuenta (bancaria|de banco)|tarjeta|rut\b|c[oó]digo de seguridad|domicilio particular|direcci[oó]n particular)/i,
];

/**
 * `true` si el texto "huele" a sensible: premarca la casilla en el formulario
 * y en la tarjeta de Loki, sin decidir por el usuario.
 */
export function looksSensitiveMemory(raw: string): boolean {
  return SENSITIVE_HINTS.some((pattern) => pattern.test(raw));
}

/**
 * Categoría que suena el texto (determinista, sin IA). Solo propone: la
 * tarjeta y el formulario la muestran elegida y el usuario la puede cambiar.
 */
export function guessMemoryCategory(raw: string): MemoryCategoryValue {
  const text = raw.toLowerCase();
  if (/(al[eé]rg|medicament|m[eé]dico|doctor|pediatra|dentista|salud|cl[ií]nica|diagn[oó]stic)/.test(text)) {
    return "salud";
  }
  if (/(wifi|wi-?fi|internet|luz|agua|gas|port[oó]n|puerta|llave|c[oó]digo|contrase|alarma|casa|dep[oó]sito|persiana|calefacci[oó]n)/.test(text)) {
    return "casa";
  }
  if (/(tel[eé]fono|celular|m[oó]vil|whatsapp|correo|email|domicilio|direcci[oó]n|doctor|pediatra|dentista|contacto)/.test(text)) {
    return "contactos";
  }
  if (/(cliente|reuni[oó]n|jefe|empresa|proyecto|contrato|factura|oficina|equipo|sprint|repositorio)/.test(text)) {
    return "trabajo";
  }
  return "otros";
}