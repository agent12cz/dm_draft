"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";

export function Navbar() {
  const router = useRouter();
  const { user, profile, loading, isAdmin, signOut } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleLogout() {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      await signOut();
      router.replace("/login");
    } catch (error) {
      console.error("NAVBAR SIGN OUT ERROR", error);
      setLogoutError("Nepodařilo se odhlásit. Zkuste to znovu.");
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3 lg:px-8">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/logos/nhl/group_breaks.png"
            alt="Group Breaks Hockey Cards"
            width={1955}
            height={1827}
            className="h-12 w-auto shrink-0 object-contain"
          />
          <div>
            <p className="text-sm font-semibold tracking-[0.2em] text-slate-300 uppercase">
              DM Draft
            </p>
            <p className="text-xs text-slate-500">Kreativní workflow</p>
          </div>
        </Link>

        {!loading && user && isAdmin ? (
          <nav aria-label="Správa draftů" className="hidden items-center gap-6 text-sm text-slate-400 md:flex">
            <Link href="/" className="transition hover:text-white">
              Přehled
            </Link>
            <Link href="/draft/new" className="transition hover:text-white">
              Nový draft
            </Link>
            <Link href="/join" className="transition hover:text-white">
              Připojit se
            </Link>
            <Link href="/products" className="transition hover:text-white">
              Boxy
            </Link>
            <Link href="/rankings" className="transition hover:text-white">
              Žebříčky
            </Link>
          </nav>
        ) : null}
        <NavbarAccountMenu
          loading={loading}
          userLabel={user
            ? profile?.displayName?.trim() || user.displayName?.trim() || user.email || "Uživatel"
            : null}
          isLoggingOut={isLoggingOut}
          logoutError={logoutError}
          onLogout={() => void handleLogout()}
        />
      </div>
    </header>
  );
}

export function NavbarAccountMenu({
  loading,
  userLabel,
  isLoggingOut,
  logoutError,
  onLogout,
}: {
  loading: boolean;
  userLabel: string | null;
  isLoggingOut: boolean;
  logoutError: string | null;
  onLogout: () => void;
}) {
  return (
    <nav aria-label="Uživatelský účet" className="flex min-w-0 flex-wrap items-center gap-2 text-sm md:gap-3">
      {loading ? (
        <span role="status" className="text-xs text-slate-400">Načítám přihlášení…</span>
      ) : userLabel !== null ? (
        <>
          <span title={userLabel} className="max-w-40 truncate font-semibold text-slate-200 lg:max-w-48">
            {userLabel}
          </span>
          <button
            type="button"
            onClick={onLogout}
            disabled={isLoggingOut}
            className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60"
          >
            {isLoggingOut ? "Odhlašuji…" : "Odhlásit se"}
          </button>
        </>
      ) : (
        <>
          <Link
            href="/register"
            className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            Registrovat
          </Link>
          <Link
            href="/login"
            className="rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1.5 font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20"
          >
            Přihlásit
          </Link>
        </>
      )}
      {logoutError ? <p role="alert" className="w-full text-xs text-red-300">{logoutError}</p> : null}
    </nav>
  );
}
