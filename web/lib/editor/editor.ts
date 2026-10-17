/**
 * The editor's hub: the Y.Doc, the live connection, the JSON mirror, the undo manager, the UI state, and every action
 * the toolbar, the canvas, the slide strip and the keyboard can take. Each action that changes the deck is one local
 * transaction (one undo step, one live update), built on @silicon-present/deck's helpers, which run the same edit ops
 * the service runs for Silicons.
 */
import * as Y from "yjs";
import {
  MASTER,
  addElement as addElementHelper,
  addSlide as addSlideHelper,
  alignElements,
  deckMap,
  deleteElements,
  deleteSlide,
  distributeElements,
  docToJson,
  duplicateElements,
  duplicateSlide,
  getTextField,
  groupElements,
  groupMembers,
  moveSlide,
  newGroupId,
  orderArray,
  reorderElement,
  replaceInDeck,
  setTheme,
  slidesMap,
  ungroup,
  updateElements,
  updateSlide,
  type AlignMode,
  type DeckJson,
  type Element,
  type ElementInput,
  type Slide,
  type Theme,
} from "@silicon-present/deck";
import { api } from "@/lib/client/api";
import { ApiError } from "@/lib/errors";
import { notify, notifyError } from "@/lib/notify";
import { LiveProvider, LOCAL_ORIGIN } from "@/lib/live/provider";
import type { ConnectionStatus, PresenceState } from "@/lib/live/types";
import { DeckMirror, type RemoteTouch } from "./mirror";
import { createStore, type Store } from "./store";
import type { Guide } from "./geometry";
import type { DeckMeta, Me, Thread } from "./types";
import { readThread, readThreads } from "./normalize-api";
import type { Anchor } from "./types";

export type RightPanel = "design" | "animate" | "theme" | "comments";

export interface Composer {
  anchor: Anchor;
  /** Where to open the box, in slide px (null for deck/slide comments opened from the list). */
  at: { x: number; y: number } | null;
}

export interface UiState {
  slideId: string | null;
  master: boolean;
  selection: string[];
  editing: { elementId: string; field: string } | null;
  zoom: "fit" | number;
  /** The scale that fits the slide in the window (the canvas measures it). */
  fitScale: number;
  panel: RightPanel;
  panelOpen: boolean;
  commentMode: boolean;
  composer: Composer | null;
  activeThread: string | null;
  showResolved: boolean;
  findOpen: boolean;
  shortcutsOpen: boolean;
  codeElement: string | null;
  guides: Guide[];
  snap: boolean;
  grid: boolean;
  /** Elements being dragged/resized/rotated: their live boxes (not yet written to the doc). */
  preview: Record<string, { x: number; y: number; w: number; h: number; rotation: number }> | null;
  /** Elements with a find match to highlight, and the current one. */
  findHits: { slide: string; element: string | null; field: string }[];
}

/** What the text toolbar needs from the rich text editor that has the caret. */
export interface TextEditorHandle {
  format(name: string, value: unknown): void;
  getFormat(): Record<string, unknown>;
  focus(): void;
  /** The selected passage as a comment anchor (null when nothing is selected). */
  selectionAnchor(): Anchor | null;
}

export interface EditorOptions {
  deckId: string;
  meta: DeckMeta;
  me: Me | null;
  /** Initial slide (from the URL's ?slide=). */
  slide?: string | null;
  /** A thread to open (from the URL's ?thread=, the link every ting carries). */
  thread?: string | null;
}

const CLIPBOARD_KEY = "silicon-present:clipboard";

interface ClipboardPayload {
  kind: "silicon-present/elements";
  deck: string;
  at: number;
  elements: Element[];
}

