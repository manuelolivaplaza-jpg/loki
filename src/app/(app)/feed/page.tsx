type FeedPost = {
  name: string;
  handle: string;
  time: string;
  text: string;
  withMedia: boolean;
};

// TODO: datos de ejemplo solo para verificar el efecto glass de la barra inferior en /feed.
// Bloques con tintes sobrios (tokens con opacidad) para apreciar el blur sin colores chillones.
const MEDIA_STYLES: readonly string[] = [
  "bg-accent/15",
  "bg-mention/15",
  "bg-success/15",
  "bg-warning/20",
  "bg-gradient-to-br from-accent/20 to-mention/20",
];
const EXAMPLE_POSTS: FeedPost[] = [
  { name: "Loki", handle: "loki", time: "2 min", text: "Probando el layout denso estilo X. El feed ahora ocupa todo el ancho.", withMedia: true },
  { name: "Ada Lovelace", handle: "ada", time: "18 min", text: "El panel derecho pegado al borde deja respirar la columna central.", withMedia: false },
  { name: "Alan Turing", handle: "turing", time: "32 min", text: "La barra inferior liquid glass deja pasar el contenido por detrás.", withMedia: true },
  { name: "Grace Hopper", handle: "grace", time: "1 h", text: "Nav items de 40px se sienten mucho más densos que antes.", withMedia: false },
  { name: "Linus Torvalds", handle: "linus", time: "2 h", text: "Sidebar de 68px en md y 220px en xl. Sin márgenes vacíos.", withMedia: false },
  { name: "Margaret Hamilton", handle: "margaret", time: "3 h", text: "El header de 53px con blur queda sobrio sobre el feed.", withMedia: true },
  { name: "Dennis Ritchie", handle: "dmr", time: "5 h", text: "Tipografía 15px en posts, 13px en metadata. Legible y compacta.", withMedia: false },
  { name: "Barbara Liskov", handle: "liskov", time: "7 h", text: "Al ocultar el panel, la columna crece y ocupa ese espacio.", withMedia: false },
  { name: "Ken Thompson", handle: "ken", time: "9 h", text: "Una sola línea divisoria entre sidebar y columna. Nada doble.", withMedia: true },
  { name: "Radia Perlman", handle: "radia", time: "12 h", text: "El blur de 24px con saturación se nota sobre bloques de color.", withMedia: false },
  { name: "Tim Berners-Lee", handle: "timbl", time: "1 d", text: "Gradientes sobrios con tokens para no romper el contraste.", withMedia: true },
  { name: "Katherine Johnson", handle: "katherine", time: "2 d", text: "Padding inferior con safe-area para que nada quede tapado.", withMedia: false },
];

export default function FeedPage(): React.JSX.Element {
  return (
    <ul className="divide-y divide-border">
      {EXAMPLE_POSTS.map((post, index) => (
        <li key={`${post.handle}-${post.time}`} className="flex gap-3 px-3 py-3 md:px-4">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[15px] font-semibold text-foreground"
          >
            {post.name.charAt(0)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="min-w-0 truncate">
              <span className="font-semibold text-foreground">{post.name}</span>{" "}
              <span className="text-meta text-muted-foreground">
                @{post.handle} · {post.time}
              </span>
            </p>
            <p className="mt-0.5 text-[15px] leading-5 text-foreground">{post.text}</p>
            {post.withMedia ? (
              <div
                aria-hidden
                className={`mt-2 h-36 rounded-2xl border border-border ${MEDIA_STYLES[index % MEDIA_STYLES.length]}`}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
