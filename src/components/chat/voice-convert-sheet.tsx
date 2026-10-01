"use client";

import * as React from "react";
import { Loader2, Mic, RefreshCw, X } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { ConvertSheet, type ConvertKind, type ConvertMember } from "@/components/chat/convert-sheet";
import { useVoiceTranscription } from "@/hooks/use-voice-transcription";
import type { MessageDoc } from "@/types/chat";

/**
 * "Convertir en…" sobre una NOTA DE VOZ: primero la transcripción, después el
 * formulario. Nunca se convierte el texto vacío ni se adivina.
 *
 * - Al abrir, la pide si no existe (bajo demanda: solo cuando alguien elige
 *   convertir, no al leer el chat).
 * - "Transcribiendo…" con su estado; si falla, el motivo en español y
 *   Reintentar.
 * - Cuando llega, se abre el ConvertSheet con la transcripción como texto.
 */
export function VoiceConvertSheet({
  message,
  wsId,
  chatId,
  uid,
  authorName,
  kind,
  members,
  onClose,
}: {
  message: MessageDoc;
  wsId: string;
  chatId: string;
  uid: string;
  authorName: string;
  kind: ConvertKind;
  members: ConvertMember[];
  onClose: () => void;
}): React.JSX.Element {
  const voice = useVoiceTranscription(message, chatId, message.authorId);
  const startedRef = React.useRef(false);

  // En cuanto abre, pide la transcripción (una sola vez por mensaje).
  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    voice.resolve();
  }, [voice]);

  if (voice.state === "listo") {
    return (
      <ConvertSheet
        message={message}
        wsId={wsId}
        chatId={chatId}
        uid={uid}
        authorName={authorName}
        kind={kind}
        members={members}
        sourceText={voice.text}
        sourceLabel="nota de voz"
        onClose={onClose}
      />
    );
  }

  return (
    <div
      role="group"
      aria-label="Convertir nota de voz"
      className="mx-auto flex w-full max-w-[760px] flex-col gap-2 px-4"
    >
      <div className="flex items-center gap-2 rounded-2xl border border-divider bg-card p-3">
        {voice.state === "trabajando" ? (
          <Icon icon={Loader2} size={20} className="shrink-0 animate-spin text-primary" />
        ) : (
          <Icon icon={Mic} size={20} className="shrink-0 text-primary" />
        )}
        <p className="min-w-0 flex-1 text-body-sm font-semibold text-foreground">
          {voice.state === "trabajando" ? "Transcribiendo la nota de voz…" : "No se pudo transcribir"}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface-soft"
        >
          <Icon icon={X} size={20} />
        </button>
      </div>
      {voice.state === "trabajando" ? (
        <p className="text-meta leading-4 text-muted-foreground">
          La transcripción se pide solo ahora, y se guarda para que no vuelvas a pagarla.
        </p>
      ) : (
        <>
          <p role="alert" className="text-body-sm leading-5 text-danger">
            {voice.state === "error" ? voice.message : "No se pudo transcribir."}
          </p>
          <button
            type="button"
            onClick={() => voice.resolve()}
            className="flex min-h-11 items-center gap-1.5 self-start rounded-full border border-divider bg-surface-soft px-3.5 text-body-sm font-semibold text-foreground outline-none interactive"
          >
            <Icon icon={RefreshCw} size={20} />
            Reintentar
          </button>
        </>
      )}
    </div>
  );
}
