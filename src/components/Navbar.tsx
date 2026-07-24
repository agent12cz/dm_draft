import Link from "next/link";

export function Navbar() {
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
          <Link href="/draft/join" className="transition hover:text-white">
            Připojit se
          </Link>
        </nav>
      </div>
    </header>
  );
}
