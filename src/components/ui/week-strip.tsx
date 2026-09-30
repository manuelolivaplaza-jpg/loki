import { cn } from "@/lib/utils";

export type WeekDayMark = {
  /** Número del día del mes. */
  day: number;
  /** Si hay eventos ese día (punto bajo el número). */
  hasEvents: boolean;
};

type WeekStripProps = {
  /** 7 marcas de lunes a domingo. */
  days: readonly WeekDayMark[];
  /** Índice (0-6) del día resaltado como hoy. */
  todayIndex: number;
  /** Día seleccionado (controlado); por defecto, hoy. */
  selectedIndex?: number;
  /** Al tocar otro día. */
  onSelectDay?: (index: number) => void;
};

const WEEKDAY_LETTERS: readonly string[] = ["L", "M", "M", "J", "V", "S", "D"];

/**
 * Mini calendario semanal del sistema: 7 columnas con letra del día y
 * número; hoy resaltado con pastilla foreground y puntos bajo los días
 * con eventos.
 */
export function WeekStrip({
  days,
  todayIndex,
  selectedIndex,
  onSelectDay,
}: WeekStripProps): React.JSX.Element {
  const selected = selectedIndex ?? todayIndex;
  return (
    <ol aria-label="Semana actual" className="grid grid-cols-7">
      {days.map((item, index) => {
        const isToday = index === todayIndex;
        const isSelected = index === selected;
        return (
          <li
            key={`${WEEKDAY_LETTERS[index] ?? ""}-${item.day}`}
            className="flex flex-col items-center gap-1 py-2"
          >
            <span
              aria-hidden="true"
              className="text-meta leading-4 text-muted-foreground"
            >
              {WEEKDAY_LETTERS[index] ?? ""}
            </span>
            <button
              type="button"
              onClick={() => onSelectDay?.(index)}
              aria-pressed={isSelected}
              aria-label={`${WEEKDAY_LETTERS[index] ?? ""} ${item.day}${isToday ? ", hoy" : ""}`}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-body-sm font-medium outline-none interactive",
                isSelected
                  ? "bg-foreground font-semibold text-background dark:bg-white dark:text-black"
                  : "text-foreground",
                !isSelected && isToday && "ring-1 ring-accent",
              )}
            >
              {item.day}
            </button>
            <span className="flex h-1 items-center" aria-hidden="true">
              {item.hasEvents ? (
                <span className="h-1 w-1 rounded-full bg-muted-foreground" />
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
