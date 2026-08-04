"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { PrimaryButton } from "@/components/PrimaryButton";
import AuthGuard from "@/app/auth-guard";

function DraftLobbyContent() {
  const searchParams = useSearchParams();
  const draftName = searchParams.get("name") ?? "Nový draft";
  const playerCount = searchParams.get("players") ?? "16";
  const teamsPerPlayer = searchParams.get("teams") ?? "2";
  const timeLimit = searchParams.get("time") ?? "30";
  const draftCode = "DRAFT-" + (searchParams.get("name") ?? "ROOM").slice(0, 4).toUpperCase();

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(24,201,100,0.2),_transparent_35%),linear-gradient(135deg,_#020617_0%,_#0f172a_60%,_#111827_100%)] text-slate-100">
      <Navbar />
      <PageContainer>
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <Card className="space-y-6">
            <div className="space-y-3">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
                Lobby draftu
              </p>
              <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                {draftName}
              </h1>
              <p className="text-lg text-slate-400">
                Připravte se na živé losování NHL týmů s rychlým průběhem a jasným rozhraním.
              </p>
            </div>

            <div className="rounded-[24px] border border-[#18C964]/20 bg-[#18C964]/10 p-4">
              <p className="text-sm text-slate-400">Kód draftu</p>
              <p className="mt-2 text-3xl font-semibold tracking-[0.3em] text-[#18C964]">
                {draftCode}
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-white">Připojení hráči</h2>
                <span className="text-sm text-slate-400">1 / {playerCount}</span>
              </div>
              <div className="rounded-[20px] border border-white/10 bg-slate-950/60 p-4">
                <div className="flex items-center justify-between rounded-[16px] border border-[#18C964]/20 bg-[#18C964]/10 px-4 py-3">
                  <div>
                    <p className="font-semibold text-white">Host</p>
                    <p className="text-sm text-slate-400">Vlastník draftu</p>
                  </div>
                  <span className="rounded-full border border-[#18C964]/30 bg-[#18C964]/20 px-3 py-1 text-sm text-[#8ef0b5]">
                    Online
                  </span>
                </div>
              </div>
            </div>
          </Card>

          <Card className="space-y-6">
            <div className="space-y-2">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-slate-500">
                Nastavení draftu
              </p>
              <h2 className="text-2xl font-semibold text-white">Přehled</h2>
            </div>

            <div className="grid gap-3">
              <div className="rounded-[20px] border border-white/10 bg-slate-950/60 p-4">
                <p className="text-sm text-slate-400">Počet hráčů</p>
                <p className="mt-2 text-xl font-semibold text-white">{playerCount}</p>
              </div>
              <div className="rounded-[20px] border border-white/10 bg-slate-950/60 p-4">
                <p className="text-sm text-slate-400">Počet týmů na hráče</p>
                <p className="mt-2 text-xl font-semibold text-white">{teamsPerPlayer}</p>
              </div>
              <div className="rounded-[20px] border border-white/10 bg-slate-950/60 p-4">
                <p className="text-sm text-slate-400">Čas na výběr</p>
                <p className="mt-2 text-xl font-semibold text-white">{timeLimit}s</p>
              </div>
            </div>

            <PrimaryButton href="/">Spustit losování</PrimaryButton>
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}

export default function DraftLobbyPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<div className="min-h-screen bg-slate-950" />}> 
        <DraftLobbyContent />
      </Suspense>
    </AuthGuard>
  );
}
