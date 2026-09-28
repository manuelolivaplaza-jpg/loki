import { redirect } from "next/navigation";

// Las ideas viven dentro de Proyectos, en la pestaña Ideas.
export default function IdeasPage(): never {
  redirect("/proyectos?tab=ideas");
}
