/** One receiver per mounted library view. Hints are lossy; reconcile after ready
 * and periodically, and never retain Ting's ephemeral session address. */
export function watchLibrary(refresh: () => void): () => void {
  let stopped = false;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let readyAt = 0;

  const reconcile = () => {
    if (stopped || document.hidden || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; if (!stopped && !document.hidden) refresh(); }, 150);
  };
  const disconnect = () => {
    source?.close(); source = null;
    clearTimeout(retry); retry = undefined;
  };
  const connect = () => {
    if (stopped || document.hidden || source) return;
    const current = new EventSource("/api/v1/library/events", { withCredentials: true });
    source = current;
    readyAt = 0;
    current.addEventListener("ready", () => {
      if (source !== current) return;
      readyAt = Date.now();
      reconcile();
    });
    current.addEventListener("library", () => { if (source === current) reconcile(); });
    current.onerror = () => {
      if (source !== current) return;
      disconnect();
      if (readyAt && Date.now() - readyAt >= 60_000) failures = 0;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5) * (1 + Math.random() * 0.2));
      retry = setTimeout(connect, delay);
    };
  };
  const visibility = () => {
    if (document.hidden) disconnect();
    else { reconcile(); connect(); }
  };
  // Covers missed notifications, disabled Ting and mutations during disconnect.
  const poll = setInterval(reconcile, 30_000);
  document.addEventListener("visibilitychange", visibility);
  connect();
  return () => {
    stopped = true;
    disconnect();
    clearTimeout(refreshTimer);
    clearInterval(poll);
    document.removeEventListener("visibilitychange", visibility);
  };
}
