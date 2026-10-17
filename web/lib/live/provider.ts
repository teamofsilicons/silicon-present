/**
 * The deck's live connection: a Yjs provider over the service's own HTTP API (no websockets, docs/architecture.md
 * "Live editing"), so it passes through the web kit's `/api/*` proxy like every other call.
 *
 *   down:  GET  /api/v1/decks/{id}/live?sv=<state vector>   server-sent events: sync, update, presence, presence_left,
 *                                                           comments, deck, ping
 *   up:    POST /api/v1/decks/{id}/updates   { update, session }      local changes, batched for ~40 ms
 *          POST /api/v1/decks/{id}/presence  { session, slide, selection, cursor }   throttled, 20 s heartbeat
 *
 * Nothing is lost when the connection drops: the doc lives in IndexedDB (y-indexeddb), and every (re)connect opens the
 * stream with this doc's state vector, gets what it lacks in `sync`, and sends back everything the service lacks
 * (`Y.encodeStateAsUpdate(doc, serverSv)`), so changes made offline, or before a reload, merge back in. The kit's proxy
 * ends any stream after 5 minutes; the provider reconnects at once, with the newer state vector.
 *
 * Remote changes are applied with a `RemoteOrigin` as the transaction origin, so the editor can tell who made a change
 * (and highlight it with their name) and the undo manager never tracks them.
 */
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { api } from "@/lib/client/api";
import { fromBase64, toBase64 } from "./base64";
import type { ConnectionStatus, DeckMetaEvent, LiveAccount, LiveCursor, PresenceState, SyncEvent, UpdateEvent } from "./types";

/** The origin of every change that came from the service. */
export class RemoteOrigin {
  constructor(
    readonly author: LiveAccount | null,
    readonly summary: string | null,
    readonly touched: string[],
    readonly kind: "sync" | "update",
  ) {}
}

/** The origin of every change made in this tab (the undo manager tracks only these). */
export const LOCAL_ORIGIN = Symbol.for("silicon-present.local");

export interface LocalPresence {
  slide: string | null;
  selection: string[];
  cursor: LiveCursor | null;
}

type Events = {
  status: (status: ConnectionStatus) => void;
  presence: (others: PresenceState[]) => void;
  comments: (payload: unknown) => void;
  deck: (meta: DeckMetaEvent) => void;
  version: (version: number) => void;
  /** The first sync with the service finished (the doc now holds the live deck). */
  synced: () => void;
  /** The service refused this tab's changes (the role changed): the editor turns read-only. */
  denied: () => void;
  /** The deck can no longer be reached (deleted, made private, access removed). */
  gone: (status: number) => void;
};

export interface LiveProviderOptions {
  deckId: string;
  doc: Y.Doc;
  /** Whether this tab may send changes (editors only; the service answers 403 to anyone else). */
  canEdit: boolean;
  /** Whether presence is sent (signed-in callers only: an anonymous viewer has nobody to show). */
  sendPresence: boolean;
  /** Keep the doc in IndexedDB (on by default). */
  persist?: boolean;
  /** Whose copy this is: each account keeps its own (a shared computer never mixes two people's unsent edits). */
  owner?: string | null;
  /** Where the service is reached from the browser (the kit's proxy). */
  base?: string;
}

const BATCH_MS = 40;
const PRESENCE_THROTTLE_MS = 90;
const HEARTBEAT_MS = 20_000;
const PRESENCE_EXPIRY_MS = 35_000;
const STALE_STREAM_MS = 50_000;
const OFFLINE_GRACE_MS = 1_500;

export class LiveProvider {
  readonly session: string;
  readonly deckId: string;
  readonly doc: Y.Doc;
  status: ConnectionStatus = "connecting";
  version = 0;
  synced = false;
  everSynced = false;

