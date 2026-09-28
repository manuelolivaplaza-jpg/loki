// MOCK: reemplazar por Firestore. Datos de ejemplo de la pantalla /inicio.

export type HomeTask = {
  id: string;
  title: string;
  meta: string;
  done: boolean;
};

export type HomeEvent = {
  id: string;
  title: string;
  when: string;
  location?: string;
};

export type HomeActivity = {
  id: string;
  name: string;
  text: string;
  time: string;
  color: string;
};

export type HomeDayMark = {
  /** Día del mes. */
  day: number;
  /** Si hay eventos ese día (punto bajo el número). */
  hasEvents: boolean;
};

export type HomeData = {
  tasksCompleted: number;
  tasksTotal: number;
  activeProjects: number;
  weekEvents: number;
  todayTasks: HomeTask[];
  upcomingEvents: HomeEvent[];
  recentActivity: HomeActivity[];
};

export const HOME_MOCK: HomeData = {
  tasksCompleted: 12,
  tasksTotal: 16,
  activeProjects: 3,
  weekEvents: 5,
  todayTasks: [
    { id: "t1", title: "Comprar víveres", meta: "Hoy · 18:00", done: false },
    { id: "t2", title: "Revisar propuesta de diseño", meta: "Hoy · 12:30", done: true },
    { id: "t3", title: "Llamar al seguro", meta: "Hoy · 17:00", done: false },
  ],
  upcomingEvents: [
    { id: "e1", title: "Reunión de equipo", when: "Hoy · 16:00" },
    { id: "e2", title: "Cena familiar", when: "Vie · 20:30", location: "Casa de mamá" },
    { id: "e3", title: "Club de lectura", when: "Sáb · 11:00" },
  ],
  recentActivity: [
    { id: "a1", name: "Lucía", text: "subió la propuesta nueva", time: "hace 20 min", color: "#1d9bf0" },
    { id: "a2", name: "Martín", text: "completó 3 tareas", time: "hace 1 h", color: "#00ba7c" },
    { id: "a3", name: "Ana", text: "comentó en el capítulo 4", time: "ayer", color: "#6d5fc0" },
  ],
};

/** Marcas de la semana actual para la tira semanal (lunes a domingo). */
export const HOME_WEEK_MARKS: readonly HomeDayMark[] = [
  { day: 22, hasEvents: true },
  { day: 23, hasEvents: false },
  { day: 24, hasEvents: true },
  { day: 25, hasEvents: false },
  { day: 26, hasEvents: true },
  { day: 27, hasEvents: false },
  { day: 28, hasEvents: false },
];
