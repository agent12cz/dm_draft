"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase";

type UserProfile = {
  uid: string;
  displayName: string;
  email: string;
  role: "admin" | "participant";
  createdAt?: unknown;
  updatedAt?: unknown;
};

type AuthContextValue = {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<boolean>;
  signUp: (email: string, password: string, displayName: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const PROFILE_MISSING_MESSAGE = "Uživatelský profil nebyl nalezen.";

function getSafeRole(value: unknown): "admin" | "participant" {
  if (value === "admin") {
    return "admin";
  }

  return "participant";
}

function redirectToLoginWithMessage(message: string) {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem("dm-auth-message", message);
    window.location.replace("/login");
  }
}

function getAuthErrorMessage(error: unknown) {
  if (typeof error === "object" && error && "code" in error && typeof (error as { code?: string }).code === "string") {
    const code = (error as { code: string }).code;

    if (code === "auth/invalid-email") {
      return "Zadejte platný e-mail.";
    }

    if (code === "auth/user-not-found" || code === "auth/wrong-password") {
      return "Neplatný e-mail nebo heslo.";
    }

    if (code === "auth/email-already-in-use") {
      return "Tento e-mail je již použitý.";
    }

    if (code === "auth/weak-password") {
      return "Heslo je příliš slabé. Zvolte alespoň 6 znaků.";
    }

    if (code === "auth/too-many-requests") {
      return "Příliš mnoho pokusů o přihlášení. Zkuste to později.";
    }
  }

  return "Operace se nezdařila. Zkuste to znovu.";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isRegisteringRef = useRef(false);
  const profileLoadSequenceRef = useRef(0);
  const redirectIssuedRef = useRef(false);

  useEffect(() => {
    let isMounted = true;
    let unsubscribeAuthListener: (() => void) | undefined;

    async function loadProfile(
      nextUser: User,
      requestId: number,
      client: Awaited<ReturnType<typeof getFirebaseClient>>,
    ) {
      const { db, firestoreApi } = client;
      let timeoutId: number | undefined;

      try {
        const profileRef = firestoreApi.doc(db, "users", nextUser.uid);
        const profileSnapshotPromise = firestoreApi.getDoc(profileRef);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error("PROFILE_LOAD_TIMEOUT"));
          }, 10000);
        });

        const profileSnapshot = await Promise.race([profileSnapshotPromise, timeoutPromise]);

        if (!isMounted || profileLoadSequenceRef.current !== requestId) {
          return;
        }

        if (!profileSnapshot.exists()) {
          if (isRegisteringRef.current) {
            return;
          }

          setProfile(null);
          setError(PROFILE_MISSING_MESSAGE);

          if (!redirectIssuedRef.current) {
            redirectIssuedRef.current = true;
            redirectToLoginWithMessage(PROFILE_MISSING_MESSAGE);
          }

          return;
        }

        const profileData = profileSnapshot.data() as Partial<UserProfile>;
        const resolvedDisplayName = profileData.displayName?.trim() || nextUser.displayName || nextUser.email || "Uživatel";
        const resolvedEmail = profileData.email?.trim() || nextUser.email || "";

        setProfile({
          uid: nextUser.uid,
          displayName: resolvedDisplayName,
          email: resolvedEmail,
          role: getSafeRole(profileData.role),
          createdAt: profileData.createdAt,
          updatedAt: profileData.updatedAt,
        });
      } catch (profileError) {
        if (!isMounted || profileLoadSequenceRef.current !== requestId) {
          return;
        }

        const isTimeout = profileError instanceof Error && profileError.message === "PROFILE_LOAD_TIMEOUT";

        if (isRegisteringRef.current) {
          return;
        }

        if (isTimeout) {
          setError("Načtení profilu trvá příliš dlouho. Zkuste to prosím znovu.");
        } else {
          console.error("PROFILE LOAD ERROR", profileError);
          setError("Nepodařilo se načíst uživatelský profil.");
        }

        setProfile(null);

        if (!redirectIssuedRef.current) {
          redirectIssuedRef.current = true;
          redirectToLoginWithMessage(isTimeout ? "Načtení profilu trvá příliš dlouho. Zkuste to prosím znovu." : "Nepodařilo se načíst uživatelský profil.");
        }
      } finally {
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId);
        }

        if (isMounted && profileLoadSequenceRef.current === requestId) {
          setLoading(false);
        }
      }
    }

    async function initializeAuth() {
      try {
        const client = await getFirebaseClient();
        const { auth, authApi } = client;

        if (!isMounted) {
          return;
        }

        unsubscribeAuthListener = authApi.onAuthStateChanged(auth, (nextUser) => {
          if (!isMounted) {
            return;
          }

          setUser(nextUser);
          profileLoadSequenceRef.current += 1;
          const requestId = profileLoadSequenceRef.current;

          if (!nextUser) {
            setProfile(null);
            setError(null);
            setLoading(false);
            return;
          }

          redirectIssuedRef.current = false;
          setError(null);
          setLoading(true);

          void loadProfile(nextUser, requestId, client);
        });
      } catch (initializationError) {
        console.error("FIREBASE AUTH INIT ERROR", initializationError);

        if (isMounted) {
          setUser(null);
          setProfile(null);
          setError("Nepodařilo se inicializovat přihlášení.");
          setLoading(false);
        }
      }
    }

    void initializeAuth();

    return () => {
      isMounted = false;
      unsubscribeAuthListener?.();
    };
  }, []);

  async function signIn(email: string, password: string) {
    setError(null);

    try {
      const { auth, authApi } = await getFirebaseClient();
      await authApi.signInWithEmailAndPassword(auth, email, password);
      return true;
    } catch (signInError) {
      const message = getAuthErrorMessage(signInError);
      setError(message);
      return false;
    }
  }

  async function signUp(email: string, password: string, displayName: string) {
    setError(null);
    isRegisteringRef.current = true;

    let credentials: { user: User };
    const trimmedEmail = email.trim();
    const trimmedDisplayName = displayName.trim();

    try {
      const { auth, authApi } = await getFirebaseClient();
      credentials = await authApi.createUserWithEmailAndPassword(auth, trimmedEmail, password);
    } catch (signUpError) {
      const message = getAuthErrorMessage(signUpError);
      setError(message);
      isRegisteringRef.current = false;
      return false;
    }

    const nextDisplayName = trimmedDisplayName || credentials.user.email?.split("@")[0] || "Uživatel";

    try {
      const { auth, db, authApi, firestoreApi } = await getFirebaseClient();

      await authApi.updateProfile(credentials.user, {
        displayName: nextDisplayName,
      });

      await firestoreApi.setDoc(firestoreApi.doc(db, "users", credentials.user.uid), {
        uid: credentials.user.uid,
        displayName: nextDisplayName,
        email: credentials.user.email ?? trimmedEmail,
        role: "participant",
        createdAt: firestoreApi.serverTimestamp(),
        updatedAt: firestoreApi.serverTimestamp(),
      });

      const profileSnapshot = await firestoreApi.getDoc(firestoreApi.doc(db, "users", credentials.user.uid));
      if (!profileSnapshot.exists()) {
        setError("Účet byl vytvořen, ale uživatelský profil se nepodařilo uložit.");
        await authApi.signOut(auth);
        isRegisteringRef.current = false;
        return false;
      }

      isRegisteringRef.current = false;

      return true;
    } catch (profileError) {
      console.error("CREATE USER PROFILE ERROR", profileError);
      setError("Účet byl vytvořen, ale uživatelský profil se nepodařilo uložit.");
      const { auth, authApi } = await getFirebaseClient();
      await authApi.signOut(auth);
      isRegisteringRef.current = false;
      return false;
    }
  }

  async function signOut() {
    setError(null);
    const { auth, authApi } = await getFirebaseClient();
    await authApi.signOut(auth);
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      loading,
      error,
      isAdmin: profile?.role === "admin",
      signIn,
      signUp,
      signOut,
      clearError: () => setError(null),
    }),
    [user, profile, loading, error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return context;
}
