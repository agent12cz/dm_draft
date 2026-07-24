import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { PrimaryButton } from "@/components/PrimaryButton";

export default function NewDraftPage() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(24,201,100,0.2),_transparent_35%),linear-gradient(135deg,_#020617_0%,_#0f172a_60%,_#111827_100%)] text-slate-100">
      <Navbar />
      <PageContainer>
        <div className="flex flex-1 flex-col justify-center">
          <Card className="mx-auto w-full max-w-3xl">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl space-y-4">
                <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
                  Vytvořit draft
                </p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  Založte nový draft a začněte rychle.
                </h1>
                <p className="text-lg leading-8 text-slate-400">
                  Tato stránka je připravena pro další rozšíření. Pro tuto první verzi je klíčový čistý a moderní vzhled.
                </p>
              </div>
              <PrimaryButton href="/">Zpět na dashboard</PrimaryButton>
            </div>
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}
