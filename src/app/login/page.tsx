"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { useAuth } from "@/components/AuthProvider";

export default function LoginPage() {
  const router = useRouter();
  const { user, profile, loading, error, signIn, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    const storedMessage = window.sessionStorage.getItem("dm-auth-message");
    if (storedMessage) {
      window.sessionStorage.removeItem("dm-auth-message");
    }

    return storedMessage;
  });

  useEffect(() => {
    if (loading || !user) {
      return;
    }

    if (!profile) {
      return;
    }

    if (profile?.role === "admin") {
      router.replace("/");
      return;
    }

    router.replace("/join");
  }, [loading, profile?.role, router, user]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    clearError();
    setIsSubmitting(true);

    const success = await signIn(email.trim(), password);
    if (success) {
      setAuthMessage(null);
    }

    setIsSubmitting(false);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Navbar />
        <PageContainer className="py-8 lg:py-10">
          <div className="mx-auto flex max-w-lg flex-col gap-6">
            <Card className="space-y-4">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Přihlášení</p>
              <h1 className="text-3xl font-semibold tracking-tight text-white">Načítám...</h1>
              <p className="text-sm text-slate-400">Kontroluji stav přihlášení.</p>
            </Card>
          </div>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto flex max-w-lg flex-col gap-6">
          <Card className="space-y-6">
            <div className="space-y-3">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Administrace</p>
              <h1 className="text-3xl font-semibold tracking-tight text-white">Přihlásit se</h1>
              <p className="text-sm text-slate-400">Přihlaste se pomocí e-mailu a hesla vytvořeného v Firebase Console.</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="grid gap-2 text-sm font-medium text-slate-300">
                E-mail
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="admin@example.com"
                  autoComplete="email"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-300">
                Heslo
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              {(authMessage || error) ? (
                <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {authMessage ?? error}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-2xl bg-[#18C964] px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? "Přihlašuji..." : "Přihlásit se"}
              </button>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-400">
              <p>Ještě nemáte účet? Vytvořte si účastnický účet pro přístup do draftu.</p>
              <Link href="/register" className="font-semibold text-[#8ef0b5] transition hover:text-[#18C964]">
                Nemáte účet? Zaregistrujte se
              </Link>
            </div>

            <Link href="/" className="inline-flex text-sm text-[#8ef0b5] transition hover:text-[#18C964]">
              Zpět na dashboard
            </Link>
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}
