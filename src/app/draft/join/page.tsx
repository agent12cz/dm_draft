"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import { useAuth } from "@/components/AuthProvider";

function JoinDraftPageContent() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [draftCode, setDraftCode] = useState("");
  const [verifiedCode, setVerifiedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const normalizedCode = draftCode.trim().toUpperCase();

    if (!normalizedCode) {
      setError("Zadejte prosím kód draftu.");
      setIsSubmitting(false);
      return;
    }

    if (!user) {
      setError("Přihlaste se, abyste mohli vstoupit do draftu.");
      setIsSubmitting(false);
      return;
    }

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      const draftRef = await firestoreApi.getDoc(firestoreApi.doc(db, "drafts", normalizedCode));

      if (!draftRef.exists()) {
        setVerifiedCode(null);
        setError("Draft s tímto kódem nebyl nalezen.");
        return;
      }

      const draftData = draftRef.data();
      const participants = (draftData.participants ?? []) as Array<{ userId?: string }>;
      const isParticipant = participants.some((participant) => participant.userId === user.uid);

      if (!isParticipant) {
        setVerifiedCode(null);
        setError("Nejste účastníkem tohoto draftu.");
        return;
      }

      setVerifiedCode(normalizedCode);
      setError(null);
    } catch {
      setError("Draft s tímto kódem nebyl nalezen.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(24,201,100,0.2),_transparent_35%),linear-gradient(135deg,_#020617_0%,_#0f172a_60%,_#111827_100%)] text-slate-100">
        <Navbar />
        <PageContainer>
          <div className="flex flex-1 flex-col justify-center">
            <Card className="mx-auto w-full max-w-3xl">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Připojit se ke draftu</p>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">Načítám...</h1>
            </Card>
          </div>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(24,201,100,0.2),_transparent_35%),linear-gradient(135deg,_#020617_0%,_#0f172a_60%,_#111827_100%)] text-slate-100">
      <Navbar />
      <PageContainer>
        <div className="flex flex-1 flex-col justify-center">
          <Card className="mx-auto w-full max-w-3xl">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl space-y-4">
                <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
                  Připojit se ke draftu
                </p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  Zadejte kód draftu a vstupte do hráčského režimu.
                </h1>
                <p className="text-lg leading-8 text-slate-400">
                  Po přihlášení a ověření účasti v draftu vás systém přesměruje přímo do hráčského režimu.
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-8 space-y-4">
              <label className="grid gap-2 text-sm font-medium text-slate-300">
                Kód draftu
                <input
                  value={draftCode}
                  onChange={(event) => setDraftCode(event.target.value)}
                  placeholder="ABC123"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              {error ? (
                <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-2xl bg-[#18C964] px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? "Ověřuji..." : "Pokračovat"}
              </button>
            </form>

            {verifiedCode ? (
              <div className="mt-6 rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 p-5">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#8ef0b5]">
                  Draft byl nalezen
                </p>
                <p className="mt-3 text-lg font-semibold text-white">
                  Jak chcete pokračovat?
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => router.push(`/view/${verifiedCode}`)}
                    className="rounded-2xl border border-[#18C964]/20 bg-slate-950/80 px-4 py-3 text-sm font-semibold text-[#8ef0b5] transition hover:bg-slate-900"
                  >
                    Sledovat draft
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push(`/play/${verifiedCode}`)}
                    className="rounded-2xl bg-[#18C964] px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a]"
                  >
                    Otevřít hráčský režim
                  </button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}

export default function JoinDraftPage() {
  return <JoinDraftPageContent />;
}
