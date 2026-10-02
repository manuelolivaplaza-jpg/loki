/**
 * Menciones T15: utilidades puras sin dependencias (ni firebase ni React).
 *
 * Este archivo usa solo sintaxis "erasable" (sin enums ni namespaces) para
 * que `tests/mentions.test.mjs` pueda importarlo directo con Node >= 22
 * (type stripping) sin compilar ni instalar nada.
 */

export interface MentionCandidate {
  /** uid del miembro, "loki" para la IA o `agent:<connectionId>` para bots. */
  id: string;
  displayName: string;
  /** kind ausente = miembro (compatibilidad histórica). */
  kind?: "member" | "loki" | "agent";
  /** Handle sin @ (solo agentes): el token que se menciona. */
  handle?: string;
  /** Dueño visible del bot ("mi-bot · de Manu"). */
  ownerName?: string;
  /** Emoji del bot (solo agentes). */
  avatarEmoji?: string;
}

export interface MentionSegment {
  text: string;
  isMention: boolean;
}

export interface MentionQuery {
  /** Índice del "@" que abrió la mención dentro del texto. */
  start: number;
  /** Texto tras el "@" hasta el caret (puede ser ""). */
  query: string;
}

/** Id estable de la entrada fija de IA en el menú y en `mentions[]`. */
export const LOKI_MENTION_ID = "loki";

export const LOKI_DISPLAY_NAME = "Loki";

/** Aliases que resuelven a Loki: "@Loki" y "@ai". */
export const LOKI_ALIASES: readonly string[] = ["loki", "ai"];

/**
 * Marca en `mentions[]` del aviso de IA desactivada. No es el id "loki":
 * así el aviso (type "system") no se confunde con una mención real a Loki.
 */
export const LOKI_DISABLED_MENTION = "loki-disabled";

/**
 * Texto EXACTO del aviso cuando Loki IA no está configurada (type "system").
 * Se muestra como mensaje de sistema SUTIL y CENTRADO en el timeline
 * (sin burbuja, texto pequeño gris), no como toast ni banner.
 */
export const LOKI_DISABLED_TEXT =
  "Loki IA sin configurar. Pide al administrador que configure el proveedor.";

/** Color de resaltado de menciones (#1D9BF0, token `mention`). */
export const MENTION_COLOR = "#1D9BF0";

/** Entrada fija del menú de menciones. */
export const LOKI_CANDIDATE: MentionCandidate = {
  id: LOKI_MENTION_ID,
  displayName: LOKI_DISPLAY_NAME,
  kind: "loki",
};

/** Prefijo de los ids de agentes (`agent:<connectionId>`). */
export const AGENT_MENTION_PREFIX = "agent:";

/** True si el id es la mención a un agente (`agent:<uuid>`). */
export function isAgentMentionId(id: string): boolean {
  return id.startsWith(AGENT_MENTION_PREFIX) && id.length > AGENT_MENTION_PREFIX.length;
}

/** connectionId de un id `agent:<id>` (null si no es de agente). */
export function agentConnectionIdOf(id: string): string | null {
  if (!isAgentMentionId(id)) return null;
  const connectionId = id.slice(AGENT_MENTION_PREFIX.length).trim();
  return connectionId === "" ? null : connectionId;
}

/**
 * Candidato de un agente habilitado en el espacio. displayName es el handle
 * (sin @) para que el token `@handle` resuelva exacto; el menú muestra el
 * distintivo de bot y su dueño ("mi-bot · de Manu").
 */
export function buildAgentCandidate(input: {
  connectionId: string;
  handle: string;
  ownerName?: string;
  avatarEmoji?: string;
}): MentionCandidate {
  const handle = input.handle.trim().replace(/^@+/, "");
  return {
    id: `${AGENT_MENTION_PREFIX}${input.connectionId}`,
    displayName: handle === "" ? "bot" : handle,
    kind: "agent",
    handle: handle === "" ? "bot" : handle,
    ownerName: input.ownerName?.trim() ?? "",
    avatarEmoji: input.avatarEmoji ?? "🤖",
  };
}

/** Minúsculas sin tildes para comparar nombres/queries. */
export function normalizeMention(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Fuente del token "@Nombre" (unicode: admite tildes y eñe). */
const TOKEN_SOURCE = "@[\\p{L}\\p{N}_.-]+";

/** Caracteres válidos dentro del query tras "@". */
const QUERY_CHAR_RE = /[\p{L}\p{N}_.-]/u;

/**
 * Detecta si hay una mención abierta justo antes del caret.
 * Devuelve null si no hay "@" (o si forma parte de un email: el "@" debe
 * estar al inicio o precedido por espacio/salto/tab/"(").
 */
export function getMentionQuery(
  value: string,
  caret: number,
): MentionQuery | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, safeCaret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0) {
    const prev = before.charAt(at - 1);
    if (prev !== " " && prev !== "\n" && prev !== "\t" && prev !== "(") {
      return null;
    }
  }
  const query = before.slice(at + 1);
  if (query === "") return { start: at, query: "" };
  for (const ch of query) {
    if (!QUERY_CHAR_RE.test(ch)) return null;
  }
  return { start: at, query };
}

