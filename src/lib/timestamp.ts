/**
 * Marca de tiempo inmutable compatible con la que usaba Firestore.
 *
 * Tras la migración a Supabase (T21) las fechas llegan como ISO y ningún
 * módulo de `src/` puede importar `firebase/firestore` (T24). Los tipos
 * públicos (`MessageDoc.createdAt`, `UserProfile.createdAt`…) siguen
 * declarando `Timestamp`, así que esta clase conserva el mismo nombre y la
 * superficie que usa la app: `seconds`/`nanoseconds`, `toDate()`,
 * `toMillis()`, `fromDate()`, `fromMillis()`, `now()` e `isEqual()`.
 *
 * Puro (sin React ni dependencias): se puede importar desde cualquier capa
 * y desde los tests de Node.
 */

const MILLIS_PER_SECOND = 1000;
const NANOS_PER_MILLI = 1_000_000;

function assertRange(seconds: number, nanoseconds: number): void {
  if (!Number.isInteger(seconds) || !Number.isInteger(nanoseconds)) {
    throw new Error("Timestamp inválido: segundos y nanos enteros.");
  }
  if (nanoseconds < 0 || nanoseconds >= 1_000_000_000) {
    throw new Error("Timestamp inválido: nanos fuera de rango.");
  }
}

export class Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;

  constructor(seconds: number, nanoseconds: number) {
    assertRange(seconds, nanoseconds);
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }

  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }

  static fromDate(date: Date): Timestamp {
    return Timestamp.fromMillis(date.getTime());
  }

  static fromMillis(milliseconds: number): Timestamp {
    const ms = Math.floor(milliseconds);
    const seconds = Math.floor(ms / MILLIS_PER_SECOND);
    return new Timestamp(seconds, (ms - seconds * MILLIS_PER_SECOND) * NANOS_PER_MILLI);
  }

  toDate(): Date {
    return new Date(this.toMillis());
  }

  toMillis(): number {
    return this.seconds * MILLIS_PER_SECOND + Math.floor(this.nanoseconds / NANOS_PER_MILLI);
  }

  isEqual(other: Timestamp): boolean {
    return this.seconds === other.seconds && this.nanoseconds === other.nanoseconds;
  }

  toJSON(): { seconds: number; nanoseconds: number } {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds };
  }

  toString(): string {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
}
