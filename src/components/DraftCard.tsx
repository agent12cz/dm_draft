import Link from "next/link";

type DraftCardProps = {
  title: string;
  typeLabel?: string;
  status?: "Čeká na hráče" | "Probíhá" | "Dokončen";
  code: string;
  href?: string;
};

const statusStyles = {
  "Čeká na hráče": "border-[#18C964]/20 bg-[#18C964]/10 text-[#8ef0b5]",
  Probíhá: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  Dokončen: "border-slate-500/20 bg-slate-500/10 text-slate-300",
};

export function DraftCard({
  title,
  typeLabel = "NHL Draft",
  status = "Čeká na hráče",
  code,
  href = "/draft/lobby",
}: DraftCardProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_80px_rgba(2,6,23,0.4)] backdrop-blur-xl">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-sm font-medium uppercase tracking-[0.24em] text-slate-500">
            {typeLabel}
          </p>
          <h3 className="text-xl font-semibold text-white">{title}</h3>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusStyles[status]}`}>
          {status}
        </span>
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-slate-800 pt-4">
        <div>
          <p className="text-sm text-slate-400">Kód draftu</p>
          <p className="mt-1 font-mono text-sm font-semibold tracking-[0.24em] text-[#18C964]">
            {code}
          </p>
        </div>

        <Link
          href={href}
          className="inline-flex items-center justify-center rounded-2xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#13b15a]"
        >
          Otevřít
        </Link>
      </div>
    </div>
  );
}
