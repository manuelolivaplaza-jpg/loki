"use client";

import * as React from "react";
import {
  getSttHealth,
  requestTranscription,
  waitForTranscription,
  TRANSCRIPTION_NOT_CONFIGURED,
} from "@/lib/data/transcriptions";
import { splitMediaPath } from "@/lib/media/upload";
import type { MessageAttachment } from "@/types/chat";

export type VoiceResolve =
  | { state: "idle" }
  | { state: "trabajando" }
  | { state: "listo"; text: string }
  | { state: "error"; message: string };

export type VoiceResolveState = VoiceResolve & {
  /** Pide (o reintenta) la transcripción del audio. */
  resolve: () => void;
  /** Corta cualquier espera en vuelo. */
  cancel: () => void;
};

/** Primer audio del mensaje que se puede transcribir (con ruta de Storage). */
export function firstTranscribable(message: {
  attachments: readonly MessageAttachment[];
}): MessageAttachment | null {
  for (const item of message.attachments) {
    if (item.kind !== "audio") continue;
    if (splitMediaPath(item.path) !== null) return item;
  }
  return null;
}

/**
 * Resuelve la transcripción de la nota de voz de un mensaje para poder
 * convertirla ("Convertir en…" sobre una nota de voz).
 *
 * Nada se pide hasta que alguien lo pide explícitamente (`resolve()`): si ya
 * existe, se usa; si no, se encola UN trabajo y se espera por Realtime. Sin
 * proveedor devuelve el aviso "Transcripción sin configurar" y no encola nada.
 */
export function useVoiceTranscription(
  message: { id: string; attachments: readonly MessageAttachment[] } | null,
  chatId: string | null,
  authorId: string | null,
): VoiceResolveState {
  const [state, setState] = React.useState<VoiceResolve>({ state: "idle" });
  const tokenRef = React.useRef(0);

  const cancel = React.useCallback((): void => {
    tokenRef.current += 1;
    setState({ state: "idle" });
  }, []);

  // Cambiar de mensaje o de chat: se suelta lo que estuviera en vuelo.
  React.useEffect(() => {
    tokenRef.current += 1;
    setState({ state: "idle" });
  }, [message?.id, chatId]);

  const resolve = React.useCallback((): void => {
    if (message === null) return;
    const attachment = firstTranscribable(message);
    const target = attachment === null ? null : splitMediaPath(attachment.path);
    if (attachment === null || target === null) {
      setState({
        state: "error",
        message: "Esta nota de voz ya no se puede transcribir.",
      });
      return;
    }
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    setState({ state: "trabajando" });
    void (async () => {
      try {
        const stt = await getSttHealth();
        if (tokenRef.current !== token) return;
        if (!stt.configured) {
          setState({ state: "error", message: TRANSCRIPTION_NOT_CONFIGURED });
          return;
        }
        const created = await requestTranscription({
          workspaceId: target.workspaceId,
          bucket: target.bucket,
          objectPath: target.objectPath,
          messageId: message.id,
          chatId: chatId ?? "",
          authorId,
          ...(attachment.duration !== undefined ? { durationSeconds: attachment.duration } : {}),
        });
        if (tokenRef.current !== token) return;
        const done = await waitForTranscription(created.workspaceId, created.objectPath);
        if (tokenRef.current !== token) return;
        if (done.text.trim() === "") {
          setState({ state: "error", message: "La transcripción salió vacía." });
          return;
        }
        setState({ state: "listo", text: done.text });
      } catch (error: unknown) {
        if (tokenRef.current !== token) return;
        setState({
          state: "error",
          message: error instanceof Error ? error.message : "No se pudo transcribir.",
        });
      }
    })();
  }, [message, chatId, authorId]);

  return React.useMemo(
    (): VoiceResolveState => ({ ...state, resolve, cancel }),
    [state, resolve, cancel],
  );
}
