"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import { callFirestoreWorker } from "@/lib/firestoreWorker";
import {
  filterProductsBySport,
  getProductSport,
  isProductSport,
  productSports,
  type ProductSport,
} from "@/lib/products";
import AuthGuard from "@/app/auth-guard";

type Product = {
  id: string;
  name: string;
  season: string;
  defaultPrice: number;
  currency: "CZK";
  active: boolean;
  imageUrl?: string;
  sport: ProductSport;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type ProductEditValue = {
  name: string;
  season: string;
  defaultPrice: string;
  active: boolean;
  imageUrl: string;
  sport: ProductSport;
};

type ProductFormValues = {
  name: string;
  season: string;
  defaultPrice: string;
  imageUrl: string;
  sport: ProductSport;
};

function createInitialFormValues(sport: ProductSport): ProductFormValues {
  return {
    name: "",
    season: "",
    defaultPrice: "",
    imageUrl: "",
    sport,
  };
}

function ProductsPageContent() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedSport, setSelectedSport] = useState<ProductSport>("NHL");
  const [formValues, setFormValues] = useState<ProductFormValues>(() => createInitialFormValues("NHL"));
  const [editingValues, setEditingValues] = useState<Record<string, ProductEditValue>>({});
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [isAddFormOpen, setIsAddFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingProductId, setSavingProductId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadProducts();
  }, []);

  async function loadProducts() {
    setLoading(true);
    setError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      const snapshot = await firestoreApi.getDocs(firestoreApi.collection(db, "products"));
      const loadedProducts = snapshot.docs
        .map((document) => {
          const data = document.data();
          const sport = getProductSport(data.sport);
          if (!sport) return null;
          return {
            id: document.id,
            ...(data as Omit<Product, "id" | "sport">),
            sport,
          } as Product;
        })
        .filter((product): product is Product => product !== null);

      setProducts(loadedProducts);
      setEditingValues(
        Object.fromEntries(
          loadedProducts.map((product) => [
            product.id,
            {
              name: product.name,
              season: product.season,
              defaultPrice: String(product.defaultPrice),
              active: product.active,
              imageUrl: product.imageUrl ?? "",
              sport: product.sport,
            },
          ]),
        ),
      );
    } catch (loadError) {
      console.error(loadError);
      setError("Nepodařilo se načíst boxy z Firestore.");
    } finally {
      setLoading(false);
    }
  }

  async function handleAddProduct(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const trimmedName = formValues.name.trim();
      const trimmedSeason = formValues.season.trim();
      const parsedPrice = Number(formValues.defaultPrice);

      if (!trimmedName || !trimmedSeason || Number.isNaN(parsedPrice) || parsedPrice < 0) {
        setError("Vyplňte název, sezónu a kladnou cenu.");
        return;
      }

      await callFirestoreWorker("product.create", {
        product: {
          name: trimmedName,
          season: trimmedSeason,
          defaultPrice: parsedPrice,
          active: true,
          imageUrl: formValues.imageUrl.trim() || null,
          sport: selectedSport,
        },
      });

      setFormValues(createInitialFormValues(selectedSport));
      setIsAddFormOpen(false);
      await loadProducts();
    } catch (addError) {
      console.error(addError);
      setError(addError instanceof Error ? addError.message : "Nepodařilo se přidat box.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveProduct(productId: string) {
    const currentValue = editingValues[productId];

    if (!currentValue) {
      return;
    }

    setSavingProductId(productId);
    setError(null);

    try {
      const trimmedName = currentValue.name.trim();
      const trimmedSeason = currentValue.season.trim();
      const parsedPrice = Number(currentValue.defaultPrice);

      if (!trimmedName || !trimmedSeason || Number.isNaN(parsedPrice) || parsedPrice < 0) {
        throw new Error("Název, sezóna a cena musí být vyplněny správně.");
      }

      await callFirestoreWorker("product.update", {
        productId,
        product: {
          name: trimmedName,
          season: trimmedSeason,
          defaultPrice: parsedPrice,
          active: currentValue.active,
          imageUrl: currentValue.imageUrl.trim() || null,
          sport: currentValue.sport,
        },
      });

      setEditingProductId(null);
      await loadProducts();
    } catch (saveError) {
      console.error(saveError);
      setError(saveError instanceof Error ? saveError.message : "Nepodařilo se uložit změny.");
    } finally {
      setSavingProductId(null);
    }
  }

  function updateEditingValue(productId: string, field: keyof ProductEditValue, value: string | boolean) {
    setEditingValues((current) => ({
      ...current,
      [productId]: {
        ...(current[productId] ?? {
          name: "",
          season: "",
          defaultPrice: "0",
          active: true,
          imageUrl: "",
          sport: "NHL" as const,
        }),
        [field]: value,
      } as ProductEditValue,
    }));
  }

  const visibleProducts = useMemo(
    () => filterProductsBySport(products, selectedSport),
    [products, selectedSport],
  );

  function handleSelectSport(sport: ProductSport) {
    setSelectedSport(sport);
    setFormValues((current) => ({ ...current, sport }));
    setEditingProductId(null);
  }

  return (
    <div className="min-h-screen text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="space-y-2">
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
                Správa boxů
              </p>
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Boxy
              </h1>
              <p className="text-sm leading-6 text-slate-400">
                Spravujte boxy podle sportu a jejich základní cenu pro budoucí drafty.
              </p>
            </div>

            <Link
              href="/rankings"
              className="inline-flex items-center gap-2 rounded-2xl border border-[#18C964]/30 bg-[#18C964]/10 px-4 py-2.5 text-xs font-bold text-[#8ef0b5] transition hover:bg-[#18C964]/20 self-start sm:self-auto"
            >
              <span>🏒 Žebříčky atraktivity týmů</span>
              <span>→</span>
            </Link>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Sport">
              {productSports.map((sport) => (
                <button
                  key={sport}
                  type="button"
                  role="tab"
                  id={`products-tab-${sport.toLowerCase()}`}
                  aria-selected={selectedSport === sport}
                  aria-controls="products-panel"
                  onClick={() => handleSelectSport(sport)}
                  className={`rounded-xl border px-4 py-2 text-sm font-bold transition ${
                    selectedSport === sport
                      ? "border-[#18C964]/50 bg-[#18C964]/15 text-[#8ef0b5]"
                      : "border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-white"
                  }`}
                >
                  {sport}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setFormValues(createInitialFormValues(selectedSport));
                setIsAddFormOpen((open) => !open);
              }}
              aria-expanded={isAddFormOpen}
              aria-controls="add-product-form"
              className="inline-flex items-center justify-center rounded-xl bg-[#18C964] px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-[#13b15a]"
            >
              + Přidat box
            </button>
          </div>

          {isAddFormOpen ? (
          <Card className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Přidat nový box · {selectedSport}</h2>
              <p className="text-xs text-slate-400">Box se uloží do kolekce products v Firestore.</p>
            </div>

            <form id="add-product-form" onSubmit={handleAddProduct} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="grid gap-2 text-sm font-medium text-slate-300">
                Název produktu
                <input
                  value={formValues.name}
                  onChange={(event) => setFormValues((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Premium Box"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-300">
                Sezóna
                <input
                  value={formValues.season}
                  onChange={(event) => setFormValues((current) => ({ ...current, season: event.target.value }))}
                  placeholder="25/26"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-300">
                Cena za box (Kč)
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={formValues.defaultPrice}
                  onChange={(event) => setFormValues((current) => ({ ...current, defaultPrice: event.target.value }))}
                  placeholder="2990"
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-slate-300 sm:col-span-2 lg:col-span-2">
                URL obrázku boxu
                <input
                  value={formValues.imageUrl}
                  onChange={(event) => setFormValues((current) => ({ ...current, imageUrl: event.target.value }))}
                  placeholder="https://..."
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-[44px] w-full items-center justify-center rounded-xl bg-[#18C964] px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submitting ? "Přidávám..." : "Uložit box"}
                </button>
              </div>
            </form>
          </Card>
          ) : null}

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 id="products-panel-title" className="text-lg font-semibold text-white">Uložené boxy · {selectedSport}</h2>
                <p className="text-xs text-slate-400">Úpravy ceny, sezóny, obrázku a aktivního stavu.</p>
              </div>
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            ) : null}

            {loading ? (
              <p className="text-sm text-slate-400">Načítám boxy z Firestore...</p>
            ) : visibleProducts.length === 0 ? (
              <p className="text-sm text-slate-400">Pro sport {selectedSport} zatím nejsou žádné boxy.</p>
            ) : (
              <div
                id="products-panel"
                role="tabpanel"
                aria-labelledby={`products-tab-${selectedSport.toLowerCase()}`}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              >
                {visibleProducts.map((product) => {
                  const currentValue = editingValues[product.id];
                  const isEditing = editingProductId === product.id;

                  return (
                    <div key={product.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                      {!isEditing ? (
                        <div className="flex gap-3">
                          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                            {product.imageUrl ? (
                              <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain" />
                            ) : (
                              <span className="text-[10px] text-slate-500">Bez obrázku</span>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-sm font-semibold text-white">{product.name}</h3>
                            <p className="mt-0.5 text-xs text-slate-400">{product.season}</p>
                            <p className="mt-1 text-sm font-bold text-[#8ef0b5]">
                              {Number(product.defaultPrice).toLocaleString("cs-CZ")} Kč
                            </p>
                            <div className="mt-2 flex items-center justify-between gap-2">
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                product.active
                                  ? "bg-[#18C964]/10 text-[#8ef0b5]"
                                  : "bg-slate-800 text-slate-400"
                              }`}>
                                {product.active ? "Aktivní" : "Neaktivní"}
                              </span>
                              <button
                                type="button"
                                onClick={() => setEditingProductId(product.id)}
                                className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:border-[#18C964]/50 hover:text-[#8ef0b5]"
                              >
                                Upravit
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="grid gap-2 text-sm font-medium text-slate-300">
                          Název
                          <input
                            value={currentValue?.name ?? product.name}
                            onChange={(event) => updateEditingValue(product.id, "name", event.target.value)}
                            className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                          />
                        </label>

                        <label className="grid gap-2 text-sm font-medium text-slate-300">
                          Sezóna
                          <input
                            value={currentValue?.season ?? product.season}
                            onChange={(event) => updateEditingValue(product.id, "season", event.target.value)}
                            className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                          />
                        </label>

                        <label className="grid gap-2 text-sm font-medium text-slate-300">
                          Cena (Kč)
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={currentValue?.defaultPrice ?? String(product.defaultPrice)}
                            onChange={(event) => updateEditingValue(product.id, "defaultPrice", event.target.value)}
                            className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                          />
                        </label>
                        <label className="grid gap-2 text-sm font-medium text-slate-300">
                          Sport
                          <select
                            value={currentValue?.sport ?? product.sport}
                            onChange={(event) => {
                              if (isProductSport(event.target.value)) {
                                updateEditingValue(product.id, "sport", event.target.value);
                              }
                            }}
                            className="rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 outline-none focus:border-[#18C964]/50"
                          >
                            {productSports.map((sport) => <option key={sport} value={sport}>{sport}</option>)}
                          </select>
                        </label>
                        <label className="inline-flex items-center gap-2 self-end pb-2 text-sm text-slate-300">
                          <input
                            type="checkbox"
                            checked={currentValue?.active ?? product.active}
                            onChange={(event) => updateEditingValue(product.id, "active", event.target.checked)}
                            className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-[#18C964] focus:ring-[#18C964]"
                          />
                          Aktivní
                        </label>
                      </div>

                      <label className="mt-3 grid gap-2 text-sm font-medium text-slate-300">
                        URL obrázku boxu
                        <input
                          value={currentValue?.imageUrl ?? product.imageUrl ?? ""}
                          onChange={(event) => updateEditingValue(product.id, "imageUrl", event.target.value)}
                          className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                        />
                      </label>

                      {currentValue?.imageUrl ? (
                        <div className="mt-3 flex h-20 items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                          <img src={currentValue.imageUrl} alt={currentValue.name || product.name} className="h-full object-contain" />
                        </div>
                      ) : null}

                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingProductId(null)}
                          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white"
                        >
                          Zrušit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSaveProduct(product.id)}
                          disabled={savingProductId === product.id}
                          className="rounded-lg bg-[#18C964] px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {savingProductId === product.id ? "Ukládám..." : "Uložit"}
                        </button>
                      </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}

export default function ProductsPage() {
  return (
    <AuthGuard>
      <ProductsPageContent />
    </AuthGuard>
  );
}
