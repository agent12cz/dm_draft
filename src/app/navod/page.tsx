import type { Metadata } from "next";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";

export const metadata: Metadata = {
  title: "Jak hrát – DM Draft",
  description: "Kompletní návod pro hráče DM Draftu: registrace, pozvánky, priority týmů, průběh Snake draftu i automatický výběr.",
};

const chapters = [
  { id: "co-je-dm-draft", title: "Co je DM Draft" },
  { id: "registrace-a-prihlaseni", title: "Registrace a přihlášení" },
  { id: "pripojeni", title: "Připojení pozvánkou nebo kódem" },
  { id: "mistnost", title: "Orientace v draftovací místnosti" },
  { id: "priority", title: "Nastavení priorit týmů" },
  { id: "prubeh", title: "Průběh draftu a časový limit" },
  { id: "snake", title: "Princip Snake draftu" },
  { id: "autopick", title: "Automatický výběr" },
  { id: "chat", title: "Chat a sledování průběhu" },
  { id: "odpojeni", title: "Odpojení a opětovné připojení" },
  { id: "dokonceni", title: "Dokončení draftu a výsledky" },
] as const;

function ChapterCard({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <Card className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-white">{title}</h2>
        <div className="space-y-3 text-sm leading-relaxed text-slate-300 sm:text-base">
          {children}
        </div>
      </Card>
    </section>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[20px] border border-[#18C964]/20 bg-[#18C964]/10 p-4 text-sm text-slate-200">
      {children}
    </div>
  );
}

export default function HowToPlayPage() {
  return (
    <div className="min-h-screen text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto w-full max-w-4xl space-y-6">
          <Card className="space-y-4">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
              Návod pro hráče
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Jak hrát DM Draft
            </h1>
            <p className="text-lg text-slate-400">
              Vše, co potřebujete vědět od prvního přihlášení až po dokončený draft.
              Návod můžete mít otevřený kdykoliv — jeho čtení vás neodhlásí,
              nesmaže vám nastavené priority ani nepřeruší probíhající draft.
            </p>
            <nav aria-label="Obsah návodu" className="flex flex-wrap gap-2">
              {chapters.map((chapter, index) => (
                <a
                  key={chapter.id}
                  href={`#${chapter.id}`}
                  className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-white sm:text-sm"
                >
                  {index + 1}. {chapter.title}
                </a>
              ))}
            </nav>
          </Card>

          <ChapterCard id="co-je-dm-draft" title="1. Co je DM Draft">
            <p>
              DM Draft je online losování sportovních týmů mezi hráče. Organizátor
              připraví draft nad boxem sběratelských karet (NHL, NBA, NFL nebo MLB)
              a hráči si postupně rozeberou <strong>všechny týmy dané ligy</strong>.
              Každému hráči pak patří karty týmů, které si v draftu vybral.
            </p>
            <p>
              Výběr probíhá živě: všichni vidí v reálném čase, kdo je na tahu, které
              týmy jsou ještě volné a jak draft postupuje. Pořadí výběru se „hadovitě“
              otáčí (tzv. Snake draft — viz{" "}
              <a href="#snake" className="text-[#8ef0b5] underline-offset-2 hover:underline">kapitola 7</a>),
              takže je férové pro všechny pozice.
            </p>
            <Hint>
              💡 Probíhající drafty může kdokoliv — i bez přihlášení — sledovat jako
              divák na adrese <code className="text-[#8ef0b5]">/view/KÓD-DRAFTU</code>.
            </Hint>
          </ChapterCard>

          <ChapterCard id="registrace-a-prihlaseni" title="2. Registrace a přihlášení">
            <p>
              Pro hraní potřebujete bezplatný účet. Na stránce{" "}
              <Link href="/register" className="text-[#8ef0b5] underline-offset-2 hover:underline">Registrovat</Link>{" "}
              vyplňte své zobrazované jméno, e-mail a heslo. Pod zvoleným jménem vás
              uvidí ostatní hráči v místnosti i v chatu.
            </p>
            <p>
              Pokud už účet máte, stačí se{" "}
              <Link href="/login" className="text-[#8ef0b5] underline-offset-2 hover:underline">Přihlásit</Link>.
              Přihlášení zůstává uložené v prohlížeči — při příští návštěvě se
              nemusíte přihlašovat znovu.
            </p>
            <Hint>
              💡 Když otevřete osobní pozvánku dříve, než se přihlásíte, aplikace si
              ji zapamatuje a po přihlášení či registraci vás k ní automaticky vrátí.
            </Hint>
          </ChapterCard>

          <ChapterCard id="pripojeni" title="3. Připojení osobní pozvánkou nebo kódem">
            <p>Do draftu se dostanete třemi způsoby:</p>
            <ul className="list-inside list-disc space-y-2">
              <li>
                <strong>Osobní pozvánkou</strong> — organizátor vám pošle odkaz ve tvaru{" "}
                <code className="text-[#8ef0b5]">…/invite#…</code>. Po otevření uvidíte
                název draftu a pozice, které jsou pro vás připravené. Přihlaste se
                (nebo si vytvořte účet) a klikněte na{" "}
                <strong>„Potvrdit převzetí pozic“</strong>. Pozvánka je jednorázová —
                po převzetí je navždy spojená s vaším účtem a nikdo jiný ji už použít nemůže.
              </li>
              <li>
                <strong>Kódem draftu</strong> — na stránce{" "}
                <Link href="/join" className="text-[#8ef0b5] underline-offset-2 hover:underline">Připojit se</Link>{" "}
                zadejte kód, který vám organizátor sdělil (např.{" "}
                <code className="text-[#8ef0b5]">HM85L</code>). Funguje, pokud už
                v draftu máte přiřazenou pozici.
              </li>
              <li>
                <strong>Volnou pozicí</strong> — pokud má čekající draft volná místa,
                můžete se na stránce draftu připojit tlačítkem{" "}
                <strong>„Připojit se k draftu“</strong> a obsadit první volnou pozici.
              </li>
            </ul>
            <p>
              Po úspěšném připojení vás aplikace přesměruje přímo do hráčské místnosti.
            </p>
          </ChapterCard>

          <ChapterCard id="mistnost" title="4. Orientace v draftovací místnosti">
            <p>
              Hráčská místnost je na adrese <code className="text-[#8ef0b5]">/play/KÓD-DRAFTU</code>.
              Vše v ní se aktualizuje samo v reálném čase — stránku nemusíte obnovovat.
            </p>
            <ul className="list-inside list-disc space-y-2">
              <li><strong>Horní panel</strong> — stav draftu, kdo je právě na tahu a odpočet času.</li>
              <li><strong>Týmy</strong> — nabídka všech týmů; u volných týmů se během vašeho tahu objeví tlačítko „Vybrat“.</li>
              <li><strong>Priority</strong> — vaše soukromé pořadí týmů pro automatický výběr (kapitola 5).</li>
              <li><strong>Žebříček</strong> — pořadí týmů podle organizátora.</li>
              <li><strong>Moje týmy</strong> — týmy, které jste už získali.</li>
              <li><strong>Účastníci</strong> — seznam hráčů a jejich dosavadní výběry.</li>
              <li><strong>Historie</strong> — kompletní průběh draftu, výběr po výběru.</li>
              <li><strong>Chat</strong> — komunikace s ostatními účastníky (kapitola 9).</li>
            </ul>
            <Hint>
              💡 Tlačítko <strong>„Jak hrát“</strong> v horní liště otevře tento návod
              v nové záložce, takže o dění v místnosti nepřijdete.
            </Hint>
          </ChapterCard>

          <ChapterCard id="priority" title="5. Nastavení priorit týmů">
            <p>
              V záložce <strong>Priority</strong> si seřaďte týmy podle toho, jak moc
              o ně stojíte — jednoduše je přetáhněte myší či prstem na požadovanou
              pozici a uložte. Pořadí můžete kdykoliv změnit, a to{" "}
              <strong>před zahájením i kdykoliv během draftu</strong>.
            </p>
            <p>
              Priority jsou <strong>soukromé</strong> — nevidí je ostatní hráči ani
              organizátor. Použijí se jen tehdy, když za vás vybírá automatika
              (kapitola 8): dostanete nejvýše postavený tým, který je ještě volný.
            </p>
            <Hint>
              💡 Doporučujeme nastavit priority hned po připojení. Pokud vám pak
              vyprší čas nebo vypadne internet, automatika vybere přesně podle
              vašeho přání.
            </Hint>
          </ChapterCard>

          <ChapterCard id="prubeh" title="6. Průběh draftu a časový limit">
            <p>Draft spouští organizátor. Co můžete dělat v jednotlivých fázích:</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] border-separate border-spacing-0 overflow-hidden rounded-[16px] border border-white/10 text-left text-sm">
                <thead className="bg-slate-950/60 text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Fáze</th>
                    <th className="px-4 py-2 font-semibold">Co může hráč dělat</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-white/10 bg-slate-950/30">
                    <td className="px-4 py-3 align-top font-semibold text-white">Před zahájením</td>
                    <td className="px-4 py-3">Připojit se, prohlédnout si týmy a žebříček, nastavit priority, psát do chatu a počkat, až organizátor draft spustí.</td>
                  </tr>
                  <tr className="border-t border-white/10">
                    <td className="px-4 py-3 align-top font-semibold text-white">Během vašeho tahu</td>
                    <td className="px-4 py-3">Kliknout na „Vybrat“ u kteréhokoliv volného týmu dříve, než vyprší časový limit. Vybraný tým se ihned přidá do „Moje týmy“.</td>
                  </tr>
                  <tr className="border-t border-white/10 bg-slate-950/30">
                    <td className="px-4 py-3 align-top font-semibold text-white">Mimo váš tah</td>
                    <td className="px-4 py-3">Sledovat výběry ostatních, upravovat své priority pro další kola, procházet historii a chatovat. Vybírat tým nelze — tlačítka jsou aktivní jen na tahu.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              <strong>Časový limit</strong> na jeden tah určuje organizátor (zobrazuje
              se v horním panelu; „∞“ znamená bez limitu). Odpočet vidí všichni;
              posledních 5 sekund se zvýrazní. Když čas vyprší, tah za vás dokončí
              automatický výběr — draft se tedy nikdy nezasekne.
            </p>
          </ChapterCard>

          <ChapterCard id="snake" title="7. Princip Snake draftu">
            <p>
              Pořadí hráčů se každé kolo otáčí jako had: v lichém kole se vybírá od
              prvního k poslednímu, v sudém od posledního k prvnímu. Kdo volí v prvním
              kole poslední, volí ve druhém kole první — žádná pozice není nevýhodná.
            </p>
            <p>Názorný příklad se čtyřmi hráči (Adam, Bára, Cyril, Dana) a dvěma koly:</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] border-separate border-spacing-0 overflow-hidden rounded-[16px] border border-white/10 text-left text-sm">
                <thead className="bg-slate-950/60 text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Výběr č.</th>
                    <th className="px-4 py-2 font-semibold">1</th>
                    <th className="px-4 py-2 font-semibold">2</th>
                    <th className="px-4 py-2 font-semibold">3</th>
                    <th className="px-4 py-2 font-semibold">4</th>
                    <th className="px-4 py-2 font-semibold">5</th>
                    <th className="px-4 py-2 font-semibold">6</th>
                    <th className="px-4 py-2 font-semibold">7</th>
                    <th className="px-4 py-2 font-semibold">8</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-white/10">
                    <td className="px-4 py-3 font-semibold text-white">Na tahu</td>
                    <td className="px-4 py-3">Adam</td>
                    <td className="px-4 py-3">Bára</td>
                    <td className="px-4 py-3">Cyril</td>
                    <td className="px-4 py-3">Dana</td>
                    <td className="px-4 py-3 text-[#8ef0b5]">Dana</td>
                    <td className="px-4 py-3 text-[#8ef0b5]">Cyril</td>
                    <td className="px-4 py-3 text-[#8ef0b5]">Bára</td>
                    <td className="px-4 py-3 text-[#8ef0b5]">Adam</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Dana tak vybírá dvakrát po sobě (4. a 5. výběr) a hadovité pořadí
              pokračuje, dokud nejsou rozebrané všechny týmy ligy.
            </p>
          </ChapterCard>

          <ChapterCard id="autopick" title="8. Automatický výběr">
            <p>
              Když hráči vyprší časový limit, systém za něj okamžitě vybere tým sám.
              Postupuje v tomto pořadí:
            </p>
            <ol className="list-inside list-decimal space-y-2">
              <li>
                <strong>Vaše priority</strong> — nejvýše postavený tým z vaší záložky
                Priority, který je ještě volný.
              </li>
              <li>
                <strong>Žebříček organizátora</strong> — pokud priority nemáte (nebo
                jsou všechny vaše preferované týmy už rozebrané), vybere se nejlepší
                volný tým podle žebříčku draftu.
              </li>
              <li>
                <strong>Pořadí nabídky</strong> — v krajním případě první volný tým v nabídce.
              </li>
            </ol>
            <p>
              Automatika běží na serveru — funguje, i když máte zavřený prohlížeč
              nebo vypadne internet. V historii je takový výběr označený jako
              automatický, takže vždy poznáte, jak tým získal majitele.
            </p>
          </ChapterCard>

          <ChapterCard id="chat" title="9. Chat a sledování průběhu">
            <p>
              Součástí místnosti je chat pro všechny účastníky draftu a organizátora
              (jeho zprávy nesou štítek <strong>Admin</strong>). Zpráva může mít až
              500 znaků a odešlete ji klávesou Enter.
            </p>
            <p>
              Průběh draftu může kdokoliv sledovat i jako <strong>divák</strong> na
              adrese <code className="text-[#8ef0b5]">/view/KÓD-DRAFTU</code> — bez
              přihlášení uvidí stav draftu, výběry hráčů i historii. Psát do chatu
              ani vybírat týmy diváci nemohou.
            </p>
          </ChapterCard>

          <ChapterCard id="odpojeni" title="10. Odpojení a opětovné připojení">
            <p>
              Celý stav draftu je uložený na serveru, takže{" "}
              <strong>zavřením stránky ani výpadkem internetu o nic nepřijdete</strong>{" "}
              — vaše pozice, získané týmy i uložené priority zůstávají.
            </p>
            <ul className="list-inside list-disc space-y-2">
              <li>Vraťte se stejným odkazem <code className="text-[#8ef0b5]">/play/KÓD-DRAFTU</code>, nebo</li>
              <li>použijte „Připojit se“ a zadejte kód draftu.</li>
            </ul>
            <p>
              Pokud jste byli offline během svého tahu a limit vypršel, tah za vás
              mezitím dokončil automatický výběr podle vašich priorit. Po návratu
              prostě pokračujete dál.
            </p>
          </ChapterCard>

          <ChapterCard id="dokonceni" title="11. Dokončení draftu a výsledky">
            <p>
              Draft končí ve chvíli, kdy jsou rozebrané všechny týmy ligy. Stav se
              změní na <strong>Dokončeno</strong> a výběry už nelze měnit.
            </p>
            <ul className="list-inside list-disc space-y-2">
              <li>V záložce <strong>Moje týmy</strong> najdete kompletní seznam svých týmů.</li>
              <li><strong>Účastníci</strong> ukazují rozdělení všech týmů mezi hráče.</li>
              <li><strong>Historie</strong> uchovává celý průběh výběr po výběru.</li>
            </ul>
            <p>
              Výsledky zůstávají dostupné i divákům na stránce{" "}
              <code className="text-[#8ef0b5]">/view/KÓD-DRAFTU</code>, dokud
              organizátor draft nesmaže. Hodně štěstí při dalším draftu! 🏒🏀🏈⚾
            </p>
          </ChapterCard>
        </div>
      </PageContainer>
    </div>
  );
}
