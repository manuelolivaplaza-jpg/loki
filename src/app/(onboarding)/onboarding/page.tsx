"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { updateProfile } from "firebase/auth";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { EmojiPicker } from "@/components/workspaces/emoji-picker";
import { KindPicker } from "@/components/workspaces/kind-picker";
import { EMOJI_OPTIONS } from "@/components/workspaces/workspace-options";
import { getFirebaseAuth } from "@/lib/firebase/auth";
import { updateUserProfile } from "@/lib/data/users";
import { createWorkspace } from "@/lib/data/workspaces";
import { cn } from "@/lib/utils";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import {
  AVATAR_COLORS,
  DEFAULT_AVATAR_COLOR,
  avatarTextColor,
  getAvatarInitial,
  isAvatarColor,
  type WorkspaceKind,
} from "@/types/models";

const pillButtonClassName =
  "flex h-11 w-full items-center justify-center rounded-full bg-foreground text-[15px] font-semibold text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60";

const ghostButtonClassName =
  "flex h-11 w-full items-center justify-center rounded-full text-[15px] font-medium text-muted-foreground outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60";

function StepIndicator({ step }: { step: 1 | 2 }): React.JSX.Element {
  return (
    <div className="mt-6">
      <div aria-hidden="true" className="flex gap-1.5">
        <span
          className={cn(
            "h-1 flex-1 rounded-full",
            step >= 1 ? "bg-foreground" : "bg-border-strong",
          )}
        />
        <span
          className={cn(
            "h-1 flex-1 rounded-full",
            step >= 2 ? "bg-foreground" : "bg-border-strong",
          )}
        />
      </div>
      <p className="sr-only" aria-live="polite">
        Paso {step} de 2
      </p>
    </div>
  );
}

