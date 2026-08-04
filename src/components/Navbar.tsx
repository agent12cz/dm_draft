"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";

export function Navbar() {
  const router = useRouter();
  const { user, signOut } = useAuth();

  async function handleLogout() {
    await signOut();
    router.replace("/login");
  }

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-8">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#18C964] text-lg font-semibold text-slate-950 shadow-lg shadow-[#18C964]/20">
            D
          </div>
          <div>
            <p className="text-sm font-semibold tracking-[0.2em] text-slate-300 uppercase">
              DM Draft
            </p>
            <p className="text-xs text-slate-500">Kreativní workflow</p>
          </div>
        </Link>

        <nav className="hidden items-center gap-6 text-sm text-slate-400 md:flex">
          <Link href="/" className="transition hover:text-white">
            Přehled
          </Link>
          <Link href="/draft/new" className="transition hover:text-white">
            Nový draft
          </Link>
          <Link href="/join" className="transition hover:text-white">
            Připojit se
          </Link>
          <Link href="/register" className="transition hover:text-white">
            Registrace
          </Link>
          <Link href="/products" className="transition hover:text-white">
            Boxy
          </Link>
          {user ? (
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              Odhlásit se
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <Link href="/register" className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 font-semibold text-slate-200 transition hover:bg-slate-800">
                Registrovat
              </Link>
              <Link href="/login" className="rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1.5 font-semibold text-[#8ef0b5] transition hover:bg-[#18C964]/20">
                Přihlásit se
              </Link>
            </div>
          )}
        </nav>
      </div>
    </header>
  );
}
