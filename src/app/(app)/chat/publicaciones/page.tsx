import { Avatar } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { AVATAR_FALLBACK_COLOR } from "@/types/models";
import { POST_MEDIA_STYLES, SPACE_POSTS_MOCK } from "@/lib/mock/feed";

export default function PublicacionesPage(): React.JSX.Element {
  return (
    <div>
      <span className="sr-only">Publicaciones del espacio</span>
      <ul className="flex flex-col gap-4 px-3 py-3 md:gap-6 md:px-4">
        {SPACE_POSTS_MOCK.map((post, index) => (
          <li key={`${post.handle}-${post.time}`}>
            <Card className="p-4">
              <div className="flex gap-3">
                <Avatar initial={post.name.charAt(0)} color={AVATAR_FALLBACK_COLOR} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="min-w-0 truncate">
                    <span className="font-semibold text-foreground">{post.name}</span>{" "}
                    <span className="text-meta text-muted-foreground">
                      @{post.handle} · {post.time}
                    </span>
                  </p>
                  <p className="mt-1 text-body-sm leading-5 text-foreground">{post.text}</p>
                </div>
              </div>
              {post.withMedia ? (
                <div
                  aria-hidden="true"
                  className={`mt-3 h-36 rounded-lg ${POST_MEDIA_STYLES[index % POST_MEDIA_STYLES.length]}`}
                />
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
