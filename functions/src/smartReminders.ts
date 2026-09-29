/**
 * T18: `smartReminders` — avisos inteligentes de Loki.
 *
 * ⚠️ FASE 1-2: es un STUB. La función está declarada, se compila y está
 * programada para correr cada hora, pero ahora mismo SOLO hace log: no lee
 * calendarios ni escribe nada.
 *
 * Qué hará cuando se implemente (TODO de datos reales):
 *
 *  1. Recorrer los usuarios de la app (los que tengan al menos un espacio).
 *  2. Leer sus calendarios/eventos de HOY y de mañana desde la fuente real
 *     (hoy no hay integración de calendario en el modelo de datos: habría que
 *     añadir `users/{uid}/calendarSources` + eventos, o pedir permisos y
 *     sincronizar; ver `firestore.rules` para el sitio donde colgarlo).
 *  3. Cruzar los eventos con los chats de los espacios para detectar lo que
 *     la persona dijo que iba a hacer ("voy al médico a las 7", "llamar a
 *     mamá") y producir UN aviso por usuario, no uno por evento.
 *  4. Escribirlo con Admin SDK como mensaje `type: "ai"` en su chat privado
 *     `users/{uid}/aiChats/loki-ia/messages` (misma vía que `aiChat`), con un
 *     texto del tipo:
 *
 *        Manu, recuerda que hoy a las 7pm tienes cita con el médico.
 *
 *     (el nombre va en el texto porque el aviso se lee en el chat, no como
 *     notificación push; el push llegó más adelante, en la fase de
 *     notificaciones).
 *  5. Deduplicar por día: un doc `users/{uid}/aiReminders/{yyyy-mm-dd}` con
 *     los ids de aviso ya escritos, para no repetir el mismo aviso cada hora.
 *
 * Criterios que conviene respetar: máximo 1 aviso por usuario y día, no
 * escribir nada si no hay nada real que recordar (mejor silencio que
 * inventario), y nunca inventar horas ni citas: si el dato no está en el
 * calendario, no se menciona.
 */

import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";

// La región se fija UNA vez en `index.ts` (setGlobalOptions): aquí va solo en
// la propia función, que es donde se usa.

/**
 * Cada hora en punto (`:00`), hora de Madrid. Con `maxInstances: 1` no se
 * solapan ejecuciones: si una se pasa de la hora, Cloud Scheduler
 * salta la siguiente en vez de apilar.
 */
export const smartReminders = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "Europe/Madrid",
    region: "europe-west1",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async (): Promise<void> => {
    // TODO(T18-datos): pasos 1-5 del encabezado de este archivo. Hasta
    // entonces esta función no lee calendarios ni escribe mensajes: solo
    // deja rastro en los logs, para que se vea que el schedule está vivo.
    logger.info("smartReminders (stub T18): sin acciones", {
      motivo: "datos de calendario todavía no implementados",
      ejemplo: "Manu, recuerda que hoy a las 7pm tienes cita con el médico.",
    });
  },
);
