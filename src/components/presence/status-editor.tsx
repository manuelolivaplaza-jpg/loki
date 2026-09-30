"use client";

/**
 * Editor de estado personalizado (emoji + texto, tope 120).
 *
 * Guarda en `user_presence` vía `usePresence.setMyStatus`: actualiza el
 * canal en vivo y el latido a la vez, así el próximo heartbeat no pisa
 * lo recién guardado.
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { usePresence } from "@/hooks/use-presence";
import { cn } from "@/lib/utils";

const MAX_STATUS_TEXT = 120;

export function StatusEditor({
  wsId,
  uid,
}: {
  wsId: string | null;
  uid: string | null;
}): React.JSX.Element | null {
  const { myStatus, setMyStatus } = usePresence(wsId, uid);
  const [emoji, setEmoji] = React.useState("");
  const [text, setText] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Valores iniciales una sola vez (después el formulario es del usuario).
  React.useEffect(() => {
    if (loaded) return;
    if (myStatus.emoji !== "" || myStatus.text !== "") {
      setEmoji(myStatus.emoji);
      setText(myStatus.text);
      setLoaded(true);
    }
  }, [loaded, myStatus]);

  if (wsId === null || uid === null) return null;

  const dirty = emoji.trim() !== myStatus.emoji || text.trim() !== myStatus.text;

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setMyStatus(emoji, text);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el estado.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear(): Promise<void> {
    setEmoji("");
    setText("");
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setMyStatus("", "");
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo quitar el estado.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Mi estado">
      <SectionLabel>Mi estado</SectionLabel>
      <Card className="px-4 py-4">
        <p className="text-body-sm text-muted-foreground">
          Cuéntales al resto en qué andas. Se ve junto a tu nombre.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            aria-label="Emoji de estado"
            placeholder="😀"
            value={emoji}
            onChange={(formEvent) => {
              setEmoji(formEvent.target.value.slice(0, 8));
              setSaved(false);
            }}
            className="h-11 w-14 shrink-0 rounded-lg bg-background text-center text-title text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-accent"
          />
          <input
            type="text"
            aria-label="Texto de estado"
            placeholder="En qué andas…"
            value={text}
            maxLength={MAX_STATUS_TEXT}
            onChange={(formEvent) => {
              setText(formEvent.target.value);
              setSaved(false);
            }}
            className="h-11 min-w-0 flex-1 rounded-lg bg-background px-3 text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-accent"
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
            className={cn("h-10 px-5 text-body-sm")}
          >
            {saving ? "Guardando…" : "Guardar estado"}
          </Button>
          {(myStatus.emoji !== "" || myStatus.text !== "") && (
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={saving}
              className="rounded-full px-3 py-2 text-body-sm font-medium text-muted-foreground outline-none interactive disabled:opacity-60"
            >
              Quitar
            </button>
          )}
        </div>
        {error !== null ? (
          <p role="alert" className="mt-2 text-meta text-danger">
            {error}
          </p>
        ) : null}
        {saved && error === null ? (
          <p role="status" className="mt-2 text-meta text-success">
            Estado guardado.
          </p>
        ) : null}
      </Card>
    </section>
  );
}
