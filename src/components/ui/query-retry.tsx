import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type QueryRetryProps = {
  /** Mensaje en español (ya viene de la capa de datos). */
  message: string;
  /** Reintenta la query (`refetch` o `retry` del hook). */
  onRetry: () => void;
  /** ¿Hay un reintento en curso? */
  loading?: boolean;
  className?: string;
};

/**
 * Error de lista con reintento (patrón T34).
 *
 * Todas las queries de lista lo montan con su mensaje en español y su
 * `refetch`/`retry`: conversación, publicaciones, chats, calendario,
 * proyectos, notificaciones e hilo.
 */
export function QueryRetry({
  message,
  onRetry,
  loading = false,
  className,
}: QueryRetryProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 px-4 py-8 text-center",
        className,
      )}
    >
      <p className="text-body-sm leading-5 text-danger">{message}</p>
      <Button
        type="button"
        variant="secondary"
        onClick={onRetry}
        disabled={loading}
      >
        {loading ? "Reintentando…" : "Reintentar"}
      </Button>
    </div>
  );
}
