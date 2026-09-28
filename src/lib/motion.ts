import type { Transition, Variants } from "framer-motion";

/**
 * Único spring del sistema de diseño. Todos los `motion.*` lo usan:
 * importa `spring` (o las variantes compartidas) desde aquí en vez de
 * definir transiciones ad hoc en cada pantalla.
 */
export const spring: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.9,
};

/** Aparición suave con escala (dialogs, sheets, menús flotantes). */
export const fadeScale: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 12 },
  show: { opacity: 1, scale: 1, y: 0, transition: spring },
  exit: { opacity: 0, scale: 0.97, y: 12, transition: spring },
};

/** Aparición deslizante (items de lista, pasos de onboarding). */
export const slideUp: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: spring },
  exit: { opacity: 0, y: 10, transition: spring },
};

/** Contenedor con aparición escalonada para listas de acciones. */
export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.05 } },
};

/** Fundido simple para overlays. */
export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: spring },
  exit: { opacity: 0, transition: spring },
};
