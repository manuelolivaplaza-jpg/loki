"use client";

import { cn } from "@/lib/utils";
import type { WorkspaceKind } from "@/types/models";

type KindPickerProps = {
  value: WorkspaceKind;
  onChange: (value: WorkspaceKind) => void;
  labelId: string;
};

export function KindPicker({ value, onChange, labelId }: KindPickerProps): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      className="grid grid-cols-2 gap-1 rounded-full bg-surface-soft p-1"
    >
      <label className="cursor-pointer rounded-full outline-none focus-within:ring-2 focus-within:ring-accent">
        <input
          type="radio"
          name="workspaceKind"
          value="family"
          checked={value === "family"}
          onChange={() => onChange("family")}
          aria-label="Familia"
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "block rounded-full px-3 py-2 text-center text-body-sm font-medium transition-colors",
            value === "family" ? "bg-background text-foreground shadow-float" : "text-muted-foreground",
          )}
        >
          Familia
        </span>
      </label>
      <label className="cursor-pointer rounded-full outline-none focus-within:ring-2 focus-within:ring-accent">
        <input
          type="radio"
          name="workspaceKind"
          value="team"
          checked={value === "team"}
          onChange={() => onChange("team")}
          aria-label="Equipo"
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "block rounded-full px-3 py-2 text-center text-body-sm font-medium transition-colors",
            value === "team" ? "bg-background text-foreground shadow-float" : "text-muted-foreground",
          )}
        >
          Equipo
        </span>
      </label>
    </div>
  );
}
