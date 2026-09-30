"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { logger } from "@/lib/logger";

type ErrorBoundaryProps = {
  /** Nombre de la sección (sale en el aviso y en el log). */
  section: string;
  children: React.ReactNode;
};

type ErrorBoundaryState = { error: Error | null };

/**
 * Error boundary por sección (T35).
 *
 * Se monta en `AppShell` por sección (contenido, panel contextual,
 * búsqueda): si una sección rompe, las demás siguen vivas. El aviso está
 * en español con botón de reintento que desmonta el error.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    logger.error("Error en la sección", {
      section: this.props.section,
      message: error.message,
    });
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 px-6 py-16 text-center"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-soft">
            <Icon
              icon={TriangleAlert}
              size={24}
              className="text-muted-foreground"
            />
          </span>
          <p className="text-body font-semibold text-foreground">
            Algo falló en {this.props.section}
          </p>
          <p className="max-w-xs text-body-sm leading-5 text-muted-foreground">
            Puedes reintentar sin perder el resto de la app.
          </p>
          <Button type="button" variant="secondary" onClick={this.handleRetry}>
            Reintentar
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
