"use client";

import * as React from "react";
import { AI_STREAM_INTERVAL_MS, streamChunks } from "@/lib/chat/ai-mock";

/**
 * Ids de mensajes de Loki cuyo texto ya se reveló entero.
 *
 * Vive en el módulo (no en un estado) para que al salir de `/chat/loki-ia`
 * y volver, o al remontar la burbuja, el texto aparezca completo en vez de
 * repetirse el efecto palabra a palabra.
 */
const revealed = new Set<string>();

/**
 * T18: streaming de la respuesta de Loki, palabra a palabra.
 *
 * - El documento de Firestore siempre trae el texto COMPLETO (es lo que se
 *   copia, edita o borra); este hook solo decide cuánta parte se ve.
 * - Una parte nueva cada `AI_STREAM_INTERVAL_MS` (30 ms) con los espacios
 *   incluidos, así que al terminar `shown === text` exactamente.
 * - Estado local del componente: durante el streaming solo se re-renderiza
 *   la respuesta de la IA, no la lista entera.
 */
export function useAiReveal(id: string, text: string): string {
  const [shown, setShown] = React.useState(() => (revealed.has(id) ? text : ""));

  React.useEffect(() => {
    if (text === "") {
      setShown("");
      return;
    }
    if (revealed.has(id)) {
      setShown(text);
      return;
    }
    const chunks = streamChunks(text);
    setShown(chunks[0] ?? "");
    let index = 1;
    const timer = setInterval(() => {
      if (index >= chunks.length) {
        clearInterval(timer);
        revealed.add(id);
        setShown(text);
        return;
      }
      setShown(chunks.slice(0, index + 1).join(""));
      index += 1;
    }, AI_STREAM_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [id, text]);

  return shown;
}
