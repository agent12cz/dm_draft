"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { PrimaryButton } from "@/components/PrimaryButton";
import { getFirebaseClient } from "@/lib/firebase";
import { buildSnakeOrder, defaultDraftItems } from "@/lib/snakeDraft";
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

type DraftFormValues = {
  draftName: string;
  sport: string;
  selectedProductId: string;
  boxCount: number;
  boxPrice: number;
  margin: number;
  participantCount: number;
  participantNames: string;
  turnDurationOption: "none" | "10" | "15" | "20" | "30" | "45" | "60" | "custom";
  customTurnDurationSeconds: number;
};

const initialValues: DraftFormValues = {
  draftName: "Teamovka",
  sport: "NHL",
  selectedProductId: "",
  boxCount: 1,
  boxPrice: 0,
  margin: 500,
  participantCount: 8,
  participantNames: "",
  turnDurationOption: "15",
  customTurnDurationSeconds: 15,
};

function NewDraftPageContent() {
  const router = useRouter();
  const [formValues, setFormValues] = useState<DraftFormValues>(initialValues);
  const [products, setProducts] = useState<Product[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadProducts = async () => {
      setIsLoadingProducts(true);
      setError(null);

      try {
        const { db, firestoreApi } = await getFirebaseClient();
        const snapshot = await firestoreApi.getDocs(firestoreApi.collection(db, "products"));
        const activeProducts = snapshot.docs
          .map((document) => ({
            id: document.id,
            ...(document.data() as Omit<Product, "id">),
          }))
          .filter((product) => product.active) as Product[];

        if (!isMounted) {
          return;
        }

        setProducts(activeProducts);

        if (activeProducts.length > 0 && !formValues.selectedProductId) {
          setFormValues((current) => ({
            ...current,
            selectedProductId: activeProducts[0].id,
            boxPrice: activeProducts[0].defaultPrice,
          }));
        }
      } catch (loadError) {
        console.error(loadError);
        if (isMounted) {
          setError("Nepodařilo se načíst boxy z Firestore.");
        }
      } finally {
        if (isMounted) {
          setIsLoadingProducts(false);
        }
      }
    };

    void loadProducts();

    return () => {
      isMounted = false;
    };
  }, [formValues.selectedProductId]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const trimmedTitle = formValues.draftName.trim();
    const trimmedSport = formValues.sport.trim();
    const boxCount = Number(formValues.boxCount);
    const boxPrice = Number(formValues.boxPrice);
    const margin = Number(formValues.margin);
    const participantCount = Number(formValues.participantCount);
    const customTurnDurationSeconds = Number(formValues.customTurnDurationSeconds);

    if (!trimmedTitle || !trimmedSport) {
      setError("Vyplňte název draftu a sport.");
      setIsSubmitting(false);
      return;
    }

    if (!formValues.selectedProductId) {
      setError("Vyberte prosím aktivní box.");
      setIsSubmitting(false);
      return;
    }

    if (!Number.isInteger(boxCount) || boxCount <= 0) {
      setError("Počet boxů musí být kladné celé číslo.");
      setIsSubmitting(false);
      return;
    }

    if (!Number.isFinite(boxPrice) || boxPrice < 0) {
      setError("Cena jednoho boxu musí být kladná nebo nulová.");
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

    const turnDurationSeconds = formValues.turnDurationOption === "none"
      ? null
      : formValues.turnDurationOption === "custom"
        ? customTurnDurationSeconds
        : Number(formValues.turnDurationOption);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      const draftCode = generateDraftCode();
      const selectedProduct = products.find((product) => product.id === formValues.selectedProductId);
      const targetBreakPrice = boxCount * boxPrice + margin;
      const reservedParticipantNames = formValues.participantNames
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

      const draftData = {
        title: trimmedTitle,
        sport: trimmedSport,
        productId: selectedProduct?.id ?? "",
        productName: selectedProduct?.name ?? "",
        productSeason: selectedProduct?.season ?? "",
        productPrice: selectedProduct?.defaultPrice ?? boxPrice,
        productImageUrl: selectedProduct?.imageUrl ?? "",
        boxCount,
        boxPrice,
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

  function handleProductChange(productId: string) {
    const selectedProduct = products.find((product) => product.id === productId);
    setFormValues((current) => ({
      ...current,
      selectedProductId: productId,
      boxPrice: selectedProduct?.defaultPrice ?? current.boxPrice,
    }));
  }

  function generateDraftCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const randomPart = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");

    return randomPart;
  }

  const selectedProduct = products.find((product) => product.id === formValues.selectedProductId) ?? null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto max-w-4xl">
          <Card className="space-y-8">
            <div className="space-y-3">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
                Vytvořit nový snake draft
              </p>
              <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Vytvořit nový draft
              </h1>
              <p className="text-lg leading-8 text-slate-400">
                Založte skupinový break s obecnými draftItems, kde účastníci vybírají NHL týmy v snake pořadí.
              </p>
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            ) : null}

            <form onSubmit={handleSubmit} className="grid gap-6">
              <div className="grid gap-2">
                <label className="text-sm font-medium text-slate-300" htmlFor="draftName">
                  Název draftu
                </label>
                <input
                  id="draftName"
                  value={formValues.draftName}
                  onChange={(event) => handleChange("draftName", event.target.value)}
                  placeholder="GB372 Snake Break"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium text-slate-300" htmlFor="sport">
                  Sport
                </label>
                <select
                  id="sport"
                  value={formValues.sport}
                  onChange={(event) => handleChange("sport", event.target.value)}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                >
                  <option value="NHL">NHL</option>
                </select>
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium text-slate-300" htmlFor="product">
                  Aktivní box
                </label>
                <select
                  id="product"
                  value={formValues.selectedProductId}
                  onChange={(event) => handleProductChange(event.target.value)}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                >
                  {isLoadingProducts ? (
                    <option value="">Načítám boxy...</option>
                  ) : products.length > 0 ? (
                    products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name} ({product.season})
                      </option>
                    ))
                  ) : (
                    <option value="">Žádné aktivní boxy</option>
                  )}
                </select>
              </div>

              {selectedProduct ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
                  <p className="font-semibold text-white">Vybraný box</p>
                  <p className="mt-2">{selectedProduct.name}</p>
                  <p className="text-slate-400">Sezóna: {selectedProduct.season}</p>
                  <p className="text-slate-400">Cena: {selectedProduct.defaultPrice} Kč</p>
                </div>
              ) : null}

              <div className="grid gap-6 md:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-300" htmlFor="boxCount">
                    Počet boxů
                  </label>
                  <input
                    id="boxCount"
                    type="number"
                    min="1"
                    value={formValues.boxCount}
                    onChange={(event) => handleChange("boxCount", Number(event.target.value))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-300" htmlFor="boxPrice">
                    Cena jednoho boxu (Kč)
                  </label>
                  <input
                    id="boxPrice"
                    type="number"
                    min="0"
                    value={formValues.boxPrice}
                    onChange={(event) => handleChange("boxPrice", Number(event.target.value))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                  />
                </div>
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-300" htmlFor="margin">
                    Marže (Kč)
                  </label>
                  <input
                    id="margin"
                    type="number"
                    min="0"
                    value={formValues.margin}
                    onChange={(event) => handleChange("margin", Number(event.target.value))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-300" htmlFor="participantCount">
                    Počet účastníků
                  </label>
                  <input
                    id="participantCount"
                    type="number"
                    min="1"
                    value={formValues.participantCount}
                    onChange={(event) => handleChange("participantCount", Number(event.target.value))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium text-slate-300" htmlFor="turnDurationOption">
                  Čas na výběr
                </label>
                <select
                  id="turnDurationOption"
                  value={formValues.turnDurationOption}
                  onChange={(event) => handleChange("turnDurationOption", event.target.value)}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                >
                  <option value="none">Bez limitu</option>
                  <option value="10">10 sekund</option>
                  <option value="15">15 sekund</option>
                  <option value="20">20 sekund</option>
                  <option value="30">30 sekund</option>
                  <option value="45">45 sekund</option>
                  <option value="60">60 sekund</option>
                  <option value="custom">Vlastní</option>
                </select>
              </div>

              {formValues.turnDurationOption === "custom" ? (
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-300" htmlFor="customTurnDurationSeconds">
                    Vlastní čas na výběr (sekundy)
                  </label>
                  <input
                    id="customTurnDurationSeconds"
                    type="number"
                    min="5"
                    max="300"
                    value={formValues.customTurnDurationSeconds}
                    onChange={(event) => handleChange("customTurnDurationSeconds", Number(event.target.value))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                  />
                  <p className="text-sm text-slate-400">Povolený rozsah je 5 až 300 sekund.</p>
                </div>
              ) : null}

              <div className="grid gap-2">
                <label className="text-sm font-medium text-slate-300" htmlFor="participantNames">
                  Jména účastníků (každé na nový řádek)
                </label>
                <textarea
                  id="participantNames"
                  value={formValues.participantNames}
                  onChange={(event) => handleChange("participantNames", event.target.value)}
                  placeholder="Petr\nMartin\nKarel\nFilip"
                  rows={8}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
                <p className="text-sm text-slate-400">První jména se uloží jako rezervovaná místa pro připojení účastníků.</p>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">
                <p className="font-semibold text-white">Cílová cena breaku</p>
                <p className="mt-2 text-lg text-[#18C964]">
                  {Number(formValues.boxCount) * Number(formValues.boxPrice) + Number(formValues.margin)} Kč
                </p>
              </div>

              <PrimaryButton>{isSubmitting ? "Vytvářím draft..." : "Vytvořit draft"}</PrimaryButton>
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
