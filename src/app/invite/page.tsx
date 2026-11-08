"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/PageContainer";
import { Card } from "@/components/Card";
import { useAuth } from "@/components/AuthProvider";
import { callFirestoreWorker } from "@/lib/firestoreWorker";
import { clearAuthRedirect, setAuthRedirect } from "@/lib/authRedirect";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function subscribeToInvitationHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getInvitationHash() {
  return window.location.hash.slice(1);
}

type InvitationPreview = {
  status: "active" | "used" | "invalid";
  draftId?: string;
  draftTitle?: string;
  participants?: Array<{ id: string; name: string }>;
};

function getInvitationStatusMessage(status: InvitationPreview["status"]) {
  if (status === "used") return "Tato pozvánka už byla použita.";
  if (status === "invalid") return "Pozvánka je neplatná nebo byla zneplatněna administrátorem.";
  return null;
}

export default function InvitationPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const token = useSyncExternalStore(subscribeToInvitationHash, getInvitationHash, () => "");
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isLoadingInvite, setIsLoadingInvite] = useState(true);
  const [isClaiming, setIsClaiming] = useState(false);

  useEffect(() => {
    if (!token || !TOKEN_PATTERN.test(token) || loading) return;
    const invitationPath = `/invite#${token}`;

    if (!user) {
      setAuthRedirect(invitationPath);
      return;
    }

    clearAuthRedirect(invitationPath);
    let active = true;
    void callFirestoreWorker<InvitationPreview>("invite.preview", { token })
      .then((result) => {
        if (!active) return;
        setPreview(result);
        setMessage(getInvitationStatusMessage(result.status));
      })
      .catch((previewError) => {
        if (!active) return;
        setPreview({ status: "invalid" });
        setMessage(previewError instanceof Error
          ? previewError.message
          : "Pozvánku se nepodařilo ověřit. Zkuste to prosím znovu.",
        );
      })
      .finally(() => {
        if (active) setIsLoadingInvite(false);
      });

    return () => {
      active = false;
    };
  }, [loading, token, user]);

  async function handleClaimInvitation() {
    if (!token || !user || !preview || preview.status !== "active") return;
    setIsClaiming(true);
    setMessage(null);
    try {
      const result = await callFirestoreWorker<{
        status: "claimed" | "used" | "invalid";
        draftId?: string;
      }>("invite.claim", { token });
      if (result.status === "claimed") {
        if (!result.draftId) throw new Error("Server nevrátil identifikátor draftu.");
        setMessage("Pozice byly propojeny s vaším účtem.");
        router.replace(`/play/${encodeURIComponent(result.draftId)}`);
        return;
      }
      setPreview({ status: result.status });
      setMessage(getInvitationStatusMessage(result.status));
    } catch (claimError) {
      setMessage(claimError instanceof Error
        ? claimError.message
        : "Pozice se nepodařilo převzít. Zkuste to prosím znovu.",
      );
    } finally {
      setIsClaiming(false);
    }
  }

  const hasValidToken = TOKEN_PATTERN.test(token);
  const invitationPath = hasValidToken ? `/invite#${token}` : null;
  const isLoadingInvitation = loading || (Boolean(user) && isLoadingInvite);

  return (
    <div className="min-h-screen text-slate-100">
      <Navbar />
      <PageContainer className="py-8 lg:py-10">
        <div className="mx-auto max-w-2xl">
          <Card className="space-y-5">
            <p className="text-sm font-medium uppercase tracking-[0.28em] text-[#18C964]">Osobní pozvánka</p>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Připojit připravené pozice</h1>

            {!hasValidToken ? (
              <p role="alert" className="text-sm text-red-300">Odkaz pozvánky není platný.</p>
            ) : isLoadingInvitation ? (
              <p role="status" className="text-sm text-slate-400">Ověřuji pozvánku...</p>
            ) : !user ? (
              <div className="space-y-4">
                <p className="text-sm text-slate-300">Pro zobrazení a převzetí pozic se přihlaste nebo si vytvořte účet.</p>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href="/login"
                    onClick={() => invitationPath && setAuthRedirect(invitationPath)}
                    className="rounded-xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950"
                  >
                    Přihlásit se
                  </Link>
                  <Link
                    href="/register"
                    onClick={() => invitationPath && setAuthRedirect(invitationPath)}
                    className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200"
                  >
                    Vytvořit účet
                  </Link>
                </div>
              </div>
            ) : preview?.status === "active" ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-slate-400">Draft</p>
                  <p className="font-semibold text-white">{preview.draftTitle}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-slate-300">Připravené pozice:</p>
                  <ul className="list-inside list-disc space-y-1 text-slate-200">
                    {(preview.participants ?? []).map((participant) => (
                      <li key={participant.id}>{participant.name}</li>
                    ))}
                  </ul>
                </div>
                <button
                  type="button"
                  onClick={() => void handleClaimInvitation()}
                  disabled={isClaiming}
                  className="rounded-xl bg-[#18C964] px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isClaiming ? "Přebírám pozice..." : "Potvrdit převzetí pozic"}
                </button>
              </div>
            ) : (
              <p role="alert" className="text-sm text-red-300">
                {message ?? getInvitationStatusMessage(preview?.status ?? "invalid")}
              </p>
            )}

            {message && preview?.status === "active" ? (
              <p role="status" className="text-sm text-slate-300">{message}</p>
            ) : null}
            {invitationPath && !user ? (
              <p className="text-xs text-slate-500">Po přihlášení se vrátíte zpět k této pozvánce.</p>
            ) : null}
          </Card>
        </div>
      </PageContainer>
    </div>
  );
}
