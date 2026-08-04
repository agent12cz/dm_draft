"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { useAuth } from "@/components/AuthProvider";

export default function RegisterPage() {
  const router = useRouter();
  const { user, profile, loading, error, signUp, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    setFormError(null);

    const trimmedDisplayName = displayName.trim();
    const trimmedEmail = email.trim();

    if (!trimmedDisplayName) {
      setFormError("Zadejte zobrazované jméno.");
      return;
    }

    if (!trimmedEmail) {
      setFormError("Zadejte e-mail.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setFormError("Zadejte platný e-mail.");
      return;
    }

    if (password.length < 6) {
      setFormError("Heslo musí mít alespoň 6 znaků.");
      return;
    }

    if (password !== confirmPassword) {
      setFormError("Hesla se neshodují.");
      return;
    }

    setIsSubmitting(true);

    const success = await signUp(trimmedEmail, password, trimmedDisplayName);
    if (success) {
      router.replace("/join");
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
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Registrace</p>
              <h1 className="text-3xl font-semibold tracking-tight text-white">Načítám...</h1>
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
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Registrace</p>
              <h1 className="text-3xl font-semibold tracking-tight text-white">Vytvořit účet účastníka</h1>
              <p className="text-sm text-slate-400">Po registraci se budete moci přihlásit do draftu pomocí kódu a vybrat tým ve svém tahu.</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="grid gap-2 text-sm font-medium text-slate-300">
                Zobrazované jméno
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Martin Nový"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-300">
                E-mail
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="player@example.com"
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
                  autoComplete="new-password"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-300">
                Potvrzení hesla
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              {(formError || error) ? (
                <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {formError ?? error}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-2xl bg-[#18C964] px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? "Vytvářím účet..." : "Vytvořit účet"}
              </button>
            </form>

            <div className="flex items-center justify-between text-sm">
              <Link href="/login" className="text-[#8ef0b5] transition hover:text-[#18C964]">
                Máte už účet? Přihlaste se
              </Link>
              <Link href="/" className="text-slate-400 transition hover:text-slate-200">
                Zpět na dashboard
              </Link>
            </div>
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}
