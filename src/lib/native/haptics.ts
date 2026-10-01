/**
 * Hápticos con degradación elegante: en la app Android suenan, en el
 * navegador son un no-op silencioso (y en iOS Safari, donde no existe el
 * plugin, tampoco rompen nada).
 *
 * Import dinámico para no meter `@capacitor/haptics` en el bundle web.
 */

/** Toque leve: al empezar a grabar, al confirmar una acción. */
export async function hapticsLight(): Promise<void> {
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Web sin hápticos (o plugin no instalado): se sigue igual.
  }
}

/** Toque de aviso: cancelar, cortar la grabación al ir a segundo plano. */
export async function hapticsWarn(): Promise<void> {
  try {
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    await Haptics.notification({ type: NotificationType.Warning });
  } catch {
    // Sin soporte: se sigue igual.
  }
}

/** Éxito: la transcripción quedó lista, la acción se creó. */
export async function hapticsSuccess(): Promise<void> {
  try {
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    // Sin soporte: se sigue igual.
  }
}
