"use client";

import { FormEvent, useEffect, useState } from "react";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { getFirebaseClient } from "@/lib/firebase";
import AuthGuard from "@/app/auth-guard";

type Product = {
  id: string;
  name: string;
  season: string;
  defaultPrice: number;
  currency: "CZK";
  active: boolean;
  imageUrl?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type ProductEditValue = {
  name: string;
  season: string;
  defaultPrice: string;
  active: boolean;
  imageUrl: string;
};

type ProductFormValues = {
  name: string;
  season: string;
  defaultPrice: string;
  imageUrl: string;
};

const initialFormValues: ProductFormValues = {
  name: "",
  season: "",
  defaultPrice: "",
  imageUrl: "",
};

function ProductsPageContent() {
  const [products, setProducts] = useState<Product[]>([]);
  const [formValues, setFormValues] = useState<ProductFormValues>(initialFormValues);
  const [editingValues, setEditingValues] = useState<Record<string, ProductEditValue>>({});
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
      const loadedProducts = snapshot.docs.map((document) => ({
        id: document.id,
        ...(document.data() as Omit<Product, "id">),
      })) as Product[];

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
      const { db, firestoreApi } = await getFirebaseClient();
      const trimmedName = formValues.name.trim();
      const trimmedSeason = formValues.season.trim();
      const parsedPrice = Number(formValues.defaultPrice);

      if (!trimmedName || !trimmedSeason || Number.isNaN(parsedPrice) || parsedPrice < 0) {
        setError("Vyplňte název, sezónu a kladnou cenu.");
        return;
      }

      await firestoreApi.addDoc(firestoreApi.collection(db, "products"), {
        name: trimmedName,
        season: trimmedSeason,
        defaultPrice: parsedPrice,
        currency: "CZK",
        active: true,
        imageUrl: formValues.imageUrl.trim() || null,
        createdAt: firestoreApi.serverTimestamp(),
        updatedAt: firestoreApi.serverTimestamp(),
      });

      setFormValues(initialFormValues);
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
      const { db, firestoreApi } = await getFirebaseClient();
      const trimmedName = currentValue.name.trim();
      const trimmedSeason = currentValue.season.trim();
      const parsedPrice = Number(currentValue.defaultPrice);

      if (!trimmedName || !trimmedSeason || Number.isNaN(parsedPrice) || parsedPrice < 0) {
        throw new Error("Název, sezóna a cena musí být vyplněny správně.");
      }

      await firestoreApi.updateDoc(firestoreApi.doc(db, "products", productId), {
        name: trimmedName,
        season: trimmedSeason,
        defaultPrice: parsedPrice,
        currency: "CZK",
        active: currentValue.active,
        imageUrl: currentValue.imageUrl.trim() || null,
        updatedAt: firestoreApi.serverTimestamp(),
      });

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
        ...(current[productId] ?? { name: "", season: "", defaultPrice: "0", active: true, imageUrl: "" }),
        [field]: value,
      } as ProductEditValue,
    }));
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
          <div className="space-y-3">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">
              Správa boxů
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Boxy
            </h1>
            <p className="text-lg leading-8 text-slate-400">
              Vytvářejte nové produkty a spravujte jejich základní cenu pro budoucí drafty.
            </p>
          </div>

          <Card className="space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold text-white">Přidat nový box</h2>
              <p className="text-sm text-slate-400">
                Každý box je uložen do kolekce products v Firestore.
              </p>
            </div>

            <form onSubmit={handleAddProduct} className="grid gap-4 md:grid-cols-[1.5fr_1fr_1fr_auto] md:items-end">
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

              <label className="grid gap-2 text-sm font-medium text-slate-300 md:col-span-2">
                URL obrázku boxu
                <input
                  value={formValues.imageUrl}
                  onChange={(event) => setFormValues((current) => ({ ...current, imageUrl: event.target.value }))}
                  placeholder="https://..."
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                />
              </label>

              <button
                type="submit"
                disabled={submitting}
                className="inline-flex h-[48px] items-center justify-center rounded-2xl bg-[#18C964] px-5 py-3 text-sm font-semibold text-slate-950 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#13b15a] hover:shadow-lg hover:shadow-[#18C964]/25 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {submitting ? "Přidávám..." : "Přidat box"}
              </button>
            </form>
          </Card>

          <Card className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-white">Uložené boxy</h2>
                <p className="text-sm text-slate-400">Zde můžete upravit data a aktivovat nebo deaktivovat box.</p>
              </div>
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            ) : null}

            {loading ? (
              <p className="text-sm text-slate-400">Načítám boxy z Firestore...</p>
            ) : products.length === 0 ? (
              <p className="text-sm text-slate-400">Zatím zde nejsou žádné boxy.</p>
            ) : (
              <div className="space-y-4">
                {products.map((product) => {
                  const currentValue = editingValues[product.id];

                  return (
                    <div key={product.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
                      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="text-sm font-medium uppercase tracking-[0.24em] text-slate-500">
                            {product.season}
                          </p>
                          <h3 className="mt-1 text-xl font-semibold text-white">{product.name}</h3>
                        </div>

                        <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                          <input
                            type="checkbox"
                            checked={currentValue?.active ?? product.active}
                            onChange={(event) => updateEditingValue(product.id, "active", event.target.checked)}
                            className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-[#18C964] focus:ring-[#18C964]"
                          />
                          Aktivní
                        </label>
                      </div>

                      <div className="mt-4 grid gap-4 md:grid-cols-3">
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
                      </div>

                      <label className="mt-4 grid gap-2 text-sm font-medium text-slate-300">
                        URL obrázku boxu
                        <input
                          value={currentValue?.imageUrl ?? product.imageUrl ?? ""}
                          onChange={(event) => updateEditingValue(product.id, "imageUrl", event.target.value)}
                          className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-slate-100 outline-none transition focus:border-[#18C964]/50"
                        />
                      </label>

                      {product.imageUrl ? (
                        <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800">
                          <img src={product.imageUrl} alt={product.name} className="h-40 w-full object-cover" />
                        </div>
                      ) : null}

                      <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <p className="text-sm text-slate-500">
                          Výchozí cena produktu se uloží jako samostatná hodnota a nebude automaticky měnit ceny v existujících draftů.
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleSaveProduct(product.id)}
                          disabled={savingProductId === product.id}
                          className="inline-flex items-center justify-center rounded-2xl bg-[#18C964] px-5 py-3 text-sm font-semibold text-slate-950 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#13b15a] hover:shadow-lg hover:shadow-[#18C964]/25 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {savingProductId === product.id ? "Ukládám..." : "Uložit změny"}
                        </button>
                      </div>
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
