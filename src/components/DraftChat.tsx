"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import type { Timestamp } from "firebase/firestore";
import { getFirebaseClient } from "@/lib/firebase";

type DraftChatProps = {
  draftId?: string | null;
  draftCode?: string | null;
  currentUser: User | null;
  currentUserRole: "admin" | "participant" | null;
  className?: string;
  isEmbedded?: boolean;
};

type DraftMessage = {
  id: string;
  userId: string;
  displayName: string;
  role: "admin" | "participant";
  text: string;
  createdAt?: Timestamp | { toDate: () => Date } | null;
};

function formatMessageTime(createdAt: DraftMessage["createdAt"]) {
  if (!createdAt) {
    return "";
  }

  if (typeof createdAt === "object" && "toDate" in createdAt && typeof createdAt.toDate === "function") {
    return new Intl.DateTimeFormat("cs-CZ", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(createdAt.toDate());
  }

  return "";
}

export function DraftChat({ draftId, draftCode, currentUser, currentUserRole, className = "", isEmbedded = false }: DraftChatProps) {
  const [resolvedDraftId, setResolvedDraftId] = useState<string | null>(draftId ?? null);
  const [messages, setMessages] = useState<DraftMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isLoadingMessages, setIsLoadingMessages] = useState(Boolean(draftId || draftCode));
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [isParticipantAssigned, setIsParticipantAssigned] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const isAdmin = currentUserRole === "admin";
  const isAuthorized = Boolean(currentUser && (isAdmin || isParticipantAssigned));

  useEffect(() => {
    let isMounted = true;

    async function resolveDraftId() {
      if (draftId) {
        setResolvedDraftId(draftId);
        setIsLoadingMessages(false);
        return;
      }

      if (!draftCode) {
        setResolvedDraftId(null);
        setIsLoadingMessages(false);
        return;
      }

      setIsLoadingMessages(true);
      setChatError(null);

      try {
        const { db, firestoreApi } = await getFirebaseClient();
        const draftQuery = firestoreApi.query(
          firestoreApi.collection(db, "drafts"),
          firestoreApi.where("code", "==", draftCode),
        );
        const snapshot = await firestoreApi.getDocs(draftQuery);
        const firstMatch = snapshot.docs[0];

        if (isMounted) {
          setResolvedDraftId(firstMatch?.id ?? null);
          setIsLoadingMessages(false);
        }
      } catch (resolveError) {
        console.error(resolveError);
        if (isMounted) {
          setResolvedDraftId(null);
          setIsLoadingMessages(false);
          setChatError("Nepodařilo se najít draft pro chat.");
        }
      }
    }

    void resolveDraftId();

    return () => {
      isMounted = false;
    };
  }, [draftCode, draftId]);

  useEffect(() => {
    if (!resolvedDraftId || !currentUser) {
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let isMounted = true;

    void (async () => {
      try {
        const { db, firestoreApi } = await getFirebaseClient();
        if (!isMounted) {
          return;
        }

        const draftRef = firestoreApi.doc(db, "drafts", resolvedDraftId);
        unsubscribe = firestoreApi.onSnapshot(
          draftRef,
          (snapshot) => {
            if (!snapshot.exists()) {
              setIsParticipantAssigned(false);
              return;
            }

            const data = snapshot.data() as { participants?: Array<{ userId?: string; uid?: string }> };
            const participants = data.participants ?? [];
            const isAssigned = participants.some((participant) => {
              const participantUid = participant.userId ?? participant.uid;
              return Boolean(participantUid && currentUser.uid && participantUid === currentUser.uid);
            });

            setIsParticipantAssigned(isAssigned);
          },
          (draftError) => {
            console.error(draftError);
            setChatError("Nepodařilo se načíst přístup k draftu.");
          },
        );
      } catch (draftError) {
        console.error(draftError);
        setChatError("Nepodařilo se načíst přístup k draftu.");
      }
    })();

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [currentUser, resolvedDraftId]);

  useEffect(() => {
    if (!resolvedDraftId) {
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let isMounted = true;

    void (async () => {
      try {
        const { db, firestoreApi } = await getFirebaseClient();
        if (!isMounted) {
          return;
        }

        const messagesRef = firestoreApi.collection(db, "drafts", resolvedDraftId, "messages");
        const messagesQuery = firestoreApi.query(messagesRef, firestoreApi.orderBy("createdAt", "asc"));

        unsubscribe = firestoreApi.onSnapshot(
          messagesQuery,
          (snapshot) => {
            const nextMessages = snapshot.docs
              .map((document) => {
                const data = document.data() as Partial<DraftMessage>;
                return {
                  id: document.id,
                  userId: data.userId ?? "",
                  displayName: data.displayName ?? "Uživatel",
                  role: data.role === "admin" ? "admin" : "participant",
                  text: data.text ?? "",
                  createdAt: data.createdAt,
                } satisfies DraftMessage;
              })
              .sort((left, right) => {
                const leftTime = left.createdAt && typeof left.createdAt === "object" && "toDate" in left.createdAt && typeof left.createdAt.toDate === "function"
                  ? left.createdAt.toDate().getTime()
                  : 0;
                const rightTime = right.createdAt && typeof right.createdAt === "object" && "toDate" in right.createdAt && typeof right.createdAt.toDate === "function"
                  ? right.createdAt.toDate().getTime()
                  : 0;
                return leftTime - rightTime;
              });

            setMessages(nextMessages);
            setIsLoadingMessages(false);
            setChatError(null);
          },
          (messagesError) => {
            console.error(messagesError);
            setIsLoadingMessages(false);
            setChatError("Nepodařilo se načíst zprávy chatu.");
          },
        );
      } catch (messagesError) {
        console.error(messagesError);
        setIsLoadingMessages(false);
        setChatError("Nepodařilo se načíst zprávy chatu.");
      }
    })();

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [resolvedDraftId]);

  useEffect(() => {
    if (!messages.length) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSendMessage(event?: FormEvent) {
    event?.preventDefault();

    if (!resolvedDraftId || !currentUser || !isAuthorized) {
      return;
    }

    const trimmedText = inputText.trim();
    if (!trimmedText) {
      setChatError("Zpráva nemůže být prázdná.");
      return;
    }

    if (trimmedText.length > 500) {
      setChatError("Maximální délka zprávy je 500 znaků.");
      return;
    }

    setIsSending(true);
    setChatError(null);

    try {
      const { db, firestoreApi } = await getFirebaseClient();
      await firestoreApi.addDoc(firestoreApi.collection(db, "drafts", resolvedDraftId, "messages"), {
        userId: currentUser.uid,
        displayName: currentUser.displayName?.trim() || currentUser.email?.split("@", 1)[0] || "Uživatel",
        role: currentUserRole === "admin" ? "admin" : "participant",
        text: trimmedText,
        createdAt: firestoreApi.serverTimestamp(),
      });

      setInputText("");
    } catch (sendError) {
      console.error(sendError);
      setChatError("Nepodařilo se odeslat zprávu.");
    } finally {
      setIsSending(false);
    }
  }

  const canSend = Boolean(currentUser && isAuthorized && !isLoadingMessages);

  if (!currentUser || !resolvedDraftId) {
    return null;
  }

  if (!isAuthorized) {
    return null;
  }

  const content = (
    <div className={`flex flex-col ${isEmbedded ? "h-full" : "h-[420px] rounded-2xl border border-slate-800 bg-slate-950/70"} overflow-hidden`}>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {isLoadingMessages ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            Načítám zprávy...
          </div>
        ) : messages.length > 0 ? (
          messages.map((message) => {
            const isOwnMessage = message.userId === currentUser.uid;
            return (
              <div key={message.id} className={`flex ${isOwnMessage ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl border px-3.5 py-2.5 shadow-sm ${
                    isOwnMessage
                      ? "border-[#18C964]/30 bg-[#18C964]/15 text-slate-100"
                      : "border-slate-800 bg-slate-900/90 text-slate-200"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <p className={`text-xs font-semibold ${isOwnMessage ? "text-[#8ef0b5]" : "text-slate-300"}`}>
                      {message.displayName}
                    </p>
                    {message.role === "admin" ? (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                        Admin
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-100">{message.text}</p>
                  <p className="mt-1.5 text-[10px] uppercase tracking-wider text-slate-400">
                    {formatMessageTime(message.createdAt)}
                  </p>
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-sm text-slate-400">
            <span className="text-2xl">💬</span>
            <p className="font-medium text-slate-300">Zatím žádné zprávy</p>
            <p className="text-xs text-slate-500">Buďte první a napište zprávu ostatním účastníkům.</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSendMessage} className="border-t border-slate-800/80 bg-slate-900/90 p-3">
        <label className="grid gap-1.5 text-xs font-medium text-slate-300">
          <div className="flex items-center justify-between">
            <span>Napsat zprávu</span>
            <span className="text-[11px] text-slate-500">{inputText.length}/500</span>
          </div>
          <textarea
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSendMessage();
              }
            }}
            placeholder="Napište zprávu (Enter pro odeslání)..."
            disabled={!canSend || isSending}
            maxLength={500}
            rows={2}
            className="w-full resize-none rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-[#18C964]/60 focus:ring-1 focus:ring-[#18C964]/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <div className="mt-2 flex items-center justify-end">
          <button
            type="submit"
            disabled={!canSend || isSending || !inputText.trim()}
            className="rounded-xl bg-[#18C964] px-4 py-1.5 text-xs font-bold text-slate-950 transition hover:bg-[#13b15a] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSending ? "Odesílám..." : "Odeslat"}
          </button>
        </div>
      </form>
    </div>
  );

  if (isEmbedded) {
    return (
      <div className={`flex flex-col ${className}`}>
        {chatError ? (
          <div className="mb-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {chatError}
          </div>
        ) : null}
        {content}
      </div>
    );
  }

  return (
    <div className={`rounded-[28px] border border-slate-800 bg-slate-900/90 p-4 shadow-2xl shadow-slate-950/60 sm:p-5 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-slate-500">Chat draftu</p>
          <h3 className="mt-1 text-xl font-semibold text-white">Komunikace</h3>
        </div>
        <div className="rounded-full border border-[#18C964]/20 bg-[#18C964]/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-[#8ef0b5]">
          {isAdmin ? "Admin" : "Účastník"}
        </div>
      </div>

      {chatError ? (
        <div className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {chatError}
        </div>
      ) : null}

      <div className="mt-4">{content}</div>
    </div>
  );
}
