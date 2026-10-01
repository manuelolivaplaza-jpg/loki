"use client";

import * as React from "react";
import { Loader2, Mic, Pencil, X } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Transcripción(dictado) que acompaña al plan de Loki.
 *
 * El dictatedó entra al MISMO flujo que escribir a mano, pero el dictado suele
 * traer errores ("comprar pan, leche y detergente, y recuérdame llamar al
 * doctor mañana a las 10"). Por eso el texto se muestra SIEMPRE encima de la
 * tarjeta de plan, editable, y el botón "Recalcular con este texto" vuelve a
 * pedirle a Loki el plan con la corrección.
 */
export function DictationBanner({
  text,
  onTextChange,
  onRecalculate,
  recalculating,
  onDismiss,
  className,
}: {
  text: string;
  onTextChange: (value: string) => void;
  /** Vuelve a pedir el plan con el texto corregido. */
  onRecalculate: () => void;
  recalculating: boolean;
  /** Cierra el banner (el plan sigue siendo válido). */
  onDismiss: () => void;
  className?: string;
}): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(text);
  const changed = draft.trim() !== text.trim();

  // Mientras no se edita, el borrador sigue al texto real (p. ej. si el
  // plan se recalcula desde otro lado).
  React.useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  const commit = (): void => {
    const clean = draft.trim();
    setEditing(false);
    if (clean === "" || clean === text.trim()) {
      setDraft(text);
      return;
    }
    onTextChange(clean);
  };

  return (
    <section
      aria-label="Texto dictado"
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-dashed border-accent/50 bg-card p-3 shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Icon icon={Mic} size={20} className="shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-body-sm font-semibold text-foreground">
          Te di con la voz
        </p>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Corregir el texto dictado"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface-soft"
          >
            <Icon icon={Pencil} size={20} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Ocultar el texto dictado"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive active:bg-surface-soft"
        >
          <Icon icon={X} size={20} />
        </button>
      </div>

      {editing ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          rows={3}
          maxLength={4000}
          autoFocus
          aria-label="Texto dictado (editable)"
          className="min-h-20 w-full rounded-sm bg-surface-soft px-3 py-2 text-body-sm leading-5 text-foreground outline-none"
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-body-sm leading-5 text-foreground">
          {text}
        </p>
      )}

      <p className="text-meta leading-4 text-muted-foreground">
        Revisa el texto: si algo sonó mal, corrígelo antes de confirmar.
      </p>

      {editing ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              commit();
            }}
            disabled={!changed}
            className="min-h-11 flex-1 rounded-full bg-foreground text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
          >
            Guardar texto
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(text);
              setEditing(false);
            }}
            className="min-h-11 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive"
          >
            Cancelar
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onRecalculate}
          disabled={recalculating}
          className="flex min-h-11 items-center justify-center gap-1.5 self-start rounded-full border border-divider bg-surface-soft px-3.5 text-body-sm font-semibold text-foreground outline-none interactive disabled:opacity-60"
        >
          {recalculating ? (
            <Icon icon={Loader2} size={20} className="animate-spin" />
          ) : (
            <Icon icon={Pencil} size={20} />
          )}
          {recalculating ? "Recalculando…" : "Recalcular con este texto"}
        </button>
      )}
    </section>
  );
}
