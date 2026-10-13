"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { PrimaryButton } from "@/components/PrimaryButton";
import { getFirebaseClient } from "@/lib/firebase";
import { buildSnakeOrder, defaultDraftItems, type DraftItem } from "@/lib/snakeDraft";
import {
  calculateCombinedTeamRanking,
  createProductKey,
  ensureAllTeamsInOrder,
  type CalculatedTeamRank,
} from "@/lib/rankings";
import AuthGuard from "@/app/auth-guard";
import { useAuth } from "@/components/AuthProvider";

type Product = {
  id: string;
  name: string;
  season: string;
  defaultPrice: number;
  currency: "CZK";
  active: boolean;
  imageUrl?: string;
};

type BoxSelectionItem = {
  tempId: string;
  productId: string;
  productName: string;
  productSeason: string;
  boxCount: number;
  boxPrice: number;
  productImageUrl?: string;
};

type DraftFormValues = {
  draftName: string;
  sport: string;
  margin: number;
  participantCount: number;
  participantNames: string;
  turnDurationOption: "none" | "10" | "15" | "20" | "30" | "45" | "60" | "custom";
  customTurnDurationSeconds: number;
};

const initialValues: DraftFormValues = {
  draftName: "Teamovka",
  sport: "NHL",
  margin: 500,
  participantCount: 8,
  participantNames: "",
  turnDurationOption: "15",
  customTurnDurationSeconds: 15,
};