  private canEdit: boolean;
  private readonly sendPresence: boolean;
  private readonly base: string;
  private readonly idb: IndexeddbPersistence | null;
  private source: EventSource | null = null;
  private destroyed = false;
  private queue: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private retryMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: { [K in keyof Events]?: Set<Events[K]> } = {};
  private others = new Map<string, PresenceState>();
  private local: LocalPresence = { slide: null, selection: [], cursor: null };
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresenceSent = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(options: LiveProviderOptions) {
    this.deckId = options.deckId;
    this.doc = options.doc;
    this.canEdit = options.canEdit;
    this.sendPresence = options.sendPresence;
    this.base = options.base ?? "/api";
    this.session = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    this.idb = options.persist === false || typeof indexedDB === "undefined" ? null : new IndexeddbPersistence(`silicon-present:${options.deckId}:${options.owner ?? "anonymous"}`, this.doc);
    this.doc.on("update", this.onDocUpdate);
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
    }
    void this.start();
  }

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    const map = this.listeners as Record<string, Set<Events[K]> | undefined>;
    const set = (map[event] ??= new Set<Events[K]>());
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) {
    const set = this.listeners[event] as Set<(...a: Parameters<Events[K]>) => void> | undefined;
    set?.forEach(listener => listener(...args));
  }

  setCanEdit(canEdit: boolean) {
    this.canEdit = canEdit;
  }

  /** Who else is in the deck right now (never this tab). */
  presence(): PresenceState[] {
    return [...this.others.values()];
  }

  private setStatus(status: ConnectionStatus) {
    if (status === this.status) return;
    this.status = status;
    this.emit("status", status);
  }

  private async start() {
    // Load what this browser kept first, so the state vector we connect with covers offline edits from before a reload.
    if (this.idb) await Promise.race([this.idb.whenSynced, new Promise(resolve => setTimeout(resolve, 2_000))]);
    if (this.destroyed) return;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.source && this.synced && Date.now() - this.lastHeard > STALE_STREAM_MS) this.reconnectSoon(0);
      this.prunePresence();
    }, 5_000);
    if (this.sendPresence) this.heartbeat = setInterval(() => void this.postPresence(), HEARTBEAT_MS);
  }

  private connect() {
    if (this.destroyed) return;
    this.closeSource();
    const sv = toBase64(Y.encodeStateVector(this.doc));
    const source = new EventSource(`${this.base}/v1/decks/${encodeURIComponent(this.deckId)}/live?sv=${encodeURIComponent(sv)}${this.sendPresence ? `&session=${encodeURIComponent(this.session)}` : ""}`, { withCredentials: true });
    this.source = source;
    this.lastHeard = Date.now();
    const heard = () => {
      this.lastHeard = Date.now();
    };
    source.addEventListener("sync", event => {
      heard();
      this.onSync(JSON.parse((event as MessageEvent).data) as SyncEvent);
    });
    source.addEventListener("update", event => {
      heard();
      this.onUpdate(JSON.parse((event as MessageEvent).data) as UpdateEvent);
    });
    source.addEventListener("presence", event => {
      heard();
      this.onPresence(JSON.parse((event as MessageEvent).data) as Omit<PresenceState, "seenAt">);
    });
    source.addEventListener("presence_left", event => {
      heard();
      const { session } = JSON.parse((event as MessageEvent).data) as { session: string };
      if (this.others.delete(session)) this.emit("presence", this.presence());
    });
    source.addEventListener("comments", event => {
      heard();
      this.emit("comments", JSON.parse((event as MessageEvent).data));
    });
    source.addEventListener("deck", event => {
      heard();
      this.emit("deck", JSON.parse((event as MessageEvent).data) as DeckMetaEvent);
    });
    source.addEventListener("ping", heard);
    source.onerror = () => {
      // A normal end (the proxy's 5-minute limit) and a real failure look the same here: reconnect with the newer
      // state vector either way. A deck that can't be reached any more is found out by asking for it.
      if (this.source !== source) return;
      this.closeSource();
      this.synced = false;
      this.failures++;
      this.markOfflineSoon();
      if (this.failures >= 3) void this.checkReachable();
      this.reconnectSoon(this.failures === 1 ? 150 : this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
  }

  private closeSource() {
    if (this.source) {
      this.source.onerror = null;
      this.source.close();
      this.source = null;
    }
  }

  private markOfflineSoon() {
    if (this.offlineTimer) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (!this.synced) this.setStatus(this.everSynced ? "offline" : "connecting");
    }, OFFLINE_GRACE_MS);
  }

  private reconnectSoon(ms: number) {
    if (this.destroyed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, ms);
  }

  private async checkReachable() {
    try {
      const response = await fetch(`${this.base}/v1/decks/${encodeURIComponent(this.deckId)}`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      if (response.status === 403 || response.status === 404 || response.status === 410) {
        this.emit("gone", response.status);
        this.destroyed = true;
        this.closeSource();
      }
    } catch {
      // Offline: keep trying to reconnect.
    }
  }

  private onSync(event: SyncEvent) {
    const update = fromBase64(event.update);
    Y.applyUpdate(this.doc, update, new RemoteOrigin(null, null, [], "sync"));
    this.synced = true;
    this.everSynced = true;
    this.failures = 0;
    this.retryMs = 500;
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
    this.setVersion(event.version);
    // Everything the service lacks (offline edits, edits made before a reload) goes up in one update; it includes
    // whatever was queued, so the queue starts over.
    if (this.canEdit) {
      const missing = Y.encodeStateAsUpdate(this.doc, fromBase64(event.sv));
      this.queue = hasContent(missing) ? [missing] : [];
    } else {
      this.queue = [];
    }
    this.setStatus(this.queue.length ? "saving" : "live");
    if (this.queue.length) this.scheduleFlush(0);
    this.emit("synced");
    if (this.sendPresence) void this.postPresence();
  }

  private onUpdate(event: UpdateEvent) {
    Y.applyUpdate(this.doc, fromBase64(event.update), new RemoteOrigin(event.author ?? null, event.summary ?? null, event.touched ?? [], "update"));
    this.setVersion(event.version);
  }

  private setVersion(version: number | undefined) {
    if (typeof version !== "number" || version <= this.version) return;
    this.version = version;
    this.emit("version", version);
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin instanceof RemoteOrigin || (this.idb && origin === this.idb)) return;
    if (!this.canEdit) return;
    this.queue.push(update);
    if (this.synced) {
      this.setStatus("saving");
      this.scheduleFlush(BATCH_MS);
    }
  };

  private scheduleFlush(ms: number) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
  }

  /** Sends what is queued (one merged update). While the stream is down, the next sync sends it instead. */
  private async flush() {
    if (this.inflight || !this.synced || !this.queue.length || this.destroyed) return;
    const batch = this.queue.splice(0);
    const update = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    this.inflight = true;
    try {
      await api.post(`/v1/decks/${encodeURIComponent(this.deckId)}/updates`, { update: toBase64(update), session: this.session });
      this.retryMs = 500;
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      if (status === 403) {
        this.canEdit = false;
        this.queue = [];
        this.emit("denied");
      } else {
        // Keep it; it goes again (merged with anything newer) after a short wait, or with the next sync.
        this.queue.unshift(update);
        this.inflight = false;
        if (status === 0) this.markOfflineSoon();
        setTimeout(() => this.scheduleFlush(0), Math.min((this.retryMs *= 2), 10_000));
        return;
      }
    } finally {
      this.inflight = false;
    }
    if (this.queue.length) this.scheduleFlush(BATCH_MS);
    else if (this.synced) this.setStatus("live");
  }

  /** True when nothing typed here is still waiting to reach the service. */
  get idle(): boolean {
    return this.synced && !this.inflight && this.queue.length === 0;
  }

  /** Resolves once everything queued has been sent (or after `timeoutMs`). */
  async whenIdle(timeoutMs = 10_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.idle) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return this.idle;
  }

  // ---- presence ----

  setPresence(next: Partial<LocalPresence>) {
    this.local = { ...this.local, ...next };
    if (!this.sendPresence) return;
    const wait = Math.max(0, PRESENCE_THROTTLE_MS - (Date.now() - this.lastPresenceSent));
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      void this.postPresence();
    }, wait);
  }

  private async postPresence() {
    if (this.destroyed || !this.synced) return;
    this.lastPresenceSent = Date.now();
    try {
      await api.post(`/v1/decks/${encodeURIComponent(this.deckId)}/presence`, { session: this.session, ...this.local });
    } catch {
      // Presence is best effort; the heartbeat sends it again.
    }
  }

  private onPresence(event: Omit<PresenceState, "seenAt">) {
    if (!event || event.session === this.session) return;
    this.others.set(event.session, { ...event, selection: event.selection ?? [], seenAt: Date.now() });
    this.emit("presence", this.presence());
  }

  private prunePresence() {
    const now = Date.now();
    let changed = false;
    for (const [session, state] of this.others) {
      if (now - state.seenAt > PRESENCE_EXPIRY_MS) {
        this.others.delete(session);
        changed = true;
      }
    }
    if (changed) this.emit("presence", this.presence());
  }

  // ---- connectivity ----

  private onOnline = () => {
    this.retryMs = 500;
    this.reconnectSoon(0);
  };

  private onOffline = () => {
    this.closeSource();
    this.synced = false;
    this.setStatus("offline");
  };

  /** Drops the stream at once, as going offline would (tests and "work offline"). */
  disconnect() {
    this.onOffline();
  }

  destroy() {
    this.destroyed = true;
    this.closeSource();
    this.doc.off("update", this.onDocUpdate);
    for (const timer of [this.flushTimer, this.reconnectTimer, this.offlineTimer, this.presenceTimer]) if (timer) clearTimeout(timer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
    }
    // Leaving: the service drops this session's presence when its stream closes (the `session` on /live).
    void this.idb?.destroy();
  }
}

/** An empty Yjs update is two zero bytes (no structs, no deletes). */
function hasContent(update: Uint8Array): boolean {
  return update.length > 2 || update.some(byte => byte !== 0);
}
