"use client";

import { cn } from "@/lib/utils";
import { EMOJI_OPTIONS } from "@/components/workspaces/workspace-options";

type EmojiPickerProps = {
  value: string;
  onChange: (value: string) => void;
  labelId: string;
};

export function EmojiPicker({ value, onChange, labelId }: EmojiPickerProps): React.JSX.Element {
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="grid grid-cols-6 gap-2"
    >
      {EMOJI_OPTIONS.map((option) => {
        const selected = value === option.char;
        return (
          <button
            key={option.char}
            type="button"
            aria-label={option.name}
            aria-pressed={selected}
            onClick={() => onChange(option.char)}
            className={cn(
              "flex h-10 items-center justify-center rounded-xl border text-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
              selected
                ? "border-accent bg-surface"
                : "border-border-strong bg-background hover:bg-surface",
            )}
          >
            <span aria-hidden="true">{option.char}</span>
          </button>
        );
      })}
    </div>
  );
}
