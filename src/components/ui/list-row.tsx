import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type ListRowProps = {
  title: string;
  subtitle?: string;
  /** Texto pequeño a la derecha (hora, porcentaje, valor). */
  meta?: string;
  /** Muestra el punto de no leído color mention. */
  unread?: boolean;
  /** Inicial del avatar (se usa `color` de la paleta de models). */
  initial: string;
  color?: string;
  /** Enlace de la fila. Si se pasa, la fila es un <Link>. */
  href?: string;
  className?: string;
};

/**
 * Fila de lista del sistema (conversaciones): avatar 52 + título
 * text-body semibold + subtítulo text-body-sm muted + meta a la derecha
 * + punto de no leído opcional. Sin separadores.
 */
export function ListRow({
  title,
  subtitle,
  meta,
  unread = false,
  initial,
  color,
  href,
  className,
}: ListRowProps): React.JSX.Element {
  const content = (
    <>
      <Avatar initial={initial} color={color} size={52} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-semibold leading-6 text-foreground">
          {title}
        </span>
        {subtitle !== undefined && subtitle !== "" ? (
          <span className="block truncate text-body-sm leading-5 text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {meta !== undefined && meta !== "" ? (
          <span className="text-meta leading-4 text-muted-foreground">
            {meta}
          </span>
        ) : null}
        <span className="flex h-4 items-center">
          {unread ? (
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-mention" />
          ) : null}
        </span>
      </span>
    </>
  );
  const rowClass = cn(
    "flex items-center gap-3 rounded-lg px-2 py-4 outline-none interactive",
    className,
  );
  if (href !== undefined) {
    return (
      <Link href={href} className={rowClass}>
        {content}
      </Link>
    );
  }
  return <div className={rowClass}>{content}</div>;
}