function candidateKeys(candidate: MentionCandidate): string[] {
  if (candidate.id === LOKI_MENTION_ID || candidate.kind === "loki") {
    return [...LOKI_ALIASES];
  }
  if (candidate.kind === "agent") {
    const handle = (candidate.handle ?? candidate.displayName).trim();
    const keys = [candidate.displayName, handle];
    return [...new Set(keys.filter((key) => key !== ""))];
  }
  const compact = candidate.displayName.replace(/\s+/g, "");
  const keys = [candidate.displayName, compact];
  if (compact !== candidate.displayName) {
    // El token "@Nombre Apellido" (con espacio) nunca sobrevive al regex
    // de tokens, pero se conserva como clave por compatibilidad histórica.
  }
  return keys;
}

/** Primer nombre normalizado (para match "@Lucia" si es único). */
function firstNameKey(candidate: MentionCandidate): string {
  if (candidate.id === LOKI_MENTION_ID || candidate.kind === "loki") return "";
  // Los agentes solo resuelven por handle exacto (nunca por primer nombre):
  // dos bots "mi-bot" y "mi-bot-2" no deben ambiguarse.
  if (candidate.kind === "agent") return "";
  const first = candidate.displayName.split(/\s+/).filter(Boolean)[0] ?? "";
  return normalizeMention(first);
}

/**
 * Token "@Nombre" a insertar al elegir del menú: el displayName sin
 * espacios (ej. "Lucia Ruiz" -> "@LuciaRuiz"), porque el token regex solo
 * acepta `\p{L}\p{N}_.-` (sin espacios). El menú sigue mostrando el
 * displayName con espacios; solo el token insertado va compacto.
 */
export function buildMentionToken(candidate: MentionCandidate): string {
  if (candidate.id === LOKI_MENTION_ID || candidate.kind === "loki") {
    return `@${LOKI_DISPLAY_NAME}`;
  }
  if (candidate.kind === "agent") {
    const handle = (candidate.handle ?? candidate.displayName).trim().replace(/\s+/g, "");
    return `@${handle === "" ? "bot" : handle}`;
  }
  const compact = candidate.displayName.replace(/\s+/g, "");
  return `@${compact}`;
}

export interface InsertMentionResult {
  text: string;
  caret: number;
}

/**
 * Inserción pura del token en el texto (misma lógica que el Composer):
 * reemplaza `[start, caret)` por `token + " "`.
 */
export function insertMention(
  value: string,
  start: number,
  caret: number,
  candidate: MentionCandidate,
): InsertMentionResult {
  const safeStart = Math.max(0, Math.min(start, value.length));
  const safeCaret = Math.max(safeStart, Math.min(caret, value.length));
  const token = buildMentionToken(candidate);
  const text = `${value.slice(0, safeStart)}${token} ${value.slice(safeCaret)}`;
  return { text, caret: safeStart + token.length + 1 };
}

/**
 * Filtra candidatos por el texto tras "@" (subcadena, sin tildes,
 * insensible a mayúsculas). Query vacía = todos.
 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = normalizeMention(query.trim());
  if (q === "") return [...candidates];
  return candidates.filter((candidate) =>
    candidateKeys(candidate).some((key) =>
      normalizeMention(key).includes(q),
    ),
  );
}

/**
 * Resuelve qué uids siguen mencionados en el texto final (tokens
 * "@Nombre" visibles). "@Loki"/"@ai" resuelven al id "loki".
 */
export function resolveMentionIds(
  text: string,
  candidates: readonly MentionCandidate[],
): string[] {
  const tokens = new Set<string>();
  const matches = text.match(new RegExp(TOKEN_SOURCE, "gu")) ?? [];
  for (const token of matches) {
    tokens.add(normalizeMention(token.slice(1)));
  }
  // Primer nombre -> candidatos que lo usan (solo no-Loki con nombre único).
  const firstNameCount = new Map<string, number>();
  const candidateFirst = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.id === LOKI_MENTION_ID) continue;
    const key = firstNameKey(candidate);
    if (key === "") continue;
    candidateFirst.set(candidate.id, key);
    firstNameCount.set(key, (firstNameCount.get(key) ?? 0) + 1);
  }
  const ids: string[] = [];
  for (const candidate of candidates) {
    const exact = candidateKeys(candidate).some((key) =>
      tokens.has(normalizeMention(key)),
    );
    if (exact) {
      if (!ids.includes(candidate.id)) ids.push(candidate.id);
      continue;
    }
    // "@PrimerNombre" resuelve solo si es único entre candidatos.
    const first = candidateFirst.get(candidate.id);
    if (
      first !== undefined &&
      firstNameCount.get(first) === 1 &&
      tokens.has(first)
    ) {
      if (!ids.includes(candidate.id)) ids.push(candidate.id);
    }
  }
  return ids;
}

