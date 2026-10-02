"use client";

import * as React from "react";
import { Brain, Lock, ShieldAlert, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { useCreateMemory, useUpdateMemory } from "@/hooks/use-memories";
import {
  MEMORY_CATEGORIES,
  guessMemoryCategory,
  fromDateInput,
  looksSensitiveMemory,
  toDateInput,
} from "@/lib/memory/memory";
import type { MemoryCategory, MemoryItem, MemoryVisibility } from "@/types/organizer";
import { cn } from "@/lib/utils";

export type MemorySheetProps = {
  open: boolean;
  wsId: string;
  /** Recuerdo a editar; `null` para crear uno nuevo. */
  memory?: MemoryItem | null;
  /** Texto propuesto (mensaje del menú, punto de un resumen, suggestion de Loki). */
  initialContent?: string;
  /** Categorión propuesta por el que abre la hoja. */
  initialCategory?: MemoryCategory;
  /** Mensaje del que sale el recuerdo (menú o resumen). */
  sourceMessageId?: string | null;
  /** Recuerdo tomado de un DM: la hoja avisa y ofrece compartirlo. */
  fromDirectMessage?: boolean;
  onClose: () => void;
};

/**
 * Hoja de memoria: crear o editar un recuerdo del espacio.
 *
 * - El texto es lo único obligatorio; el resto (categoría, sensible, quién lo
 *   ve, caducidad) se propone y se corrige en la misma pantalla.
 * - Si el recuerdo viene de un DM, la hoja lo deja en "Solo yo" y dice que
 *   compartirlo con el espacio es una decisión explícita.
 * - Es el mismo formulario para el menú del mensaje, la pantalla Memoria y
 *   las sugerencias de Loki: nada se guarda sin que alguien lo confirme aquí.
 */
export function MemorySheet({
  open,
  wsId,
  memory = null,
  initialContent = "",
  initialCategory,
  sourceMessageId = null,
  fromDirectMessage = false,
  onClose,
}: MemorySheetProps): React.JSX.Element | null {
  const create = useCreateMemory(wsId);
  const update = useUpdateMemory(wsId);
  const saving = create.isPending || update.isPending;

  const [content, setContent] = React.useState("");
  const [category, setCategory] = React.useState<MemoryCategory>("otros");
  const [sensitive, setSensitive] = React.useState(false);
  const [visibility, setVisibility] = React.useState<MemoryVisibility>("espacio");
  const [expires, setExpires] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    if (memory !== null) {
      setContent(memory.content);
      setCategory(memory.category);
      setSensitive(memory.sensitive);
      setVisibility(memory.visibility);
      setExpires(memory.expiresAt !== null ? toDateInput(memory.expiresAt.toDate()) : "");
      return;
    }
    const seed = initialContent.trim();
    setContent(seed);
    setCategory(initialCategory ?? (seed !== "" ? guessMemoryCategory(seed) : "otros"));
    // Solo se propone: "clave" o "alergia" premarcan la casilla, y el usuario
    // puede quitarla (o ponerla) antes de confirmar.
    setSensitive(seed !== "" && looksSensitiveMemory(seed));
    // Lo que viene de un DM nace personal: compartirlo es otra decisión.
    setVisibility(fromDirectMessage ? "privado" : "espacio");
    setExpires("");
  }, [open, memory, initialContent, initialCategory, fromDirectMessage]);

  if (!open) return null;

  async function handleSave(): Promise<void> {
    const text = content.trim();
    if (text === "") return;
    const expiresAt = fromDateInput(expires);
    try {
      if (memory !== null) {
        await update.mutateAsync({
          id: memory.id,
          patch: {
            content: text,
            category,
            sensitive,
            visibility,
            // Compartir es la confirmación explícita que exige la base cuando
            // el recuerdo viene de un DM.
            shareConfirmed: visibility === "espacio",
            expiresAt,
          },
        });
      } else {
        await create.mutateAsync({
          content: text,
          category,
          sensitive,
          visibility,
          sourceMessageId,
          shareConfirmed: visibility === "espacio",
          expiresAt,
        });
      }
      onClose();
    } catch {
      // El mensaje en español lo pone el hook (RLS included).
    }
  }

  const error = (create.error ?? update.error)?.message ?? null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[92dvh] gap-3 overflow-y-auto p-4 sm:p-5">
        <DialogTitle>{memory !== null ? "Editar recuerdo" : "Recordar en el espacio"}</DialogTitle>
        <DialogDescription>
          Loki lo usará cuando alguien pregunte por esto. No se guarda nada solo.
        </DialogDescription>

        <label className="flex flex-col gap-1">
          <span className={labelClassName}>Qué hay que recordar</span>
          <textarea
            autoFocus
            aria-label="Recuerdo"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="La clave del wifi es…"
            className={`${inputClassName} min-h-22 py-3`}
          />
        </label>

        <div role="radiogroup" aria-label="Categoría" className="flex flex-wrap gap-2">
          {MEMORY_CATEGORIES.map((entry) => {
            const selected = category === entry.value;
            return (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setCategory(entry.value)}
                className={cn(
                  "flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-body-sm font-medium outline-none interactive",
                  selected
                    ? "border-accent bg-accent/10 text-foreground"
                    : "border-divider text-muted-foreground",
                )}
              >
                <span aria-hidden="true">{entry.emoji}</span>
                {entry.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 rounded-sm bg-surface-soft p-3">
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">
              <span className="flex items-center gap-1">
                <Icon icon={Lock} size={20} aria-hidden="true" />
                Sensible
              </span>
              <span className="block text-meta leading-4 text-muted-foreground">
                Oculto hasta que alguien pulse Mostrar. Nunca va en push.
              </span>
            </span>
            <Switch
              checked={sensitive}
              onCheckedChange={(checked) => setSensitive(checked)}
              label="Recuerdo sensible"
            />
          </label>

          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">
              Quién lo ve
              <span className="block text-meta leading-4 text-muted-foreground">
                {fromDirectMessage
                  ? "Viene de un mensaje directo: solo tú hasta que lo compartas."
                  : "Todo el espacio, o solo tú."}
              </span>
            </span>
            <select
              aria-label="Quién ve el recuerdo"
              value={visibility}
              onChange={(event) =>
                setVisibility(event.target.value === "privado" ? "privado" : "espacio")
              }
              className="h-11 shrink-0 rounded-sm bg-background px-2 text-body-sm text-foreground outline-none"
            >
              <option value="espacio">Todo el espacio</option>
              <option value="privado">Solo yo</option>
            </select>
          </label>

          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 text-body-sm text-foreground">
              <span className="flex items-center gap-1">
                <Icon icon={Brain} size={20} aria-hidden="true" />
                Caduca (opcional)
              </span>
              <span className="block text-meta leading-4 text-muted-foreground">
                Para lo que cambia, como un código.
              </span>
            </span>
            <input
              type="date"
              aria-label="Fecha de caducidad"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
              className="h-11 shrink-0 rounded-sm bg-background px-2 text-body-sm text-foreground outline-none"
            />
          </label>
        </div>

        {fromDirectMessage && visibility === "espacio" ? (
          <p className="text-body-sm leading-5 text-foreground">
            Vas a compartir con todo el espacio algo que se dijo en un mensaje
            directo. Si no es la idea, déjalo en “Solo yo”.
          </p>
        ) : null}

        {error !== null ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button
            type="button"
            disabled={saving || content.trim() === ""}
            onClick={() => void handleSave()}
            className="flex-1"
          >
            {saving ? "Guardando…" : memory !== null ? "Guardar cambios" : "Guardar recuerdo"}
          </Button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar sin guardar"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-soft text-foreground outline-none interactive"
          >
            <Icon icon={X} size={20} />
          </button>
        </div>

        <p className="flex items-start gap-1.5 text-meta leading-4 text-muted-foreground">
          <Icon icon={ShieldAlert} size={20} aria-hidden="true" className="shrink-0" />
          Loki solo responde con esto a quien lo pide dentro del espacio, y nunca
          lo incluye en un resumen diario.
        </p>
      </DialogContent>
    </Dialog>
  );
}