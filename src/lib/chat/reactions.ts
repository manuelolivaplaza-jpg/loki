/**
 * Reacciones T16: codepoints explícitos (sin copiar/pegar emojis).
 * Barra rápida de 6 + picker básico de 24.
 */

export type QuickReaction = {
  /** Emoji renderizado. */
  emoji: string;
  /** Nombre accesible. */
  name: string;
  /** Codepoints unicode (documentación + verificación). */
  codepoints: string;
};

function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

/** 6 emojis rápidos de la barra flotante. */
export const QUICK_REACTIONS: readonly QuickReaction[] = [
  { emoji: cp(0x1f44d), name: "Me gusta", codepoints: "U+1F44D" },
  { emoji: cp(0x2764, 0xfe0f), name: "Corazón", codepoints: "U+2764 U+FE0F" },
  { emoji: cp(0x1f602), name: "Risa", codepoints: "U+1F602" },
  { emoji: cp(0x1f62e), name: "Sorpresa", codepoints: "U+1F62E" },
  { emoji: cp(0x1f622), name: "Tristeza", codepoints: "U+1F622" },
  { emoji: cp(0x1f525), name: "Fuego", codepoints: "U+1F525" },
];

/** Picker básico: 24 emojis en grid (incluye los 6 rápidos). */
export const EXTENDED_REACTIONS: readonly QuickReaction[] = [
  { emoji: cp(0x1f44d), name: "Me gusta", codepoints: "U+1F44D" },
  { emoji: cp(0x2764, 0xfe0f), name: "Corazón", codepoints: "U+2764 U+FE0F" },
  { emoji: cp(0x1f602), name: "Risa", codepoints: "U+1F602" },
  { emoji: cp(0x1f62e), name: "Sorpresa", codepoints: "U+1F62E" },
  { emoji: cp(0x1f622), name: "Tristeza", codepoints: "U+1F622" },
  { emoji: cp(0x1f525), name: "Fuego", codepoints: "U+1F525" },
  { emoji: cp(0x1f389), name: "Fiesta", codepoints: "U+1F389" },
  { emoji: cp(0x1f44f), name: "Aplausos", codepoints: "U+1F44F" },
  { emoji: cp(0x1f64f), name: "Gracias", codepoints: "U+1F64F" },
  { emoji: cp(0x1f60d), name: "Enamorado", codepoints: "U+1F60D" },
  { emoji: cp(0x1f914), name: "Pensando", codepoints: "U+1F914" },
  { emoji: cp(0x1f44e), name: "No me gusta", codepoints: "U+1F44E" },
  { emoji: cp(0x1f4af), name: "Cien", codepoints: "U+1F4AF" },
  { emoji: cp(0x1f64c), name: "Celebración", codepoints: "U+1F64C" },
  { emoji: cp(0x1f605), name: "Alivio", codepoints: "U+1F605" },
  { emoji: cp(0x1f973), name: "Celebrando", codepoints: "U+1F973" },
  { emoji: cp(0x1f60e), name: "Genial", codepoints: "U+1F60E" },
  { emoji: cp(0x1f440), name: "Mirando", codepoints: "U+1F440" },
  { emoji: cp(0x2705), name: "Listo", codepoints: "U+2705" },
  { emoji: cp(0x274c), name: "No", codepoints: "U+274C" },
  { emoji: cp(0x1f680), name: "Cohete", codepoints: "U+1F680" },
  { emoji: cp(0x2b50), name: "Estrella", codepoints: "U+2B50" },
  { emoji: cp(0x1f494), name: "Corazón roto", codepoints: "U+1F494" },
  { emoji: cp(0x1f91d), name: "Trato", codepoints: "U+1F91D" },
];