/**
 * Agentes invocados en el texto final (subconjunto de `resolveMentionIds`).
 * Una mención dispara UNA ejecución por agente (dedupe por connectionId);
 * el despacho además usa idempotency_key por mensaje para no duplicar.
 */
export function findInvokedAgents(
  text: string,
  candidates: readonly MentionCandidate[],
): MentionCandidate[] {
  const ids = new Set(resolveMentionIds(text, candidates));
  const out: MentionCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== "agent") continue;
    if (!ids.has(candidate.id)) continue;
    if (out.some((item) => item.id === candidate.id)) continue;
    out.push(candidate);
  }
  return out;
}

/**
 * Instrucción para el agente: el texto sin la primera mención a ese bot
 * (p. ej. "@mi-bot revisa el presupuesto" → "revisa el presupuesto").
 * Si queda vacía, quien llama pide aclaración en vez de invocar en vacío.
 */
export function stripAgentMention(
  text: string,
  candidate: MentionCandidate,
): string {
  const token = buildMentionToken(candidate);
  const index = text.indexOf(token);
  if (index === -1) {
    // Fallback insensible a mayúsculas (el token se insertó tal cual, pero
    // el usuario pudo reescribirlo a mano).
    const lower = normalizeMention(text);
    const needle = normalizeMention(token);
    const at = lower.indexOf(needle);
    if (at === -1) return text.trim();
    return `${text.slice(0, at)}${text.slice(at + token.length)}`.replace(/\s+/g, " ").trim();
  }
  return `${text.slice(0, index)}${text.slice(index + token.length)}`.replace(/\s+/g, " ").trim();
}

/**
 * Parte el texto en segmentos planos vs mención para resaltado.
 * Es mención si el token es @loki/@ai, si `mentions[]` trae marcas
 * (lookup por mentions[]) o si coincide con un nombre conocido
 * (match @Nombre). Sin candidatos ni marcas, todo "@Nombre" resalta;
 * el texto sin "@" queda en un único segmento plano idéntico.
 */
export function parseMentionSegments(
  text: string,
  knownNames?: readonly string[],
  mentions?: readonly string[],
): MentionSegment[] {
  if (text === "") return [];
  const known = new Set<string>();
  for (const name of knownNames ?? []) {
    known.add(normalizeMention(name));
    known.add(normalizeMention(name.replace(/\s+/g, "")));
  }
  // La marca del aviso "Loki IA sin configurar" (LOKI_DISABLED_MENTION) no es
  // una mención real: si se usara para resaltar, bastaría con ella para que
  // CUALQUIER "@palabra" del mensaje saliera en azul. El aviso no lleva "@"
  // en su texto, así que se ve igual de muted, pero el caso queda cerrado.
  const hasMentions = (mentions ?? []).some(
    (item) => item !== LOKI_DISABLED_MENTION,
  );
  const segments: MentionSegment[] = [];
  const re = new RegExp(TOKEN_SOURCE, "gu");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const token = match[0];
    const index = match.index;
    if (index > last) {
      segments.push({ text: text.slice(last, index), isMention: false });
    }
    const name = normalizeMention(token.slice(1));
    const isLoki = name === "loki" || name === "ai";
    const isMention =
      isLoki || hasMentions || known.size === 0 || known.has(name);
    segments.push({ text: token, isMention });
    last = index + token.length;
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last), isMention: false });
  }
  return segments;
}

/**
 * True si el mensaje menciona a la IA: token @loki/@ai, palabra
 * "loki"/"ai" en el texto, o id "loki" en `mentions[]`.
 */
export function mentionsLoki(
  text: string,
  mentions?: readonly string[],
): boolean {
  if ((mentions ?? []).some((item) => item === LOKI_MENTION_ID)) return true;
  const tokens = text.match(new RegExp(TOKEN_SOURCE, "gu")) ?? [];
  for (const token of tokens) {
    const name = normalizeMention(token.slice(1));
    if (name === "loki" || name === "ai") return true;
  }
  const words = normalizeMention(text).split(/[^a-z0-9]+/);
  return words.some((word) => word === "loki" || word === "ai");
}

/**
 * Payload del aviso de Loki sin configurar, compatible con la RLS: type
 * "system" + authorId del propio usuario (la RLS prohíbe type "ai" desde el
 * cliente en los chats de espacio y exige author_id propio). La respuesta
 * real la escribe la Edge Function `loki-chat` con la service role.
 */
export function buildLokiDisabledMessage(
  authorId: string,
  authorName: string,
): {
  authorId: string;
  authorName: string;
  text: string;
  mentions: string[];
  type: "system";
} {
  return {
    authorId,
    authorName,
    text: LOKI_DISABLED_TEXT,
    mentions: [LOKI_DISABLED_MENTION],
    type: "system",
  };
}
