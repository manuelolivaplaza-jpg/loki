import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";

export const metadata = {
  title: "Términos y privacidad",
  description: "Términos de uso y política de privacidad de Loki.",
};

const SECTIONS: readonly { title: string; body: string }[] = [
  {
    title: "Qué es Loki",
    body: "Loki es una app familiar para chats, publicaciones, calendario, proyectos y un asistente (Loki IA). La usas con tu cuenta en tus espacios; lo que compartas ahí lo ven sus miembros.",
  },
  {
    title: "Tus datos",
    body: "Tus mensajes, eventos, tareas y archivos viven en la base de datos del proyecto (Supabase) con reglas que solo dejan ver a los miembros de cada espacio. Puedes pedir la eliminación de tu cuenta y sus datos al administrador del proyecto.",
  },
  {
    title: "Loki IA",
    body: "Al hablar con Loki IA, tus mensajes se envían al proveedor de IA configurado para generar la respuesta. No se usa tu información para entrenar modelos por nuestra parte; revisa también la política del proveedor que el administrador elija.",
  },
  {
    title: "Notificaciones",
    body: "Si activas las notificaciones, tu dispositivo registra un token push para avisarte de novedades. Puedes desactivarlas cuando quieras desde la configuración de tu dispositivo o de la app.",
  },
  {
    title: "Uso responsable",
    body: "No compartas contenido ilegal, ni datos de terceros sin su permiso. El administrador de un espacio puede expulsar a quien incumpla estas reglas.",
  },
  {
    title: "Contacto",
    body: "Para dudas o eliminación de datos, escribe al administrador del proyecto donde está alojada tu cuenta de Loki.",
  },
];

/** Página pública /legal: términos y privacidad breves, en español. */
export default function LegalPage(): React.JSX.Element {
  return (
    <main className="flex min-h-dvh justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[640px]">
        <div className="flex flex-col items-center text-center">
          <Avatar initial="L" size={64} />
          <h1 className="mt-4 text-display font-semibold leading-tight text-foreground">
            Términos y privacidad
          </h1>
          <p className="mt-1 text-body-sm text-muted-foreground">
            Texto propio y breve. Última actualización: 2026.
          </p>
        </div>
        {SECTIONS.map((section) => (
          <section key={section.title} className="mt-6">
            <h2 className="text-body font-semibold text-foreground">{section.title}</h2>
            <p className="mt-1 text-body-sm leading-6 text-muted-foreground">{section.body}</p>
          </section>
        ))}
        <Link
          href="/login"
          className="mt-8 flex h-11 w-full items-center justify-center rounded-full bg-foreground px-6 text-body-sm font-semibold text-background outline-none interactive-solid dark:bg-white dark:text-black"
        >
          Volver al inicio de sesión
        </Link>
      </div>
    </main>
  );
}
