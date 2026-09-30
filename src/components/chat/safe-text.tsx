import * as React from "react";

/**
 * Texto seguro con enlaces (T35).
 *
 * Los mensajes y publicaciones renderizan texto plano o este mínimo
 * seguro: el HTML se escapa (React nunca usa `dangerouslySetInnerHTML`) y
 * solo las URLs `http(s)://` se vuelven enlaces (`target _blank`,
 * `rel="noopener noreferrer"`). Cualquier otro esquema (javascript:,
 * data:, …) queda como texto.
 */

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Un segmento de texto plano con sus enlaces seguros. */
export function SafeText({ text }: { text: string }): React.JSX.Element {
  const parts = React.useMemo(() => {
    const out: React.ReactNode[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    URL_RE.lastIndex = 0;
    let key = 0;
    while ((match = URL_RE.exec(text)) !== null) {
      const url = match[0];
      const start = match.index;
      if (start > last) {
        out.push(
          <React.Fragment key={key++}>{text.slice(last, start)}</React.Fragment>,
        );
      }
      if (isSafeHttpUrl(url)) {
        out.push(
          <a
            key={key++}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-mention underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {url}
          </a>,
        );
      } else {
        out.push(<React.Fragment key={key++}>{url}</React.Fragment>);
      }
      last = start + url.length;
    }
    if (last < text.length) {
      out.push(<React.Fragment key={key++}>{text.slice(last)}</React.Fragment>);
    }
    return out;
  }, [text]);

  return <>{parts}</>;
}