export default function OnboardingPage(): React.JSX.Element {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const setProfile = useProfileStore((state) => state.setProfile);

  const [step, setStep] = React.useState<1 | 2>(1);
  const [displayName, setDisplayName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [avatarColor, setAvatarColor] =
    React.useState<string>(DEFAULT_AVATAR_COLOR);
  const [prefilled, setPrefilled] = React.useState(false);
  const [stepError, setStepError] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"create" | "join">("create");
  const [workspaceName, setWorkspaceName] = React.useState("");
  const [emoji, setEmoji] = React.useState<string>(
    EMOJI_OPTIONS[0]?.char ?? "🏠",
  );
  const [kind, setKind] = React.useState<WorkspaceKind>("family");
  const [inviteCode, setInviteCode] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const authDisplayName = user?.displayName ?? null;
  const authEmail = user?.email ?? null;

  React.useEffect(() => {
    if (profile === null) {
      if (!nameTouched && displayName === "") {
        const sessionBase = (authDisplayName ?? "").trim();
        if (sessionBase !== "") {
          setDisplayName(sessionBase);
        }
      }
      return;
    }
    if (isAvatarColor(profile.avatarColor)) {
      setAvatarColor(profile.avatarColor);
    }
    if (!nameTouched) {
      const base =
        profile.displayName.trim() !== "" ? profile.displayName.trim() : (authDisplayName ?? "").trim();
      if (base !== "" && displayName === "") {
        setDisplayName(base);
      }
    }
    setPrefilled(true);
  }, [profile, authDisplayName, nameTouched, prefilled, displayName]);

  const initial = getAvatarInitial(
    displayName === "" ? null : displayName,
    authEmail,
  );

  function handleProfileSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault();
    const name = displayName.trim();
    if (name === "") {
      setStepError("Escribe cómo te llamamos.");
      return;
    }
    if (name.length < 2) {
      setStepError("Usa al menos 2 caracteres.");
      return;
    }
    setStepError(null);
    setStep(2);
  }

  async function handleWorkspaceSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (mode !== "create") {
      return;
    }
    if (user === null) {
      setStepError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    const spaceName = workspaceName.trim();
    if (spaceName === "") {
      setStepError("Ponle un nombre a tu espacio.");
      return;
    }
    const name =
      displayName.trim() === ""
        ? (authDisplayName ?? "Miembro")
        : displayName.trim();
    setSaving(true);
    setStepError(null);
    try {
      const avatarInitial = getAvatarInitial(name, user.email);
      await updateUserProfile(user.uid, {
        displayName: name,
        avatarColor,
        avatarInitial,
        onboardingCompleted: true,
      });
      try {
        const auth = getFirebaseAuth();
        if (
          auth.currentUser !== null &&
          auth.currentUser.uid === user.uid
        ) {
          await updateProfile(auth.currentUser, { displayName: name });
        }
      } catch {
        // El displayName de Auth es secundario; el perfil ya quedó guardado.
      }
      const wsId = await createWorkspace(
        { name: spaceName, emoji, kind },
        { uid: user.uid, displayName: name, avatarColor },
      );
      if (profile !== null) {
        setProfile({
          ...profile,
          displayName: name,
          avatarColor,
          avatarInitial,
          onboardingCompleted: true,
          currentWorkspaceId: wsId,
        });
      }
      router.replace("/chat");
    } catch (error: unknown) {
      setStepError(
        error instanceof Error
          ? error.message
          : "No se pudo crear tu espacio. Inténtalo de nuevo.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="flex flex-col items-center text-center">
          <span
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-2xl font-semibold text-foreground"
          >
            L
          </span>
          <p className="mt-4 text-[15px] font-semibold text-foreground">Loki</p>
        </div>

        <StepIndicator step={step} />

        <AnimatePresence mode="wait" initial={false}>
          {step === 1 ? (
            <motion.div
              key="step-profile"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <h1 className="mt-6 text-[24px] font-semibold leading-tight text-foreground">
                ¿Cómo te llamamos?
              </h1>
              <p className="mt-1 text-[15px] text-muted-foreground">
                Así te verán en tus espacios.
              </p>

              <form
                onSubmit={handleProfileSubmit}
                className="mt-6 flex flex-col gap-5"
              >
                <div className="flex items-center gap-4">
                  <span
                    aria-hidden="true"
                    style={{
                      backgroundColor: avatarColor,
                      color: avatarTextColor(avatarColor),
                    }}
                    className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl font-semibold"
                  >
                    {initial}
                  </span>
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="onboarding-displayName"
                      className={labelClassName}
                    >
                      Nombre
                    </label>
                    <input
                      id="onboarding-displayName"
                      name="displayName"
                      type="text"
                      autoComplete="name"
                      required
                      minLength={2}
                      maxLength={40}
                      value={displayName}
                      onChange={(event) => {
                        setNameTouched(true);
                        setDisplayName(event.target.value);
                      }}
                      placeholder="Tu nombre"
                      className={inputClassName}
                    />
                  </div>
                </div>

                <div>
                  <span id="avatar-color-label" className={labelClassName}>
                    Color de avatar
                  </span>
                  <div
                    role="radiogroup"
                    aria-labelledby="avatar-color-label"
                    className="flex flex-wrap gap-2.5"
                  >
                    {AVATAR_COLORS.map((option) => {
                      const selected = avatarColor === option.value;
                      return (
                        <label
                          key={option.value}
                          className="cursor-pointer rounded-full outline-none focus-within:ring-2 focus-within:ring-accent"
                        >
                          <input
                            type="radio"
                            name="avatarColor"
                            value={option.value}
                            checked={selected}
                            onChange={() => setAvatarColor(option.value)}
                            aria-label={option.name}
                            className="sr-only"
                          />
                          <span
                            aria-hidden="true"
                            style={{
                              backgroundColor: option.value,
                              color: avatarTextColor(option.value),
                            }}
                            className={cn(
                              "flex h-9 w-9 items-center justify-center rounded-full text-[15px] font-semibold",
                              selected &&
                                "ring-2 ring-accent ring-offset-2 ring-offset-background",
                            )}
                          >
                            {initial}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {stepError !== null ? (
                  <p role="alert" className="text-[13px] text-danger">
                    {stepError}
                  </p>
                ) : null}

                <button type="submit" className={pillButtonClassName}>
                  Continuar
                </button>
              </form>
            </motion.div>
          ) : (
            <motion.div
              key="step-workspace"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <h1 className="mt-6 text-[24px] font-semibold leading-tight text-foreground">
                Crea tu primer espacio
              </h1>
              <p className="mt-1 text-[15px] text-muted-foreground">
                Un espacio para tu familia o tu equipo.
              </p>

              <div
                role="group"
                aria-label="Elige cómo empezar"
                className="mt-6 grid grid-cols-2 gap-3"
              >
                <button
                  type="button"
                  aria-pressed={mode === "create"}
                  onClick={() => {
                    setMode("create");
                    setStepError(null);
                  }}
                  className={cn(
                    "rounded-2xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                    mode === "create"
                      ? "border-accent bg-surface"
                      : "border-border-strong bg-background hover:bg-surface",
                  )}
                >
                  <span className="block text-[15px] font-semibold text-foreground">
                    Crear un espacio
                  </span>
                  <span className="mt-1 block text-[13px] text-muted-foreground">
                    Empieza desde cero
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "join"}
                  onClick={() => {
                    setMode("join");
                    setStepError(null);
                  }}
                  className={cn(
                    "rounded-2xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                    mode === "join"
                      ? "border-accent bg-surface"
                      : "border-border-strong bg-background hover:bg-surface",
                  )}
                >
                  <span className="block text-[15px] font-semibold text-foreground">
                    Unirme con un código
                  </span>
                  <span className="mt-1 block text-[13px] text-muted-foreground">
                    Usa una invitación
                  </span>
                </button>
              </div>

              {mode === "create" ? (
                <form
                  onSubmit={handleWorkspaceSubmit}
                  className="mt-5 flex flex-col gap-5"
                >
                  <div>
                    <label
                      htmlFor="onboarding-workspace"
                      className={labelClassName}
                    >
                      Nombre del espacio
                    </label>
                    <input
                      id="onboarding-workspace"
                      name="workspaceName"
                      type="text"
                      required
                      maxLength={40}
                      value={workspaceName}
                      onChange={(event) =>
                        setWorkspaceName(event.target.value)
                      }
                      placeholder="p. ej. Familia García"
                      className={inputClassName}
                    />
                  </div>

                  <div>
                    <span
                      id="workspace-emoji-label"
                      className={labelClassName}
                    >
                      Emoji
                    </span>
                    <EmojiPicker value={emoji} onChange={setEmoji} labelId="workspace-emoji-label" />
                  </div>

                  <div>
                    <span id="workspace-kind-label" className={labelClassName}>
                      Tipo de espacio
                    </span>
                    <KindPicker value={kind} onChange={setKind} labelId="workspace-kind-label" />
                  </div>

                  {stepError !== null ? (
                    <p role="alert" className="text-[13px] text-danger">
                      {stepError}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    disabled={saving}
                    className={pillButtonClassName}
                  >
                    {saving ? "Creando espacio..." : "Crear espacio"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStep(1);
                      setStepError(null);
                    }}
                    disabled={saving}
                    className={ghostButtonClassName}
                  >
                    Atrás
                  </button>
                </form>
              ) : (
                <div className="mt-5 flex flex-col gap-4">
                  <div>
                    <label
                      htmlFor="onboarding-invite"
                      className={labelClassName}
                    >
                      Código de invitación
                    </label>
                    <input
                      id="onboarding-invite"
                      name="inviteCode"
                      type="text"
                      autoComplete="off"
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value)}
                      placeholder="Pega tu código"
                      className={inputClassName}
                    />
                  </div>
                  <button
                    type="button"
                    disabled
                    title="Disponible próximamente"
                    className={pillButtonClassName}
                  >
                    Próximamente
                  </button>
                  <p className="text-[13px] text-muted-foreground">
                    Los códigos de invitación llegan en T8.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setStep(1);
                      setStepError(null);
                    }}
                    className={ghostButtonClassName}
                  >
                    Atrás
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
