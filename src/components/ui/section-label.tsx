import { cn } from "@/lib/utils";

/** Etiqueta gris sobre tarjetas (secciones de perfil, configuración, etc.). */
export function SectionLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return (
    <p
      className={cn("px-1 pb-2 text-meta text-muted-foreground", className)}
      {...props}
    />
  );
}
