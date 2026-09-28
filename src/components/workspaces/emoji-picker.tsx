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
              "flex h-10 items-center justify-center rounded-sm bg-surface-soft text-title outline-none interactive",
              selected &&
                "ring-2 ring-accent ring-offset-2 ring-offset-background",
            )}
          >
            <span aria-hidden="true">{option.char}</span>
          </button>
        );
      })}
    </div>
  );
}
