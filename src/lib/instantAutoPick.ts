type Diagnostic = {
  event: string;
  turnKey: string;
  attempt: number;
  httpStatus?: number;
  result?: string;
  delayMs?: number;
  errorName?: string;
};

type AutoPickOptions = {
  draftId: string;
  currentPickIndex: number;
  turnKey: string;
  getIdToken: (forceRefresh: boolean) => Promise<string>;
  refreshDraft: (signal: AbortSignal) => Promise<void>;
  onMessage: (message: string) => void;
  log?: (diagnostic: Diagnostic) => void;
  request?: typeof fetch;
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

const RETRY_MESSAGE = "Automatický výběr se nezdařil. Pokus bude automaticky opakován.";
const WAITING_MESSAGE = "Výběr byl zpracován. Čekám na aktualizaci draftu…";

export function startInstantAutoPick(options: AutoPickOptions) {
  const request = options.request ?? fetch;
  const schedule = options.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  const lifecycle = new AbortController();
  const log = (event: string, details: Partial<Diagnostic> = {}) => {
    (options.log ?? ((diagnostic) => console.info("[autopick]", diagnostic)))({
      event,
      turnKey: options.turnKey,
      attempt,
      ...details,
    });
  };
  let attempt = 0;
  let forceRefresh = false;
  let tokenRefreshAttempted = false;
  let cancelTimer: (() => void) | undefined;
  let cancelRequest: (() => void) | undefined;

  function retry(delayMs: number, callback: () => void) {
    if (lifecycle.signal.aborted) return;
    log("retry-scheduled", { delayMs });
    cancelTimer = schedule(callback, delayMs);
  }

  async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let cancelTimeout: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      cancelRequest = () => {
        controller.abort();
        reject(new Error("AutoPickCancelled"));
      };
      cancelTimeout = schedule(() => {
        controller.abort();
        log("request-timeout");
        reject(new Error("AutoPickTimeout"));
      }, 10_000);
    });
    try {
      return await Promise.race([operation(controller.signal), aborted]);
    } finally {
      cancelTimeout?.();
      cancelRequest = undefined;
    }
  }

  async function reconcile() {
    if (lifecycle.signal.aborted) return;
    log("snapshot-missing");
    try {
      await withTimeout((signal) => options.refreshDraft(signal));
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      log("snapshot-refresh-failed", { errorName: error instanceof Error ? error.name : "Unknown" });
    }
    if (!lifecycle.signal.aborted) retry(2_000, () => void send());
  }

  async function send() {
    if (lifecycle.signal.aborted) return;
    attempt += 1;
    log("token-request");
    options.onMessage("Čas vypršel – probíhá automatický výběr…");
    try {
      const { response, body } = await withTimeout(async (signal) => {
        const token = await options.getIdToken(forceRefresh);
        if (signal.aborted) throw new Error("AutoPickCancelled");
        forceRefresh = false;
        log("request-sent");
        const response = await request("/api/draft/auto-pick", {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            draftId: options.draftId,
            currentPickIndex: options.currentPickIndex,
          }),
        });
        if (signal.aborted) throw new Error("AutoPickCancelled");
        log("response-headers", { httpStatus: response.status });
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          log("invalid-response-body", { httpStatus: response.status });
        }
        return { response, body };
      });
      if (lifecycle.signal.aborted) return;
      const result = typeof body === "object" && body !== null && "status" in body
        && typeof body.status === "string" ? body.status : "invalid-response";
      log(response.ok ? "response-received" : "request-rejected", {
        httpStatus: response.status,
        result,
      });
      if (response.status === 401 && !tokenRefreshAttempted) {
        tokenRefreshAttempted = true;
        forceRefresh = true;
        options.onMessage("Obnovuji přihlášení pro automatický výběr…");
        retry(1_000, () => void send());
        return;
      }
      if ([400, 401, 403, 404, 422].includes(response.status)) {
        options.onMessage(response.status === 401
          ? "Automatický výběr nemá platné přihlášení. Přihlaste se znovu."
          : response.status === 403
            ? "Nemáte oprávnění spustit automatický výběr. Záložní výběr zajišťuje server."
            : "Server odmítl automatický výběr. Záložní výběr zajišťuje server.");
        log("request-stopped", { httpStatus: response.status });
        return;
      }
      if (response.ok && ["picked", "completed", "changed"].includes(result)) {
        options.onMessage(WAITING_MESSAGE);
        log("awaiting-snapshot", { result });
        cancelTimer = schedule(() => void reconcile(), 3_000);
        return;
      }
      if (response.ok && result === "not-expired") {
        retry(1_000, () => void send());
        return;
      }
      options.onMessage(RETRY_MESSAGE);
      retry(Math.min(1_000 * 2 ** Math.min(attempt - 1, 4), 10_000), () => void send());
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      log("request-failed", { errorName: error instanceof Error ? error.name : "Unknown" });
      options.onMessage(RETRY_MESSAGE);
      retry(Math.min(1_000 * 2 ** Math.min(attempt - 1, 4), 10_000), () => void send());
    }
  }

  log("turn-expired");
  void send();
  return () => {
    lifecycle.abort();
    cancelTimer?.();
    cancelRequest?.();
    log("turn-disposed");
  };
}
