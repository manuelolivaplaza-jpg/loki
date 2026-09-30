/**
 * Logger estructurado de la app (T35).
 *
 * Solo `console` + evento DOM `loki:error`: sin servicios externos ni
 * dependencias nuevas. Los niveles `warn`/`error` emiten además un
 * `CustomEvent("loki:error")` con el detalle, para que el error boundary
 * o futuros paneles de diagnóstico lo escuchen sin acoplarse.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  level: LogLevel;
  message: string;
  /** Contexto extra (ids, pantalla). Nunca incluir secretos ni tokens. */
  context?: Record<string, string | number | boolean | null>;
  time: string;
};

function emit(entry: LogEntry): void {
  const line = `[loki:${entry.level}] ${entry.time} ${entry.message}${
    entry.context !== undefined ? ` ${JSON.stringify(entry.context)}` : ""
  }`;
  if (entry.level === "error") {
    console.error(line);
  } else if (entry.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
  if (
    (entry.level === "warn" || entry.level === "error") &&
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    window.dispatchEvent(
      new CustomEvent<LogEntry>("loki:error", { detail: entry }),
    );
  }
}

function now(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(message: string, context?: LogEntry["context"]): void {
    emit({ level: "debug", message, context, time: now() });
  },
  info(message: string, context?: LogEntry["context"]): void {
    emit({ level: "info", message, context, time: now() });
  },
  warn(message: string, context?: LogEntry["context"]): void {
    emit({ level: "warn", message, context, time: now() });
  },
  error(message: string, context?: LogEntry["context"]): void {
    emit({ level: "error", message, context, time: now() });
  },
};
