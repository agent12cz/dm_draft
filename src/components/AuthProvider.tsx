"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

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

  useEffect(() => {
    let isMounted = true;

    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      if (!isMounted) {
        return;
      }

      setLoading(true);
      setUser(nextUser);
      setError(null);

      if (!nextUser) {
        setProfile(null);
        setLoading(false);
        return;
      }

      try {
        const profileRef = doc(db, "users", nextUser.uid);
        const profileSnapshot = await getDoc(profileRef);

        if (!profileSnapshot.exists()) {
          if (isRegisteringRef.current) {
            setLoading(false);
            return;
          }

          setProfile(null);
          setError(PROFILE_MISSING_MESSAGE);
          await firebaseSignOut(auth);
          redirectToLoginWithMessage(PROFILE_MISSING_MESSAGE);
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
        console.error(profileError);
        setProfile(null);
        setError("Nepodařilo se načíst uživatelský profil.");
        await firebaseSignOut(auth);
        redirectToLoginWithMessage("Nepodařilo se načíst uživatelský profil.");
        return;
      }

      setLoading(false);
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  async function signIn(email: string, password: string) {
    setError(null);

    try {
      await signInWithEmailAndPassword(auth, email, password);
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

    let credentials: Awaited<ReturnType<typeof createUserWithEmailAndPassword>>;
    const trimmedEmail = email.trim();
    const trimmedDisplayName = displayName.trim();

    try {
      credentials = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
    } catch (signUpError) {
      const message = getAuthErrorMessage(signUpError);
      setError(message);
      isRegisteringRef.current = false;
      return false;
    }

    const nextDisplayName = trimmedDisplayName || credentials.user.email?.split("@")[0] || "Uživatel";

    try {
      await updateProfile(credentials.user, {
        displayName: nextDisplayName,
      });

      await setDoc(doc(db, "users", credentials.user.uid), {
        uid: credentials.user.uid,
        displayName: nextDisplayName,
        email: credentials.user.email ?? trimmedEmail,
        role: "participant",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const profileSnapshot = await getDoc(doc(db, "users", credentials.user.uid));
      if (!profileSnapshot.exists()) {
        setError("Účet byl vytvořen, ale uživatelský profil se nepodařilo uložit.");
        await firebaseSignOut(auth);
        isRegisteringRef.current = false;
        return false;
      }

      isRegisteringRef.current = false;

      return true;
    } catch (profileError) {
      console.error("CREATE USER PROFILE ERROR", profileError);
      const errorCode = typeof profileError === "object" && profileError && "code" in profileError
        ? String((profileError as { code?: unknown }).code ?? "unknown")
        : "unknown";
      const errorMessage = typeof profileError === "object" && profileError && "message" in profileError
        ? String((profileError as { message?: unknown }).message ?? "")
        : "Neznámá chyba";
      setError(`${errorCode} – ${errorMessage}`);
      await firebaseSignOut(auth);
      isRegisteringRef.current = false;
      return false;
    }
  }

  async function signOut() {
    setError(null);
    await firebaseSignOut(auth);
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
