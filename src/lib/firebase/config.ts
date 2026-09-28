import type { FirebaseOptions } from "firebase/app";

export const useEmulators =
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";

const DEMO_API_KEY = "demo-api-key";
const DEMO_AUTH_DOMAIN = "demo-loki.firebaseapp.com";
const DEMO_PROJECT_ID = "demo-loki";
const DEMO_STORAGE_BUCKET = "demo-loki.appspot.com";
const DEMO_APP_ID = "demo-app";
const DEMO_MESSAGING_SENDER_ID = "000000000000";

export function getFirebaseConfig(): FirebaseOptions {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  const messagingSenderId =
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;

  if (useEmulators) {
    return {
      apiKey: apiKey || DEMO_API_KEY,
      authDomain: authDomain || DEMO_AUTH_DOMAIN,
      projectId: projectId || DEMO_PROJECT_ID,
      storageBucket: storageBucket || DEMO_STORAGE_BUCKET,
      messagingSenderId: messagingSenderId || DEMO_MESSAGING_SENDER_ID,
      appId: appId || DEMO_APP_ID,
    };
  }

  const missing: string[] = [];
  if (!apiKey) missing.push("NEXT_PUBLIC_FIREBASE_API_KEY");
  if (!authDomain) missing.push("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
  if (!projectId) missing.push("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  if (!storageBucket) missing.push("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET");
  if (!messagingSenderId)
    missing.push("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID");
  if (!appId) missing.push("NEXT_PUBLIC_FIREBASE_APP_ID");

  if (missing.length > 0) {
    throw new Error(
      `Missing Firebase config (${missing.join(", ")}). ` +
        `Set them in .env.local or set NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true for local emulators.`,
    );
  }

  return {
    apiKey: apiKey as string,
    authDomain: authDomain as string,
    projectId: projectId as string,
    storageBucket: storageBucket as string,
    messagingSenderId: messagingSenderId as string,
    appId: appId as string,
  };
}