export class Editor {
  readonly deckId: string;
  readonly doc: Y.Doc;
  readonly provider: LiveProvider;
  readonly mirror: DeckMirror;
  readonly undoManager: Y.UndoManager;
  readonly ui: Store<UiState>;
  readonly meta: Store<DeckMeta>;
  readonly status: Store<{ status: ConnectionStatus; synced: boolean; version: number }>;
  readonly presence: Store<{ others: PresenceState[] }>;
  readonly touches: Store<{ list: RemoteTouch[] }>;
  readonly threads: Store<{ list: Thread[]; loaded: boolean }>;
  /** The rich text editor that has the caret (for the text toolbar), and the formats at the caret. */
  readonly textUi: Store<{ quill: TextEditorHandle | null; formats: Record<string, unknown> }>;
  readonly me: Me | null;
  private cleanup: (() => void)[] = [];

  constructor(options: EditorOptions) {
    this.deckId = options.deckId;
    this.me = options.me;
    this.doc = new Y.Doc();
    this.meta = createStore(options.meta);
    this.ui = createStore<UiState>({
      slideId: options.slide ?? null,
      master: false,
      selection: [],
      editing: null,
      zoom: "fit",
      fitScale: 0.5,
      panel: "design",
      panelOpen: true,
      commentMode: false,
      composer: null,
      activeThread: null,
      showResolved: false,
      findOpen: false,
      shortcutsOpen: false,
      codeElement: null,
      guides: [],
      snap: true,
      grid: false,
      preview: null,
      findHits: [],
    });
    this.status = createStore<{ status: ConnectionStatus; synced: boolean; version: number }>({ status: "connecting", synced: false, version: 0 });
    this.presence = createStore({ others: [] as PresenceState[] });
    this.touches = createStore({ list: [] as RemoteTouch[] });
    this.threads = createStore<{ list: Thread[]; loaded: boolean }>({ list: [], loaded: false });
    this.textUi = createStore<{ quill: TextEditorHandle | null; formats: Record<string, unknown> }>({ quill: null, formats: {} });
    this.mirror = new DeckMirror(this.doc);
    this.undoManager = new Y.UndoManager([slidesMap(this.doc), orderArray(this.doc), deckMap(this.doc)], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 450,
    });
    this.provider = new LiveProvider({ deckId: this.deckId, doc: this.doc, canEdit: this.canEdit, sendPresence: Boolean(this.me), owner: this.me?.uuid ?? null });
    this.cleanup.push(
      this.provider.on("status", status => this.status.set({ status })),
      this.provider.on("synced", () => {
        this.status.set({ synced: true });
        this.ensureSlide();
      }),
      this.provider.on("version", version => this.status.set({ version })),
      this.provider.on("presence", others => this.presence.set({ others })),
      this.provider.on("comments", payload => this.onThreadEvent(payload)),
      this.provider.on("deck", meta => {
        if (typeof meta.title === "string") this.meta.set({ title: meta.title });
        const mode = (meta as { publicMode?: string }).publicMode;
        if (mode === "off" || mode === "view" || mode === "comment" || mode === "edit") this.meta.set({ publicMode: mode });
        const role = (meta as { role?: string }).role;
        if (role) this.meta.set({ role: role as DeckMeta["role"] });
      }),
      this.provider.on("denied", () => {
        this.meta.set({ role: "viewer" });
        notify.warning("Your changes were not saved", "You can no longer edit this deck. Ask its owner for edit access, then reload.");
      }),
      this.provider.on("gone", status => {
        notify.warning(status === 404 ? "This deck is gone" : "You can no longer open this deck", status === 404 ? "It was deleted or made private. Your copy stays on this page until you leave." : "Your access was removed. Ask its owner to share it again.",);
      }),
      this.mirror.subscribe(() => this.ensureSlide()),
      this.mirror.onRemote(touches => this.onRemoteTouches(touches)),
    );
    const onStackChange = () => this.pruneSelection();
    this.undoManager.on("stack-item-popped", onStackChange);
    this.cleanup.push(() => this.undoManager.off("stack-item-popped", onStackChange));
    void this.loadThreads().then(() => {
      if (options.thread) this.openThread(options.thread);
    });
  }

  /** Opens a thread: its slide, the comments list, the thread itself. */
  openThread(id: string) {
    const thread = this.threads.get().list.find(t => t.id === id);
    if (!thread) return;
    const slide = thread.anchor.kind === "deck" ? null : thread.anchor.slide;
    const go = () => {
      // Read the doc itself: the JSON mirror catches up a moment after a sync.
      if (slide && slide !== MASTER && orderArray(this.doc).toArray().includes(slide)) this.goToSlide(slide);
      this.ui.set({ activeThread: id, panel: "comments", panelOpen: true });
    };
    // The deck may still be on its way: go once it has arrived.
    if (this.status.get().synced) go();
    else {
      const stop = this.provider.on("synced", () => {
        stop();
        go();
      });
    }
  }

  /** Whether changes made here have not reached the service yet. */
  get unsent(): boolean {
    return this.canEdit && !this.provider.idle;
  }

  destroy() {
    this.cleanup.forEach(fn => fn());
    this.provider.destroy();
    this.mirror.destroy();
    this.undoManager.destroy();
    this.doc.destroy();
  }

  // ---- roles ----

  get role() {
    return this.meta.get().role;
  }

  get canEdit(): boolean {
    const { role, publicMode } = this.meta.get();
    if (!this.me) return false;
    return role === "owner" || role === "editor" || publicMode === "edit";
  }

  get canComment(): boolean {
    const { role, publicMode } = this.meta.get();
    if (!this.me) return false;
    return this.canEdit || role === "commenter" || publicMode === "comment";
  }

  /** Whether a signed-out visitor could comment (or edit) after signing in. */
  get signInToComment(): boolean {
    const { publicMode } = this.meta.get();
    return !this.me && (publicMode === "comment" || publicMode === "edit");
  }

  // ---- reading ----

  deck(): DeckJson {
    return this.mirror.get();
  }

  currentSlide(): (Slide & { isMaster?: boolean }) | null {
    const { slideId, master } = this.ui.get();
    const deck = this.deck();
    if (master) return { id: MASTER, layout: "blank", background: null, skipped: false, section: null, hideMaster: true, transition: null, notes: "", elements: deck.master.elements, isMaster: true };
    return deck.slides.find(slide => slide.id === slideId) ?? deck.slides[0] ?? null;
  }

  currentSlideId(): string | null {
    return this.currentSlide()?.id ?? null;
  }

  selectedElements(): Element[] {
    const slide = this.currentSlide();
    const ids = new Set(this.ui.get().selection);
    return slide ? slide.elements.filter(element => ids.has(element.id)) : [];
  }

  private ensureSlide() {
    const { slideId, master } = this.ui.get();
    if (master) return;
    const slides = this.deck().slides;
    if (!slides.length) return;
    if (!slideId || !slides.some(slide => slide.id === slideId)) this.goToSlide(slides[0]!.id);
  }

  private pruneSelection() {
    const slide = this.currentSlide();
    if (!slide) return;
    const ids = new Set(slide.elements.map(element => element.id));
    const { selection, editing } = this.ui.get();
    const kept = selection.filter(id => ids.has(id));
    if (kept.length !== selection.length) this.ui.set({ selection: kept });
    if (editing && !ids.has(editing.elementId)) this.ui.set({ editing: null });
  }

  // ---- transactions ----

  /** Runs a change as one local transaction; deck errors become a toast with the message and hint. */
  change<T>(fn: () => T, what = "That change"): T | undefined {
    if (!this.canEdit) {
      notify.info("This deck is read-only for you", "Ask its owner for edit access.");
      return undefined;
    }
    try {
      let out: T | undefined;
      this.doc.transact(() => {
        out = fn();
      }, LOCAL_ORIGIN);
      return out;
    } catch (error) {
      const e = error as { message?: string; hint?: string };
      notify.warning(`${what} could not be made`, [e.message, e.hint].filter(Boolean).join(" "));
      return undefined;
    }
  }

  /** Ends the current undo step, so the next change is undone on its own. */
  stopCapturing() {
    this.undoManager.stopCapturing();
  }

  undo() {
    if (!this.canEdit) return;
    this.undoManager.undo();
  }

  redo() {
    if (!this.canEdit) return;
    this.undoManager.redo();
  }

  // ---- navigation and selection ----

  goToSlide(slideId: string) {
    this.ui.set({ slideId, master: false, selection: [], editing: null, codeElement: null });
    this.provider.setPresence({ slide: slideId, selection: [] });
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("slide", slideId);
      window.history.replaceState(window.history.state, "", url);
    }
  }

  stepSlide(delta: number) {
    const slides = this.deck().slides;
    const index = slides.findIndex(slide => slide.id === this.currentSlideId());
    const next = slides[Math.max(0, Math.min(slides.length - 1, index + delta))];
    if (next) this.goToSlide(next.id);
  }

  setMaster(master: boolean) {
    this.ui.set({ master, selection: [], editing: null });
    this.provider.setPresence({ slide: master ? MASTER : this.ui.get().slideId, selection: [] });
  }

  select(ids: string[], mode: "replace" | "toggle" | "add" = "replace") {
    const slide = this.currentSlide();
    if (!slide) return;
    // Clicking one member of a group picks the whole group.
    const expanded = new Set<string>();
    for (const id of ids) {
      const members = groupMembers(slide, id);
      // An element made a moment ago may not be in the JSON mirror yet: keep it as it is.
      for (const member of members.length ? members : [id]) expanded.add(member);
    }
    const current = new Set(this.ui.get().selection);
    let next: string[];
    if (mode === "replace") next = [...expanded];
    else if (mode === "add") next = [...new Set([...current, ...expanded])];
    else {
      const allIn = [...expanded].every(id => current.has(id));
      for (const id of expanded) {
        if (allIn) current.delete(id);
        else current.add(id);
      }
      next = [...current];
    }
    const editing = this.ui.get().editing;
    this.ui.set({ selection: next, editing: editing && next.includes(editing.elementId) ? editing : null });
    this.provider.setPresence({ selection: next });
  }

  /** Selects one element even when it is in a group (a second click on a grouped element). */
  selectOnly(id: string) {
    this.ui.set({ selection: [id] });
    this.provider.setPresence({ selection: [id] });
  }

  clearSelection() {
    this.ui.set({ selection: [], editing: null });
    this.provider.setPresence({ selection: [] });
  }

  selectAll() {
    const slide = this.currentSlide();
    if (slide) this.select(slide.elements.map(element => element.id));
  }

  startEditing(elementId: string, field = "text") {
    if (!this.canEdit) return;
    const element = this.currentSlide()?.elements.find(e => e.id === elementId);
    if (!element || element.locked) return;
    this.ui.set({ editing: { elementId, field }, selection: [elementId] });
  }

  stopEditing() {
    if (this.ui.get().editing) {
      this.ui.set({ editing: null });
      this.stopCapturing();
    }
  }

  // ---- slides ----

  addSlide(layout = "title-body", after?: string | null) {
    const at = after === undefined ? this.currentSlideId() : after;
    const id = this.change(() => addSlideHelper(this.doc, { layout }, { after: at === MASTER ? undefined : at, origin: LOCAL_ORIGIN }), "The slide");
    if (id) this.goToSlide(id);
    return id;
  }

  duplicateSlide(slideId: string) {
    const id = this.change(() => duplicateSlide(this.doc, slideId, LOCAL_ORIGIN), "The copy");
    if (id) this.goToSlide(id);
  }

  deleteSlides(ids: string[]) {
    const slides = this.deck().slides;
    if (ids.length >= slides.length) {
      notify.info("A deck keeps at least one slide", "Add another slide first, then delete this one.");
      return;
    }
    const index = slides.findIndex(slide => slide.id === this.currentSlideId());
    this.change(() => ids.forEach(id => deleteSlide(this.doc, id, LOCAL_ORIGIN)), "Deleting the slide");
    const remaining = this.deck().slides;
    const next = remaining[Math.min(Math.max(0, index), remaining.length - 1)];
    if (next) this.goToSlide(next.id);
  }

  moveSlide(slideId: string, after: string | null) {
    this.change(() => moveSlide(this.doc, slideId, after, LOCAL_ORIGIN), "Moving the slide");
  }

  updateSlide(slideId: string, set: Parameters<typeof updateSlide>[2]) {
    this.change(() => updateSlide(this.doc, slideId, set, LOCAL_ORIGIN), "Changing the slide");
  }

  setTheme(theme: Theme) {
    this.change(() => setTheme(this.doc, theme, LOCAL_ORIGIN), "Changing the theme");
  }

  // ---- elements ----

  addElement(input: ElementInput, opts: { select?: boolean; edit?: boolean } = {}): string | undefined {
    const slideId = this.currentSlideId();
    if (!slideId) return undefined;
    const id = this.change(() => addElementHelper(this.doc, slideId, input, undefined, LOCAL_ORIGIN), "Adding the element");
    this.stopCapturing();
    if (id && opts.select !== false) {
      this.ui.set({ selection: [id], panelOpen: true, panel: "design" });
      this.provider.setPresence({ selection: [id] });
      if (opts.edit) queueMicrotask(() => this.startEditing(id));
    }
    return id;
  }

  updateElement(id: string, set: Record<string, unknown>) {
    this.updateElements([{ id, set }]);
  }

  updateElements(changes: { id: string; set: Record<string, unknown> }[]) {
    const slideId = this.currentSlideId();
    if (!slideId || !changes.length) return;
    this.change(() => updateElements(this.doc, slideId, changes, LOCAL_ORIGIN), "Changing the element");
  }

  /** Changes a field of every selected element's style (style is replaced whole, so merge here). */
  setStyle(patch: Record<string, unknown>) {
    const changes = this.selectedElements().map(element => ({ id: element.id, set: { style: clean({ ...element.style, ...patch }) } }));
    this.updateElements(changes);
  }

  deleteSelection() {
    const slideId = this.currentSlideId();
    const ids = this.selectedElements().filter(element => !element.locked).map(element => element.id);
    if (!slideId || !ids.length) return;
    this.change(() => deleteElements(this.doc, slideId, ids, LOCAL_ORIGIN), "Deleting");
    this.clearSelection();
  }

  duplicateSelection() {
    const slideId = this.currentSlideId();
    const ids = this.ui.get().selection;
    if (!slideId || !ids.length) return;
    const created = this.change(() => duplicateElements(this.doc, slideId, ids, { origin: LOCAL_ORIGIN }), "Duplicating");
    if (created) this.ui.set({ selection: created });
  }

  nudge(dx: number, dy: number) {
    const changes = this.selectedElements()
      .filter(element => !element.locked)
      .map(element => ({ id: element.id, set: { x: element.x + dx, y: element.y + dy } }));
    this.updateElements(changes);
  }

  group() {
    const slideId = this.currentSlideId();
    const ids = this.ui.get().selection;
    if (!slideId || ids.length < 2) return;
    this.change(() => groupElements(this.doc, slideId, ids, LOCAL_ORIGIN), "Grouping");
  }

  ungroup() {
    const slideId = this.currentSlideId();
    const ids = this.ui.get().selection;
    if (!slideId || !ids.length) return;
    this.change(() => ungroup(this.doc, slideId, ids, LOCAL_ORIGIN), "Ungrouping");
  }

  toggleLock() {
    const selected = this.selectedElements();
    const lock = !selected.every(element => element.locked);
    this.updateElements(selected.map(element => ({ id: element.id, set: { locked: lock } })));
  }

  reorder(to: "front" | "back" | "forward" | "backward") {
    const slide = this.currentSlide();
    if (!slide) return;
    const ids = this.ui.get().selection;
    const ordered = slide.elements.map(element => element.id).filter(id => ids.includes(id));
    // Keep the selection's own order: bring forward/front from the top down, backward/back from the bottom up.
    const sequence = to === "front" || to === "backward" ? ordered : [...ordered].reverse();
    this.change(() => sequence.forEach(id => reorderElement(this.doc, slide.id, id, to, LOCAL_ORIGIN)), "Reordering");
  }

  align(mode: AlignMode) {
    const selected = this.selectedElements().filter(element => !element.locked);
    if (!selected.length) return;
    const size = this.deck().size;
    const to = selected.length === 1 ? { x: 0, y: 0, w: size.width, h: size.height } : undefined;
    this.updateElements(alignElements(selected, mode, to));
  }

  distribute(axis: "horizontal" | "vertical") {
    this.updateElements(distributeElements(this.selectedElements().filter(element => !element.locked), axis));
  }

  // ---- clipboard (also across decks in this browser) ----

  copy(): boolean {
    const elements = this.selectedElements();
    if (!elements.length) return false;
    const payload: ClipboardPayload = { kind: "silicon-present/elements", deck: this.deckId, at: Date.now(), elements: structuredClone(elements) };
    try {
      localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(payload));
    } catch {
      // Storage may be off (a private window); the system clipboard still carries it.
    }
    void navigator.clipboard?.writeText(JSON.stringify(payload)).catch(() => undefined);
    return true;
  }

  cut() {
    if (this.copy()) this.deleteSelection();
  }

  /** Pastes elements copied in this browser (from this deck or another). Returns false when there is nothing ours. */
  async paste(text?: string | null): Promise<boolean> {
    let payload: ClipboardPayload | null = null;
    const parse = (raw: string | null | undefined) => {
      if (!raw) return null;
      try {
        const value = JSON.parse(raw) as ClipboardPayload;
        return value?.kind === "silicon-present/elements" && Array.isArray(value.elements) ? value : null;
      } catch {
        return null;
      }
    };
    payload = parse(text);
    if (!payload) {
      try {
        payload = parse(localStorage.getItem(CLIPBOARD_KEY));
      } catch {
        payload = null;
      }
      // Only use the stored copy when the system clipboard holds nothing newer of someone else's.
      if (payload && text && text.trim() && !parse(text)) return false;
    }
    if (!payload) return false;
    const slideId = this.currentSlideId();
    if (!slideId) return false;
    let elements = payload.elements;
    if (payload.deck !== this.deckId) elements = await this.copyAssets(elements);
    const groups = new Map<string, string>();
    const sameDeck = payload.deck === this.deckId;
    const created = this.change(() => {
      const ids: string[] = [];
      for (const element of elements) {
        const { id: _drop, ...copy } = structuredClone(element) as Element;
        void _drop;
        if (copy.group) {
          if (!groups.has(copy.group)) groups.set(copy.group, newGroupId());
          copy.group = groups.get(copy.group)!;
        }
        const offset = sameDeck ? 24 : 0;
        ids.push(addElementHelper(this.doc, slideId, { ...copy, x: copy.x + offset, y: copy.y + offset, locked: false } as ElementInput, undefined, LOCAL_ORIGIN));
      }
      return ids;
    }, "Pasting");
    if (created) {
      this.ui.set({ selection: created });
      // The next paste lands a little further on.
      if (sameDeck) {
        const moved: ClipboardPayload = { ...payload, elements: payload.elements.map(e => ({ ...e, x: e.x + 24, y: e.y + 24 })) };
        try {
          localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(moved));
        } catch {
          // ignore
        }
      }
    }
    return true;
  }

  /** Assets belong to a deck: pasting into another deck uploads a copy of each one into this deck. */
  private async copyAssets(elements: Element[]): Promise<Element[]> {
    const out: Element[] = [];
    const copied = new Map<string, string>();
    const remap = async (src: string | null | undefined): Promise<string | null | undefined> => {
      if (!src || !src.startsWith("asset:")) return src;
      if (copied.has(src)) return copied.get(src);
      try {
        const response = await fetch(`/api/v1/assets/${encodeURIComponent(src.slice(6))}`, { credentials: "same-origin" });
        if (!response.ok) return src;
        const blob = await response.blob();
        const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "pasted";
        const asset = await this.upload(new File([blob], name, { type: blob.type || "application/octet-stream" }));
        const next = asset ? `asset:${asset.id}` : src;
        copied.set(src, next);
        return next;
      } catch {
        return src;
      }
    };
    for (const element of elements) {
      const copy = structuredClone(element) as Element & { src?: string; poster?: string | null };
      if ("src" in copy) copy.src = (await remap(copy.src)) ?? "";
      if ("poster" in copy) copy.poster = (await remap(copy.poster)) ?? null;
      out.push(copy as Element);
    }
    return out;
  }

  // ---- assets ----

  async upload(file: File): Promise<{ id: string; url?: string; contentType?: string } | null> {
    try {
      const answer = await api.post<{ id: string; url?: string; contentType?: string }>(`/v1/decks/${encodeURIComponent(this.deckId)}/assets`, undefined, {
        raw: file,
        contentType: file.type || "application/octet-stream",
        // The service reads the name from X-Filename; the query copy is for a proxy that does not forward it.
        headers: { "X-Filename": encodeURIComponent(file.name) },
        query: { filename: file.name },
      });
      return answer;
    } catch (error) {
      notifyError(error, `${file.name} could not be uploaded`);
      return null;
    }
  }

  // ---- find and replace ----

  replaceAll(query: string, replacement: string, matchCase: boolean): number {
    return this.change(() => replaceInDeck(this.doc, query, replacement, { matchCase, origin: LOCAL_ORIGIN }), "Replacing") ?? 0;
  }

  /** The Y.Text behind a text field (for binding the rich text editor and the notes). */
  textField(slideId: string, elementId: string | null, field: string): Y.Text | null {
    if (!elementId || field === "notes") {
      // Read without creating: getTextField would add a missing notes text (a change a viewer must never make).
      const slide = slidesMap(this.doc).get(slideId);
      const notes = slide instanceof Y.Map ? slide.get("notes") : null;
      return notes instanceof Y.Text ? notes : null;
    }
    try {
      return getTextField(this.doc, slideId, elementId, field);
    } catch {
      return null;
    }
  }

  jsonNow(): DeckJson {
    return docToJson(this.doc);
  }

  // ---- remote highlights ----

  private onRemoteTouches(touches: RemoteTouch[]) {
    const now = Date.now();
    const kept = this.touches.get().list.filter(touch => now - touch.at < 2_600);
    this.touches.set({ list: [...kept, ...touches] });
    setTimeout(() => {
      const t = Date.now();
      this.touches.set({ list: this.touches.get().list.filter(touch => t - touch.at < 2_600) });
    }, 2_700);
    this.pruneSelection();
  }

  // ---- comments ----

  async loadThreads() {
    try {
      const answer = await api.get<unknown>(`/v1/decks/${encodeURIComponent(this.deckId)}/threads`, { query: { state: "all" } });
      this.threads.set({ list: readThreads(answer, this.me?.uuid ?? null), loaded: true });
    } catch (error) {
      this.threads.set({ loaded: true });
      if (!(error instanceof ApiError && (error.status === 401 || error.status === 403))) console.warn("threads could not be loaded", error);
    }
  }

  private onThreadEvent(payload: unknown) {
    const raw = (payload as { thread?: unknown })?.thread ?? payload;
    if (!raw || typeof raw !== "object") {
      void this.loadThreads();
      return;
    }
    const thread = readThread(raw, this.me?.uuid ?? null);
    if (!thread.id) {
      void this.loadThreads();
      return;
    }
    this.upsertThread(thread);
  }

  upsertThread(thread: Thread) {
    const list = this.threads.get().list;
    const index = list.findIndex(t => t.id === thread.id);
    const deleted = thread.comments.length > 0 && thread.comments.every(c => c.deleted);
    const next = index >= 0 ? list.map(t => (t.id === thread.id ? thread : t)) : [...list, thread];
    this.threads.set({ list: deleted && thread.comments.length === 1 ? next.filter(t => t.id !== thread.id) : next });
  }

  removeThread(id: string) {
    this.threads.set({ list: this.threads.get().list.filter(t => t.id !== id) });
  }
}

function clean(style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) if (value !== undefined && value !== null && value !== "") out[key] = value;
  return out;
}
