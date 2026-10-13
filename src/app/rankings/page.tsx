"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import { defaultDraftItems, type DraftItem } from "@/lib/snakeDraft";
import {
  createProductKey,
  ensureAllTeamsInOrder,
  type TeamRankingRecord,
} from "@/lib/rankings";
import AuthGuard from "@/app/auth-guard";

type Product = {
  id: string;
  name: string;
  season: string;
  defaultPrice: number;
  currency: "CZK";
  active: boolean;
  imageUrl?: string;
};

function RankingsPageContent() {
  const [rankings, setRankings] = useState<TeamRankingRecord[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Editor state
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // productKey if editing existing
  const [seriesInput, setSeriesInput] = useState("");
  const [seasonInput, setSeasonInput] = useState("");
  const [currentTeamOrder, setCurrentTeamOrder] = useState<string[]>(() =>
    defaultDraftItems.map((item) => item.id),
  );
  const [copySourceId, setCopySourceId] = useState<string>("");

  // Drag & drop state
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();

      // Load products
      const productsSnapshot = await firestoreApi.getDocs(firestoreApi.collection(db, "products"));
      const loadedProducts = productsSnapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<Product, "id">),
      })) as Product[];
      setProducts(loadedProducts);

      // Load rankings
      const rankingsSnapshot = await firestoreApi.getDocs(firestoreApi.collection(db, "teamRankings"));
      const loadedRankings = rankingsSnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          series: (data.series as string) || "",
          season: (data.season as string) || "",
          productKey: (data.productKey as string) || doc.id,
          teamOrder: ensureAllTeamsInOrder(data.teamOrder as string[]),
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        } as TeamRankingRecord;
      });

      // Sort alphabetically by series and season
      loadedRankings.sort((a, b) => {
        const seriesCmp = a.series.localeCompare(b.series, "cs", { sensitivity: "base" });
        if (seriesCmp !== 0) return seriesCmp;
        return a.season.localeCompare(b.season, "cs", { sensitivity: "base" });
      });

      setRankings(loadedRankings);
    } catch (loadError) {
      console.error(loadError);
      setError("Nepodařilo se načíst žebříčky a produkty z Firestore.");
    } finally {
      setIsLoading(false);
    }
  }

  const currentProductKey = useMemo(() => {
    return createProductKey(seriesInput, seasonInput);
  }, [seriesInput, seasonInput]);

  const teamLookup = useMemo(() => {
    const map = new Map<string, DraftItem>();
    for (const team of defaultDraftItems) {
      map.set(team.id, team);
    }
    return map;
  }, []);

  function handleStartCreateNew(prefillSeries = "", prefillSeason = "") {
    setEditingId(null);
    setSeriesInput(prefillSeries);
    setSeasonInput(prefillSeason);
    setCurrentTeamOrder(defaultDraftItems.map((item) => item.id));
    setCopySourceId("");
    setError(null);
    setSuccessMessage(null);
    setIsEditing(true);
  }

  function handleStartEdit(ranking: TeamRankingRecord) {
    setEditingId(ranking.id);
    setSeriesInput(ranking.series);
    setSeasonInput(ranking.season);
    setCurrentTeamOrder(ensureAllTeamsInOrder(ranking.teamOrder));
    setCopySourceId("");
    setError(null);
    setSuccessMessage(null);
    setIsEditing(true);
  }

  function handleCopyOrderFrom(sourceId: string) {
    if (!sourceId) return;
    const source = rankings.find((r) => r.id === sourceId);
    if (source) {
      setCurrentTeamOrder(ensureAllTeamsInOrder(source.teamOrder));
      setSuccessMessage(`Pořadí 32 týmů bylo zkopírováno ze žebříčku „${source.series} ${source.season}“.`);
    }
  }

  function handleMove(index: number, direction: "up" | "down") {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= currentTeamOrder.length) {
      return;
    }

    const nextOrder = [...currentTeamOrder];
    const [moved] = nextOrder.splice(index, 1);
    nextOrder.splice(targetIndex, 0, moved);
    setCurrentTeamOrder(nextOrder);
  }

  function handleDrop(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= currentTeamOrder.length || toIndex >= currentTeamOrder.length) {
      return;
    }

    const nextOrder = [...currentTeamOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setCurrentTeamOrder(nextOrder);
  }

  function handleApplyPreset(preset: "default" | "alphabetical" | "reverse") {
    if (preset === "default") {
      setCurrentTeamOrder(defaultDraftItems.map((item) => item.id));
    } else if (preset === "alphabetical") {
      const sorted = [...defaultDraftItems].sort((a, b) =>
        a.name.localeCompare(b.name, "cs", { sensitivity: "base" }),
      );
      setCurrentTeamOrder(sorted.map((item) => item.id));
    } else if (preset === "reverse") {
      setCurrentTeamOrder([...currentTeamOrder].reverse());
    }
  }

  async function handleSaveRanking() {
    const cleanSeries = seriesInput.trim();
    const cleanSeason = seasonInput.trim();

    if (!cleanSeries || !cleanSeason) {
      setError("Vyplňte prosím název série a ročník produktu.");
      return;
    }

    const productKey = createProductKey(cleanSeries, cleanSeason);
    const finalOrder = ensureAllTeamsInOrder(currentTeamOrder);

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();

      await firestoreApi.setDoc(
        firestoreApi.doc(db, "teamRankings", productKey),
        {
          series: cleanSeries,
          season: cleanSeason,
          productKey,
          teamOrder: finalOrder,
          updatedAt: firestoreApi.serverTimestamp(),
          createdAt: firestoreApi.serverTimestamp(),
        },
        { merge: true },
      );

      setSuccessMessage(`Žebříček pro „${cleanSeries} ${cleanSeason}“ byl úspěšně uložen.`);
      setIsEditing(false);
      await loadData();
    } catch (saveError) {
      console.error(saveError);
      setError("Nepodařilo se uložit žebříček do Firestore.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteRanking(ranking: TeamRankingRecord) {
    if (!window.confirm(`Opravdu chcete smazat žebříček pro „${ranking.series} ${ranking.season}“?`)) {
      return;
    }

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.deleteDoc(firestoreApi.doc(db, "teamRankings", ranking.id));
      setSuccessMessage(`Žebříček „${ranking.series} ${ranking.season}“ byl smazán.`);
      await loadData();
    } catch (deleteErr) {
      console.error(deleteErr);
      setError("Nepodařilo se smazat žebříček.");
    }
  }

  // Pre-filter products to check which have rankings
  const productsWithRankingStatus = useMemo(() => {
    return products.map((prod) => {
      const key = createProductKey(prod.name, prod.season);
      const existingRanking = rankings.find((r) => r.id === key);
      return {
        product: prod,
        key,
        hasRanking: Boolean(existingRanking),
        ranking: existingRanking ?? null,
      };
    });
  }, [products, rankings]);

  return (
    <div className="min-h-screen text-slate-100">
      <Navbar />

      <PageContainer className="py-6 lg:py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          {/* Header */}
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <div className="flex items-center gap-2.5">
                <span className="rounded-full border border-[#18C964]/30 bg-[#18C964]/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.25em] text-[#8ef0b5]">
                  Administrace
                </span>
                <span className="text-xs text-slate-400">NHL Attractiveness Rankings</span>
              </div>
              <h1 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">
                Žebříčky atraktivity týmů NHL
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                Každá série a ročník boxu má vlastní žebříček všech 32 týmů, který slouží jako základ pro automatické draftování.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <Link
                href="/products"
                className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-xs font-bold text-slate-300 transition hover:bg-slate-800"
              >
                📦 Spravovat boxy
              </Link>
              {!isEditing && (
                <button
                  type="button"
                  onClick={() => handleStartCreateNew()}
                  className="rounded-2xl bg-gradient-to-r from-[#18C964] to-[#13b15a] px-5 py-2.5 text-xs font-black uppercase tracking-wider text-slate-950 shadow-lg shadow-emerald-950/40 transition hover:brightness-110 active:scale-95"
                >
                  + Nový žebříček
                </button>
              )}
            </div>
          </div>

          {/* Feedback messages */}
          {error && (
            <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
          {successMessage && (
            <div className="rounded-2xl border border-[#18C964]/40 bg-[#18C964]/10 px-4 py-3 text-sm text-[#8ef0b5]">
              {successMessage}
            </div>
          )}

          {/* EDITOR VIEW */}
          {isEditing ? (
            <Card className="space-y-6 border border-[#18C964]/30 bg-slate-900/95 p-6 shadow-2xl backdrop-blur-md sm:p-8">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
                <div>
                  <span className="text-xs font-bold uppercase tracking-widest text-[#8ef0b5]">
                    {editingId ? "Úprava žebříčku" : "Nový žebříček"}
                  </span>
                  <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
                    {seriesInput && seasonInput ? `${seriesInput} – ${seasonInput}` : "Zadejte sérii a ročník"}
                  </h2>
                  <p className="mt-1 text-xs text-slate-400">
                    Unikátní identifikátor produktu:{" "}
                    <code className="rounded bg-slate-950 px-2 py-0.5 font-mono text-emerald-400">
                      {currentProductKey || "—"}
                    </code>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditing(false);
                      setEditingId(null);
                    }}
                    className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-800"
                  >
                    Zrušit
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveRanking()}
                    disabled={isSaving}
                    className="rounded-xl bg-[#18C964] px-5 py-2 text-xs font-black uppercase tracking-wider text-slate-950 shadow transition hover:bg-[#13b15a] disabled:opacity-50"
                  >
                    {isSaving ? "Ukládám…" : "Uložit žebříček"}
                  </button>
                </div>
              </div>

              {/* Form inputs */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                    Série / Název produktu *
                  </label>
                  <input
                    type="text"
                    value={seriesInput}
                    onChange={(e) => setSeriesInput(e.target.value)}
                    placeholder="např. Series One, Ultimate, O-Pee-Chee..."
                    className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950/80 px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition focus:border-[#18C964]"
                  />
                  {products.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1 text-[11px] text-slate-500">
                      <span>Rychlý výběr:</span>
                      {products.slice(0, 4).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setSeriesInput(p.name);
                            setSeasonInput(p.season);
                          }}
                          className="text-[#8ef0b5] underline hover:text-white"
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                    Ročník / Sezóna *
                  </label>
                  <input
                    type="text"
                    value={seasonInput}
                    onChange={(e) => setSeasonInput(e.target.value)}
                    placeholder="např. 2026/27, 2025/26..."
                    className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950/80 px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition focus:border-[#18C964]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                    Zkopírovat pořadí z ročníku
                  </label>
                  <div className="mt-1.5 flex gap-2">
                    <select
                      value={copySourceId}
                      onChange={(e) => setCopySourceId(e.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-white outline-none focus:border-[#18C964]"
                    >
                      <option value="">Vyberte žebříček pro zkopírování...</option>
                      {rankings
                        .filter((r) => r.id !== editingId)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.series} {r.season}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => handleCopyOrderFrom(copySourceId)}
                      disabled={!copySourceId}
                      className="shrink-0 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
                    >
                      Kopírovat
                    </button>
                  </div>
                </div>
              </div>

              {/* Sorting toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white">Pořadí všech 32 týmů</span>
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-300">
                    {currentTeamOrder.length} týmů
                  </span>
                  <span className="text-slate-500">
                    (Přetažením myší nebo šipkami nastavte atraktivitu: #1 = nejatraktivnější)
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-slate-500">Předvolby:</span>
                  <button
                    type="button"
                    onClick={() => handleApplyPreset("default")}
                    className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Výchozí
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyPreset("alphabetical")}
                    className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Abecedně
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyPreset("reverse")}
                    className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
                  >
                    Obrátit
                  </button>
                </div>
              </div>

              {/* Teams Drag & Drop List */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {currentTeamOrder.map((teamId, index) => {
                  const team = teamLookup.get(teamId);
                  const isTopTier = index < 3;
                  const isBottomTier = index >= 28;
                  const isDraggingThis = draggedIndex === index;
                  const isDragTarget = dragOverIndex === index;

                  return (
                    <div
                      key={teamId}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", String(index));
                        setDraggedIndex(index);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragOverIndex !== index) {
                          setDragOverIndex(index);
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverIndex === index) {
                          setDragOverIndex(null);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const fromIdx = Number(e.dataTransfer.getData("text/plain"));
                        if (!Number.isNaN(fromIdx)) {
                          handleDrop(fromIdx, index);
                        }
                        setDraggedIndex(null);
                        setDragOverIndex(null);
                      }}
                      onDragEnd={() => {
                        setDraggedIndex(null);
                        setDragOverIndex(null);
                      }}
                      className={`group relative flex items-center justify-between gap-2 rounded-2xl border p-2.5 transition-all select-none cursor-grab active:cursor-grabbing ${
                        isDraggingThis
                          ? "opacity-40 border-dashed border-[#18C964]"
                          : isDragTarget
                            ? "border-2 border-[#18C964] bg-emerald-950/40 scale-[1.02]"
                            : isTopTier
                              ? "border-emerald-500/40 bg-emerald-950/20"
                              : isBottomTier
                                ? "border-slate-800/80 bg-slate-950/40 opacity-80"
                                : "border-slate-800 bg-slate-950/70 hover:border-slate-700"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {/* Drag Handle Icon */}
                        <span className="text-slate-600 transition group-hover:text-slate-400">
                          ⋮⋮
                        </span>

                        {/* Rank Badge */}
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs font-black ${
                            index === 0
                              ? "bg-amber-400 text-slate-950 shadow"
                              : index === 1
                                ? "bg-slate-300 text-slate-950 shadow"
                                : index === 2
                                  ? "bg-amber-700 text-white shadow"
                                  : "bg-slate-800 text-slate-300"
                          }`}
                        >
                          {index + 1}
                        </span>

                        {/* Team Logo */}
                        {team?.logo ? (
                          <img
                            src={team.logo}
                            alt={team.name}
                            className="h-7 w-7 shrink-0 object-contain drop-shadow"
                            loading="lazy"
                          />
                        ) : null}

                        {/* Team Name */}
                        <span className="truncate text-xs font-bold text-white group-hover:text-[#8ef0b5]">
                          {team?.name || teamId}
                        </span>
                      </div>

                      {/* Up/Down Arrow Controls */}
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMove(index, "up");
                          }}
                          disabled={index === 0}
                          title="Posunout nahoru"
                          className="flex h-6 w-6 items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMove(index, "down");
                          }}
                          disabled={index === currentTeamOrder.length - 1}
                          title="Posunout dolů"
                          className="flex h-6 w-6 items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          ▼
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Bottom Action Bar */}
              <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-5">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditing(false);
                    setEditingId(null);
                  }}
                  className="rounded-xl border border-slate-700 bg-slate-950 px-5 py-2.5 text-xs font-bold text-slate-300 transition hover:bg-slate-800"
                >
                  Zrušit
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveRanking()}
                  disabled={isSaving}
                  className="rounded-xl bg-[#18C964] px-6 py-2.5 text-xs font-black uppercase tracking-wider text-slate-950 shadow-lg transition hover:bg-[#13b15a] disabled:opacity-50"
                >
                  {isSaving ? "Ukládám…" : "Uložit žebříček"}
                </button>
              </div>
            </Card>
          ) : null}

          {/* BOXES / PRODUCTS COVERAGE OVERVIEW */}
          {!isEditing && productsWithRankingStatus.length > 0 && (
            <div className="rounded-3xl border border-slate-800/80 bg-slate-900/60 p-5 backdrop-blur-sm sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white">Stav žebříčků pro evidované boxy</h3>
                  <p className="text-xs text-slate-400">Přehled boxů z katalogu a dostupnost jejich žebříčku</p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {productsWithRankingStatus.map(({ product, hasRanking, ranking }) => (
                  <div
                    key={product.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-3.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-white">{product.name}</p>
                      <p className="text-xs text-slate-400">{product.season}</p>
                    </div>

                    {hasRanking && ranking ? (
                      <button
                        type="button"
                        onClick={() => handleStartEdit(ranking)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-950/40 px-3 py-1.5 text-xs font-bold text-[#8ef0b5] transition hover:bg-emerald-900/50"
                      >
                        <span>✓ Nastaven</span>
                        <span className="text-[10px] text-slate-400">Upravit</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleStartCreateNew(product.name, product.season)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-950/40 px-3 py-1.5 text-xs font-bold text-amber-300 transition hover:bg-amber-900/50"
                      >
                        <span>+ Vytvořit</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SAVED RANKINGS LIST */}
          {!isEditing && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-white">Uložené žebříčky ({rankings.length})</h3>
                <span className="text-xs text-slate-500">Uloženo v kolekci teamRankings</span>
              </div>

              {isLoading ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-8 text-center text-sm text-slate-400">
                  Načítám žebříčky...
                </div>
              ) : rankings.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-slate-800 bg-slate-950/40 p-10 text-center">
                  <p className="text-4xl">🏒</p>
                  <h4 className="mt-3 text-lg font-bold text-white">Zatím není vytvořen žádný žebříček</h4>
                  <p className="mt-1 text-sm text-slate-400">
                    Vytvořte první žebříček atraktivity pro libovolný ročník a sérii boxu.
                  </p>
                  <button
                    type="button"
                    onClick={() => handleStartCreateNew()}
                    className="mt-5 rounded-2xl bg-[#18C964] px-5 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-[#13b15a]"
                  >
                    + Vytvořit první žebříček
                  </button>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {rankings.map((ranking) => {
                    const topTeams = ranking.teamOrder
                      .slice(0, 5)
                      .map((id) => teamLookup.get(id))
                      .filter(Boolean) as DraftItem[];

                    return (
                      <div
                        key={ranking.id}
                        className="flex flex-col justify-between rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg backdrop-blur-sm transition hover:border-slate-700"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="rounded-full border border-slate-700 bg-slate-800/80 px-2.5 py-0.5 text-[11px] font-bold text-slate-300">
                              {ranking.season}
                            </span>
                            <code className="text-[10px] font-mono text-slate-500">
                              {ranking.productKey}
                            </code>
                          </div>

                          <h4 className="mt-2 text-lg font-black text-white">
                            {ranking.series}
                          </h4>

                          {/* Top 5 teams preview */}
                          <div className="mt-3 space-y-1.5 border-t border-slate-800/80 pt-3">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                              Top 5 týmů:
                            </p>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {topTeams.map((team, idx) => (
                                <div
                                  key={team.id}
                                  className="inline-flex items-center gap-1 rounded-full border border-slate-800 bg-slate-950/80 px-2 py-0.5 text-[11px] text-slate-300"
                                  title={`${idx + 1}. ${team.name}`}
                                >
                                  <span className="font-bold text-[#8ef0b5]">#{idx + 1}</span>
                                  {team.logo ? (
                                    <img
                                      src={team.logo}
                                      alt={team.name}
                                      className="h-3.5 w-3.5 object-contain"
                                    />
                                  ) : null}
                                  <span className="max-w-[70px] truncate">{team.name.split(" ").pop()}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Card actions */}
                        <div className="mt-5 flex items-center justify-between border-t border-slate-800/70 pt-4">
                          <button
                            type="button"
                            onClick={() => {
                              handleStartCreateNew(ranking.series, "");
                              setCurrentTeamOrder(ranking.teamOrder);
                            }}
                            className="text-xs font-semibold text-slate-400 transition hover:text-white"
                            title="Vytvořit nový ročník se stejným pořadím"
                          >
                            📋 Kopírovat
                          </button>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleDeleteRanking(ranking)}
                              className="rounded-xl border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/20"
                            >
                              Smazat
                            </button>
                            <button
                              type="button"
                              onClick={() => handleStartEdit(ranking)}
                              className="rounded-xl bg-[#18C964] px-4 py-1.5 text-xs font-black uppercase text-slate-950 transition hover:bg-[#13b15a]"
                            >
                              Upravit
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </PageContainer>
    </div>
  );
}

export default function RankingsPage() {
  return (
    <AuthGuard>
      <RankingsPageContent />
    </AuthGuard>
  );
}
