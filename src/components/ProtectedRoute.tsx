"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, profile, loading, isAdmin, signOut } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, router, user]);

  useEffect(() => {
    if (!loading && user && !isAdmin) {
      router.replace("/join");
    }
  }, [isAdmin, loading, profile, router, user]);

  async function handleLogout() {
    await signOut();
    router.replace("/login");
  }

  if (!loading && user && !isAdmin) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-6 py-16">
          <div className="w-full rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 text-center shadow-2xl shadow-slate-950/60">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Přístup odepřen</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">Tato stránka je pouze pro administrátory.</h1>
            <p className="mt-3 text-sm text-slate-400">Přesměrovávám vás na připojení k draftu.</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/join"
                className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-2 text-sm font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20"
              >
                Přejít na připojení k draftu
              </Link>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                Odhlásit se
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-6 py-16">
          <div className="w-full rounded-[32px] border border-slate-800 bg-slate-900/90 p-8 text-center shadow-2xl shadow-slate-950/60">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Přihlášení</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">Kontroluji přihlášení...</h1>
            <p className="mt-3 text-sm text-slate-400">Chráněný obsah se zobrazí až po ověření.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (!profile) {
    return null;
  }

  if (!isAdmin) {
    return null;
  }

  return <>{children}</>;
}
