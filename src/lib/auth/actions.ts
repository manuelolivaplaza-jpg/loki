"use client";

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/auth";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  "auth/email-already-in-use":
    "Este correo ya está registrado. Inicia sesión.",
  "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/user-not-found": "Correo o contraseña incorrectos.",
  "auth/wrong-password": "Correo o contraseña incorrectos.",
  "auth/invalid-email": "Ingresa un correo válido.",
  "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
  "auth/missing-password": "Ingresa tu contraseña.",
  "auth/missing-email": "Ingresa tu correo.",
  "auth/too-many-requests":
    "Demasiados intentos. Espera un momento e inténtalo de nuevo.",
  "auth/popup-closed-by-user":
    "Se cerró la ventana de Google. Inténtalo de nuevo.",
  "auth/cancelled-popup-request": "Inténtalo de nuevo.",
  "auth/popup-blocked":
    "El navegador bloqueó la ventana de Google. Permítela e inténtalo de nuevo.",
  "auth/network-request-failed":
    "Error de red. Revisa tu conexión e inténtalo de nuevo.",
};

export function getAuthErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && AUTH_ERROR_MESSAGES[code] !== undefined) {
      return AUTH_ERROR_MESSAGES[code] as string;
    }
  }
  if (error instanceof Error && error.message !== "") {
    // Si ya es un mensaje en español lanzado por estas acciones, lo respetamos.
    return error.message;
  }
  return "Ocurrió un error. Inténtalo de nuevo.";
}

export async function signUpWithEmail(
  email: string,
  password: string,
  displayName: string,
): Promise<void> {
  try {
    const auth = getFirebaseAuth();
    const credential = await createUserWithEmailAndPassword(
      auth,
      email.trim(),
      password,
    );
    const name = displayName.trim();
    if (name !== "") {
      await updateProfile(credential.user, { displayName: name });
    }
  } catch (error: unknown) {
    throw new Error(getAuthErrorMessage(error));
  }
}

export async function signInWithEmail(
  email: string,
  password: string,
): Promise<void> {
  try {
    await signInWithEmailAndPassword(
      getFirebaseAuth(),
      email.trim(),
      password,
    );
  } catch (error: unknown) {
    throw new Error(getAuthErrorMessage(error));
  }
}

export async function signInWithGoogle(): Promise<void> {
  try {
    // TODO: en Capacitor usar el plugin nativo de Google Sign-In en lugar de
    // signInWithPopup (los popups no funcionan bien en WebView móvil).
    const provider = new GoogleAuthProvider();
    await signInWithPopup(getFirebaseAuth(), provider);
  } catch (error: unknown) {
    throw new Error(getAuthErrorMessage(error));
  }
}

export async function signOutUser(): Promise<void> {
  try {
    await signOut(getFirebaseAuth());
  } catch (error: unknown) {
    throw new Error(getAuthErrorMessage(error));
  }
}