function NewDraftPageContent() {
  const router = useRouter();
  const { user } = useAuth();
  const [formValues, setFormValues] = useState<DraftFormValues>(initialValues);
  const [products, setProducts] = useState<Product[]>([]);
  const [rankingsMap, setRankingsMap] = useState<Record<string, string[]>>({});
  const [selectedBoxes, setSelectedBoxes] = useState<BoxSelectionItem[]>([]);
  const [customTeamOrder, setCustomTeamOrder] = useState<string[] | null>(null);
  const [isRankingExpanded, setIsRankingExpanded] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Drag & drop state for ranking preview
  const [draggedRankIndex, setDraggedRankIndex] = useState<number | null>(null);
  const [dragOverRankIndex, setDragOverRankIndex] = useState<number | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadData = async () => {
      setIsLoadingProducts(true);
      setError(null);

      try {
        const { db, firestoreApi } = await getFirebaseClient();

        // Load active products
        const productsSnapshot = await firestoreApi.getDocs(firestoreApi.collection(db, "products"));
        const activeProducts = productsSnapshot.docs
          .map((document) => ({
            id: document.id,
            ...(document.data() as Omit<Product, "id">),
          }))
          .filter((product) => product.active) as Product[];

        // Load saved team rankings
        const rankingsSnapshot = await firestoreApi.getDocs(firestoreApi.collection(db, "teamRankings"));
        const map: Record<string, string[]> = {};
        for (const doc of rankingsSnapshot.docs) {
          const data = doc.data();
          const key = (data.productKey as string) || doc.id;
          if (Array.isArray(data.teamOrder)) {
            map[key] = ensureAllTeamsInOrder(data.teamOrder as string[]);
          }
        }

        if (!isMounted) return;

        setProducts(activeProducts);
        setRankingsMap(map);

        if (activeProducts.length > 0 && selectedBoxes.length === 0) {
          const first = activeProducts[0];
          setSelectedBoxes([
            {
              tempId: "box-1",
              productId: first.id,
              productName: first.name,
              productSeason: first.season,
              boxCount: 1,
              boxPrice: first.defaultPrice,
              productImageUrl: first.imageUrl ?? "",
            },
          ]);
        }
      } catch (loadError) {
        console.error(loadError);
        if (isMounted) {
          setError("Nepodařilo se načíst boxy nebo žebříčky z Firestore.");
        }
      } finally {
        if (isMounted) {
          setIsLoadingProducts(false);
        }
      }
    };

    void loadData();

    return () => {
      isMounted = false;
    };
  }, []);

  // Totals calculated from selected boxes
  const totalBoxCount = useMemo(() => {
    return selectedBoxes.reduce((sum, b) => sum + Number(b.boxCount || 0), 0);
  }, [selectedBoxes]);

  const totalBoxesCost = useMemo(() => {
    return selectedBoxes.reduce((sum, b) => sum + Number(b.boxCount || 0) * Number(b.boxPrice || 0), 0);
  }, [selectedBoxes]);

  const targetBreakPrice = useMemo(() => {
    return totalBoxesCost + Number(formValues.margin || 0);
  }, [totalBoxesCost, formValues.margin]);

  const pricePerSlot = useMemo(() => {
    const slots = Number(formValues.participantCount || 0);
    if (slots <= 0 || targetBreakPrice <= 0) return 0;
    return Math.round(targetBreakPrice / slots);
  }, [targetBreakPrice, formValues.participantCount]);

  // Live combined ranking calculated from selected boxes
  const calculatedRankingList = useMemo(() => {
    return calculateCombinedTeamRanking(
      selectedBoxes.map((b) => ({
        productName: b.productName,
        productSeason: b.productSeason,
        boxCount: Number(b.boxCount || 0),
        boxPrice: Number(b.boxPrice || 0),
      })),
      defaultDraftItems,
      rankingsMap,
    );
  }, [selectedBoxes, rankingsMap]);

  // Current active team order (either custom tweaked or automatic calculated)
  const activeTeamOrder = useMemo(() => {
    if (customTeamOrder && customTeamOrder.length === defaultDraftItems.length) {
      return customTeamOrder;
    }
    return calculatedRankingList.map((r) => r.teamId);
  }, [customTeamOrder, calculatedRankingList]);

  const teamLookup = useMemo(() => {
    const map = new Map<string, DraftItem>();
    for (const team of defaultDraftItems) {
      map.set(team.id, team);
    }
    return map;
  }, []);

  const calculatedScoreMap = useMemo(() => {
    const map = new Map<string, CalculatedTeamRank>();
    for (const r of calculatedRankingList) {
      map.set(r.teamId, r);
    }
    return map;
  }, [calculatedRankingList]);

  function handleAddBox() {
    const firstProduct = products[0];
    const newBox: BoxSelectionItem = {
      tempId: `box-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      productId: firstProduct?.id ?? "",
      productName: firstProduct?.name ?? "Vlastní box",
      productSeason: firstProduct?.season ?? "2026/27",
      boxCount: 1,
      boxPrice: firstProduct?.defaultPrice ?? 0,
      productImageUrl: firstProduct?.imageUrl ?? "",
    };
    setSelectedBoxes((current) => [...current, newBox]);
    setCustomTeamOrder(null);
  }

  function handleRemoveBox(tempId: string) {
    if (selectedBoxes.length <= 1) {
      return;
    }
    setSelectedBoxes((current) => current.filter((b) => b.tempId !== tempId));
    setCustomTeamOrder(null);
  }

  function handleBoxProductChange(tempId: string, productId: string) {
    const selected = products.find((p) => p.id === productId);
    if (!selected) return;

    setSelectedBoxes((current) =>
      current.map((b) =>
        b.tempId === tempId
          ? {
              ...b,
              productId: selected.id,
              productName: selected.name,
              productSeason: selected.season,
              boxPrice: selected.defaultPrice,
              productImageUrl: selected.imageUrl ?? "",
            }
          : b,
      ),
    );
    setCustomTeamOrder(null);
  }

  function handleBoxFieldChange(tempId: string, field: "boxCount" | "boxPrice", value: number) {
    setSelectedBoxes((current) =>
      current.map((b) =>
        b.tempId === tempId
          ? {
              ...b,
              [field]: Math.max(0, value),
            }
          : b,
      ),
    );
    setCustomTeamOrder(null);
  }

  function handleMoveRankingTeam(fromIndex: number, direction: "up" | "down") {
    const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= activeTeamOrder.length) return;

    const nextOrder = [...activeTeamOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setCustomTeamOrder(nextOrder);
  }

  function handleDropRankingTeam(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= activeTeamOrder.length || toIndex >= activeTeamOrder.length) {
      return;
    }
    const nextOrder = [...activeTeamOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setCustomTeamOrder(nextOrder);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    if (!user) {
      setError("Pro vytvoření draftu se musíte přihlásit.");
      setIsSubmitting(false);
      return;
    }

    const trimmedTitle = formValues.draftName.trim();
    const trimmedSport = formValues.sport.trim();
    const margin = Number(formValues.margin);
    const participantCount = Number(formValues.participantCount);
    const customTurnDurationSeconds = Number(formValues.customTurnDurationSeconds);

    if (!trimmedTitle || !trimmedSport) {
      setError("Vyplňte název draftu a sport.");
      setIsSubmitting(false);
      return;
    }

    if (selectedBoxes.length === 0) {
      setError("Přidejte do draftu alespoň jeden box.");
      setIsSubmitting(false);
      return;
    }

    if (totalBoxCount <= 0) {
      setError("Celkový počet boxů musí být kladné číslo.");
      setIsSubmitting(false);
      return;
    }

    if (!Number.isFinite(margin) || margin < 0) {
      setError("Marže musí být kladná nebo nulová.");
      setIsSubmitting(false);
      return;
    }

    if (!Number.isInteger(participantCount) || participantCount <= 0) {
      setError("Počet účastníků musí být kladné celé číslo.");
      setIsSubmitting(false);
      return;
    }

    if (formValues.turnDurationOption === "custom") {
      if (!Number.isInteger(customTurnDurationSeconds) || customTurnDurationSeconds < 5 || customTurnDurationSeconds > 300) {
        setError("Vlastní čas na výběr musí být celé číslo v rozmezí 5 až 300 sekund.");
        setIsSubmitting(false);
        return;
      }
    }

    const turnDurationSeconds =
      formValues.turnDurationOption === "none"
        ? null
        : formValues.turnDurationOption === "custom"
          ? customTurnDurationSeconds
          : Number(formValues.turnDurationOption);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      const draftCode = generateDraftCode();

      const reservedParticipantNames = formValues.participantNames
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

      // Prepare boxes payload
      const boxesPayload = selectedBoxes.map((box) => ({
        productId: box.productId,
        productName: box.productName,
        productSeason: box.productSeason,
        boxCount: Number(box.boxCount),
        boxPrice: Number(box.boxPrice),
        productImageUrl: box.productImageUrl || "",
      }));

      // Combined product title & primary product for backward compatibility
      const primaryBox = selectedBoxes[0];
      const combinedProductName =
        selectedBoxes.length === 1
          ? primaryBox.productName
          : selectedBoxes.map((b) => `${b.boxCount}× ${b.productName}`).join(", ");
      const combinedProductSeason =
        selectedBoxes.length === 1
          ? primaryBox.productSeason
          : selectedBoxes.map((b) => b.productSeason).join(" / ");
      const avgBoxPrice = totalBoxCount > 0 ? Math.round(totalBoxesCost / totalBoxCount) : 0;

      // Final team ranking order
      const finalTeamRanking = ensureAllTeamsInOrder(activeTeamOrder);

      const draftData = {
        ownerUserId: user.uid,
        title: trimmedTitle,
        sport: trimmedSport,
        // Boxes and Rankings extensions
        boxes: boxesPayload,
        teamRanking: finalTeamRanking,
        teamRankingLocked: false,
        // Legacy backward compatible fields
        productId: primaryBox?.productId ?? "",
        productName: combinedProductName,
        productSeason: combinedProductSeason,
        productPrice: avgBoxPrice,
        productImageUrl: primaryBox?.productImageUrl ?? "",
        boxCount: totalBoxCount,
        boxPrice: avgBoxPrice,
        margin,
        targetBreakPrice,
        participantCount,
        participants: Array.from({ length: participantCount }, (_, index) => {
          const displayName = reservedParticipantNames[index] ?? "";

          return {
            id: `participant-${index + 1}`,
            uid: "",
            displayName,
            name: displayName,
            email: "",
            joinedAt: null,
            pickCount: 0,
            status: "waiting",
            picks: [],
          };
        }),
        status: "waiting",
        currentPickIndex: 0,
        pickOrder: buildSnakeOrder(participantCount, defaultDraftItems.length),
        draftItems: defaultDraftItems,
        availableItemIds: defaultDraftItems.map((item) => item.id),
        history: [],
        turnDurationSeconds,
        createdAt: firestoreApi.serverTimestamp(),
        updatedAt: firestoreApi.serverTimestamp(),
        code: draftCode,
      };

      await firestoreApi.setDoc(firestoreApi.doc(db, "drafts", draftCode), draftData);
      router.push(`/draft/${draftCode}`);
    } catch (createError) {
      console.error(createError);
      setError("Nepodařilo se vytvořit draft.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleChange(field: keyof DraftFormValues, value: string | number) {
    setFormValues((current) => ({ ...current, [field]: value }));
  }

  function generateDraftCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  }

  return (
    <div className="min-h-screen text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto max-w-4xl">
          <Card className="space-y-8">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-[#18C964]/30 bg-[#18C964]/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.25em] text-[#8ef0b5]">
                  Nový draft
                </span>
                <span className="text-xs text-slate-400">Automatický výpočet žebříčku</span>
              </div>
              <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
                Vytvořit nový snake draft
              </h1>
              <p className="text-base text-slate-400">
                Nastavte parametry draftu a zvolte kombinaci boxů. Ze zvolených boxů se automaticky sestaví vážený žebříček atraktivity všech 32 týmů NHL.
              </p>
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            ) : null}

            <form onSubmit={handleSubmit} className="grid gap-6">
              {/* Draft Name & Sport */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-300" htmlFor="draftName">
                    Název draftu *
                  </label>
                  <input
                    id="draftName"
                    value={formValues.draftName}
                    onChange={(event) => handleChange("draftName", event.target.value)}
                    placeholder="GB372 Snake Break"
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-[#18C964]"
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-300" htmlFor="sport">
                    Sport
                  </label>
                  <select
                    id="sport"
                    value={formValues.sport}
                    onChange={(event) => handleChange("sport", event.target.value)}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-[#18C964]"
                  >
                    <option value="NHL">NHL (32 týmů)</option>
                  </select>
                </div>
              </div>

              {/* SECTION: BOXES CONFIGURATION */}
              <div className="rounded-3xl border border-slate-800/80 bg-slate-950/60 p-5 backdrop-blur-sm sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                  <div>
                    <h3 className="text-base font-bold text-white">Složení breaku (boxy a ročníky)</h3>
                    <p className="text-xs text-slate-400">
                      Zvolte jeden nebo více boxů. Z jejich počtu se automaticky vypočte společný žebříček atraktivity.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleAddBox}
                    className="rounded-xl border border-[#18C964]/40 bg-[#18C964]/10 px-3.5 py-1.5 text-xs font-bold text-[#8ef0b5] transition hover:bg-[#18C964]/20"
                  >
                    + Přidat další box
                  </button>
                </div>

                {isLoadingProducts ? (
                  <p className="text-xs text-slate-400">Načítám evidované boxy...</p>
                ) : (
                  <div className="space-y-3">
                    {selectedBoxes.map((box, index) => {
                      const productKey = createProductKey(box.productName, box.productSeason);
                      const hasSavedRanking = Boolean(rankingsMap[productKey]);

                      return (
                        <div
                          key={box.tempId}
                          className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="flex-1 grid gap-3 sm:grid-cols-3 sm:items-center">
                            {/* Product Selector */}
                            <div className="sm:col-span-1">
                              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                Box #{index + 1}
                              </label>
                              <select
                                value={box.productId}
                                onChange={(e) => handleBoxProductChange(box.tempId, e.target.value)}
                                className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white outline-none focus:border-[#18C964]"
                              >
                                {products.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name} ({p.season})
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* Count */}
                            <div>
                              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                Počet boxů
                              </label>
                              <input
                                type="number"
                                min="1"
                                value={box.boxCount}
                                onChange={(e) => handleBoxFieldChange(box.tempId, "boxCount", Number(e.target.value))}
                                className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white outline-none focus:border-[#18C964]"
                              />
                            </div>

                            {/* Price per box */}
                            <div>
                              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                Cena za box (Kč)
                              </label>
                              <input
                                type="number"
                                min="0"
                                value={box.boxPrice}
                                onChange={(e) => handleBoxFieldChange(box.tempId, "boxPrice", Number(e.target.value))}
                                className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white outline-none focus:border-[#18C964]"
                              />
                            </div>
                          </div>

                          <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                                hasSavedRanking
                                  ? "border border-emerald-500/30 bg-emerald-950/40 text-[#8ef0b5]"
                                  : "border border-amber-500/30 bg-amber-950/40 text-amber-300"
                              }`}
                              title={hasSavedRanking ? "Má uložený žebříček v administraci" : "Použije výchozí pořadí"}
                            >
                              {hasSavedRanking ? "✓ Vlastní žebříček" : "Výchozí žebříček"}
                            </span>

                            {selectedBoxes.length > 1 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveBox(box.tempId)}
                                className="text-xs text-red-400 hover:text-red-300"
                              >
                                Odebrat
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* SECTION: COMBINED ATTRACTIVENESS RANKING PREVIEW */}
              <div className="rounded-3xl border border-slate-800/80 bg-slate-950/60 p-5 backdrop-blur-sm sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-white">Vypočtený žebříček atraktivity pro draft</h3>
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-[#8ef0b5]">
                        32 týmů
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      Vážený průměr pořadí:{" "}
                      <span className="text-slate-300">
                        {selectedBoxes.map((b) => `${b.boxCount}× ${b.productName} (${b.productSeason})`).join(" + ")}
                      </span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {customTeamOrder && (
                      <button
                        type="button"
                        onClick={() => setCustomTeamOrder(null)}
                        className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                      >
                        Obnovit vypočtené pořadí
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsRankingExpanded(!isRankingExpanded)}
                      className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-bold text-[#8ef0b5] hover:bg-slate-800"
                    >
                      {isRankingExpanded ? "Skrýt všech 32 týmů ▲" : "Zobrazit a upravit všech 32 týmů ▼"}
                    </button>
                  </div>
                </div>

                {/* Top 6 summary badges */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-slate-500">Nejatraktivnější:</span>
                  {activeTeamOrder.slice(0, 6).map((teamId, idx) => {
                    const team = teamLookup.get(teamId);
                    const calc = calculatedScoreMap.get(teamId);
                    return (
                      <div
                        key={teamId}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-200"
                      >
                        <span className="font-bold text-[#8ef0b5]">#{idx + 1}</span>
                        {team?.logo && <img src={team.logo} alt={team.name} className="h-4 w-4 object-contain" />}
                        <span className="truncate max-w-[80px]">{team?.name.split(" ").pop()}</span>
                        {calc && <span className="text-[10px] text-slate-500 font-mono">({calc.score.toFixed(1)})</span>}
                      </div>
                    );
                  })}
                  {activeTeamOrder.length > 6 && (
                    <span className="text-xs text-slate-500">+ dalších {activeTeamOrder.length - 6} týmů</span>
                  )}
                </div>

                {/* Full reorderable list when expanded */}
                {isRankingExpanded && (
                  <div className="mt-4 space-y-3 border-t border-slate-800 pt-4">
                    <p className="text-xs text-slate-400">
                      Pořadí můžete ručně upravit přetažením myší nebo šipkami. Výsledné pořadí se uloží jako součást tohoto draftu.
                    </p>

                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 max-h-[460px] overflow-y-auto pr-1">
                      {activeTeamOrder.map((teamId, index) => {
                        const team = teamLookup.get(teamId);
                        const calc = calculatedScoreMap.get(teamId);
                        const isDragging = draggedRankIndex === index;
                        const isTarget = dragOverRankIndex === index;

                        return (
                          <div
                            key={teamId}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/plain", String(index));
                              setDraggedRankIndex(index);
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (dragOverRankIndex !== index) setDragOverRankIndex(index);
                            }}
                            onDragLeave={() => {
                              if (dragOverRankIndex === index) setDragOverRankIndex(null);
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const fromIdx = Number(e.dataTransfer.getData("text/plain"));
                              if (!Number.isNaN(fromIdx)) {
                                handleDropRankingTeam(fromIdx, index);
                              }
                              setDraggedRankIndex(null);
                              setDragOverRankIndex(null);
                            }}
                            onDragEnd={() => {
                              setDraggedRankIndex(null);
                              setDragOverRankIndex(null);
                            }}
                            className={`flex items-center justify-between gap-2 rounded-xl border p-2 text-xs transition-all select-none cursor-grab active:cursor-grabbing ${
                              isDragging
                                ? "opacity-30 border-dashed border-[#18C964]"
                                : isTarget
                                  ? "border-2 border-[#18C964] bg-emerald-950/40"
                                  : "border-slate-800 bg-slate-900/80 hover:border-slate-700"
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-slate-600 font-mono text-[10px]">⋮⋮</span>
                              <span
                                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-black ${
                                  index === 0
                                    ? "bg-amber-400 text-slate-950"
                                    : index === 1
                                      ? "bg-slate-300 text-slate-950"
                                      : index === 2
                                        ? "bg-amber-700 text-white"
                                        : "bg-slate-800 text-slate-300"
                                }`}
                              >
                                {index + 1}
                              </span>
                              {team?.logo && <img src={team.logo} alt={team.name} className="h-5 w-5 object-contain" />}
                              <span className="truncate font-semibold text-white">{team?.name || teamId}</span>
                            </div>

                            <div className="flex items-center gap-1">
                              {calc && (
                                <span className="font-mono text-[10px] text-slate-500 mr-1" title="Vypočtené skóre">
                                  {calc.score.toFixed(1)}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => handleMoveRankingTeam(index, "up")}
                                disabled={index === 0}
                                className="h-5 w-5 rounded border border-slate-800 bg-slate-950 text-[10px] text-slate-400 hover:text-white disabled:opacity-20"
                              >
                                ▲
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveRankingTeam(index, "down")}
                                disabled={index === activeTeamOrder.length - 1}
                                className="h-5 w-5 rounded border border-slate-800 bg-slate-950 text-[10px] text-slate-400 hover:text-white disabled:opacity-20"
                              >
                                ▼
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Financial & Participant parameters */}
              <div className="grid gap-6 md:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-300" htmlFor="margin">
                    Marže celého breaku (Kč)
                  </label>
                  <input
                    id="margin"
                    type="number"
                    min="0"
                    value={formValues.margin}
                    onChange={(event) => handleChange("margin", Number(event.target.value))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-[#18C964]"
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-300" htmlFor="participantCount">
                    Počet účastnických pozic
                  </label>
                  <input
                    id="participantCount"
                    type="number"
                    min="1"
                    value={formValues.participantCount}
                    onChange={(event) => handleChange("participantCount", Number(event.target.value))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-[#18C964]"
                  />
                </div>
              </div>

              {/* Turn Duration */}
              <div className="grid gap-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-300" htmlFor="turnDurationOption">
                  Čas na výběr jednoho tahu
                </label>
                <select
                  id="turnDurationOption"
                  value={formValues.turnDurationOption}
                  onChange={(event) => handleChange("turnDurationOption", event.target.value)}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-[#18C964]"
                >
                  <option value="none">Bez limitu</option>
                  <option value="10">10 sekund</option>
                  <option value="15">15 sekund (standard)</option>
                  <option value="20">20 sekund</option>
                  <option value="30">30 sekund</option>
                  <option value="45">45 sekund</option>
                  <option value="60">60 sekund</option>
                  <option value="custom">Vlastní limit</option>
                </select>
              </div>

              {formValues.turnDurationOption === "custom" ? (
                <div className="grid gap-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-300" htmlFor="customTurnDurationSeconds">
                    Vlastní čas na výběr (sekundy)
                  </label>
                  <input
                    id="customTurnDurationSeconds"
                    type="number"
                    min="5"
                    max="300"
                    value={formValues.customTurnDurationSeconds}
                    onChange={(event) => handleChange("customTurnDurationSeconds", Number(event.target.value))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-[#18C964]"
                  />
                  <p className="text-xs text-slate-400">Povolený rozsah je 5 až 300 sekund.</p>
                </div>
              ) : null}

              {/* Participant Names */}
              <div className="grid gap-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-300" htmlFor="participantNames">
                  Předvyplněná jména účastníků (každé na nový řádek)
                </label>
                <textarea
                  id="participantNames"
                  value={formValues.participantNames}
                  onChange={(event) => handleChange("participantNames", event.target.value)}
                  placeholder={"Petr\nMartin\nKarel\nFilip"}
                  rows={6}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-[#18C964]"
                />
                <p className="text-xs text-slate-400">
                  Zadaná jména se uloží jako rezervovaná místa v rozpisu draftu.
                </p>
              </div>

              {/* Financial Summary */}
              <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-5 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-slate-400">Celkem boxů v breaku</p>
                  <p className="mt-1 text-xl font-bold text-white">{totalBoxCount} ks</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Cena za jednu pozici</p>
                  <p className="mt-1 text-xl font-bold text-[#8ef0b5]">
                    {pricePerSlot.toLocaleString("cs-CZ")} Kč
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Celková cena breaku</p>
                  <p className="mt-1 text-xl font-bold text-white">
                    {targetBreakPrice.toLocaleString("cs-CZ")} Kč
                  </p>
                </div>
              </div>

              <PrimaryButton>{isSubmitting ? "Vytvářím draft..." : "Vytvořit draft a otevřít místnost"}</PrimaryButton>
            </form>
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}

export default function NewDraftPage() {
  return (
    <AuthGuard>
      <NewDraftPageContent />
    </AuthGuard>
  );
}
