type ProgressRingProps = {
  /** Progreso de 0 a 100. */
  value: number;
  /** Diámetro en px. Por defecto 120. */
  size?: number;
  /** Texto al centro; por defecto el porcentaje. */
  label?: string;
};

/**
 * Anillo de progreso del sistema en SVG propio: fondo `surface` y arco
 * `accent`, con el valor al centro. Sin dependencias externas.
 */
export function ProgressRing({
  value,
  size = 120,
  label,
}: ProgressRingProps): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, value));
  const strokeWidth = 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? `Progreso ${Math.round(clamped)} por ciento`}
      style={{ width: size, height: size }}
      className="relative shrink-0"
    >
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-surface"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="stroke-accent"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-title font-semibold text-foreground">
        {label ?? `${Math.round(clamped)}%`}
      </span>
    </div>
  );
}
