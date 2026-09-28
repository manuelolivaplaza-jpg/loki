import { redirect } from "next/navigation";

// El Feed se unió al Chat: las publicaciones viven en /chat/publicaciones.
export default function FeedPage(): never {
  redirect("/chat");
}
