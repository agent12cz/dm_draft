import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { PrimaryButton } from "@/components/PrimaryButton";

const activeDrafts = ["GB1", "GB2", "GB3"];

export default function Home() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(24,201,100,0.2),_transparent_35%),linear-gradient(135deg,_#020617_0%,_#0f172a_60%,_#111827_100%)] text-slate-100">
      <Navbar />
      <PageContainer className="justify-center">
        <div className="grid items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="space-y-8">
            <div className="space-y-4">
              <div className="inline-flex items-center rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1 text-sm font-medium text-[#8ef0b5]">
                NHL draftovací platforma
              </div>
              <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-white sm:text-6xl">
                DM Draft
              </h1>
              <p className="max-w-2xl text-xl leading-8 text-slate-300">
                Nejmodernější systém pro draftování NHL týmů.
              </p>
            </div>

            <div className="flex flex-wrap gap-4">
              <PrimaryButton href="/draft/new">Vytvořit draft</PrimaryButton>
              <Link
                href="/draft/join"
                className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-slate-200 transition-all duration-200 hover:-translate-y-0.5 hover:border-[#18C964]/30 hover:bg-[#18C964]/10"
              >
                Připojit se
              </Link>
            </div>
          </section>

          <Card className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.28em] text-slate-500">
                  Aktivní drafty
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Přehled</h2>
              </div>
              <div className="rounded-2xl border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-2 text-sm font-semibold text-[#8ef0b5]">
                Live
              </div>
            </div>

            <div className="space-y-3">
              {activeDrafts.map((draft) => (
                <div
                  key={draft}
                  className="flex items-center justify-between rounded-[20px] border border-white/10 bg-slate-950/60 px-4 py-3"
                >
                  <span className="text-base font-medium text-white">{draft}</span>
                  <span className="text-sm text-slate-400">Připraveno</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}
