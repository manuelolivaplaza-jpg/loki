"use client";

export const EMOJI_OPTIONS: ReadonlyArray<{ char: string; name: string }> = [
  { char: "🏠", name: "Casa" },
  { char: "👨‍👩‍👧", name: "Familia" },
  { char: "💼", name: "Trabajo" },
  { char: "🚀", name: "Cohete" },
  { char: "🌱", name: "Planta" },
  { char: "📚", name: "Libros" },
  { char: "🎯", name: "Objetivo" },
  { char: "⚽", name: "Fútbol" },
  { char: "🎨", name: "Arte" },
  { char: "🧪", name: "Ciencia" },
  { char: "🛠️", name: "Herramientas" },
  { char: "⭐", name: "Estrella" },
];

export function kindLabel(kind: string): string {
  return kind === "team" ? "Equipo" : "Familia";
}
