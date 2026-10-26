"use client";

/**
 * The deck page in the browser: makes the Editor (the Y.Doc, its live connection and IndexedDB copy, undo, UI state)
 * and lays out the top bar, the toolbar (editors), the slide strip, the canvas with the speaker notes and the code
 * panel, and the right panel. On a phone it is a calm read-and-comment view: the slide, arrows to move through the
 * deck, and the comments.
 */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Editor } from "@/lib/editor/editor";
import type { DeckMeta, Me } from "@/lib/editor/types";
import { appConfig } from "@/lib/app.config";
import { EditorContext, useAbilities, useDeck, useEditor, useMeta, useUi } from "./editor-context";
import { TopBar } from "./top-bar";
import { Toolbar, ContextToolbar } from "./toolbar";
import { LayersControl } from "./layers-control";
import { SlideStrip, SlideOverview } from "./slide-strip";
import { Canvas } from "./canvas";
import { RightPanel } from "./right-panel";
import { NotesPane } from "./notes-pane";
import { CodePanel } from "./code-panel";
import { FindReplace } from "./find-replace";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { useShortcuts } from "./use-shortcuts";
import { ThreadsPanel } from "@/components/comments/threads-panel";
import styles from "./editor.module.css";

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

export function EditorApp({ deckId, meta, me, initialSlide, initialThread = null }: { deckId: string; meta: DeckMeta; me: Me | null; initialSlide: string | null; initialThread?: string | null }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    const next = new Editor({ deckId, meta, me, slide: initialSlide, thread: initialThread });
    // The editor is an external system (a Y.Doc, IndexedDB, a live stream) made once in the browser, never on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditor(next);
    // For the browser tests and for debugging from the console.
    (window as unknown as { __presentEditor?: Editor }).__presentEditor = next;
    return () => next.destroy();
    // One editor per deck page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);
  if (!editor) {
    return (
      <div className={styles.shell} aria-busy="true">
        <div className={styles.topBar} />
        <p className={styles.loadingNote}>Opening the deck…</p>
      </div>
    );
  }
  return (
    <EditorContext.Provider value={editor}>
      <EditorLayout />
    </EditorContext.Provider>
  );
}

function EditorLayout() {
  const editor = useEditor();
  const phone = usePhone();
  const { canEdit } = useAbilities();
  const { panelOpen, codeElement, overview } = useUi(s => ({ panelOpen: s.panelOpen, codeElement: s.codeElement, overview: s.overview }));
  useShortcuts(editor);

  // The tab's title follows the deck's (a rename here or by someone else).
  const title = useMeta().title;
  useEffect(() => {
    document.title = `${title} · ${appConfig.name}`;
  }, [title]);

  // Leaving with changes that haven't reached the service yet: they are kept in this browser, but say so.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!editor.unsent || !navigator.onLine) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editor]);

  // Load the rich text editor ahead of the first double-click.
  useEffect(() => {
    if (canEdit) void import("@/lib/editor/quill-setup");
  }, [canEdit]);

  useEffect(() => {
    // A phone gets the read-and-comment view: never in the middle of an edit there.
    if (phone) editor.ui.set({ selection: [], editing: null, panelOpen: true, panel: "comments" });
  }, [phone, editor]);

  if (phone) {
    return (
      <div className={styles.shell} data-phone="">
        <TopBar phone />
        <main className={styles.phoneMain} id="main">
          <div className={styles.phoneCanvas}>
            <Canvas phone />
          </div>
          <PhoneNav />
          {panelOpen ? (
            <div className={styles.phoneComments}>
              <ThreadsPanel />
            </div>
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div className={styles.shell} data-can-edit={canEdit || undefined}>
      <TopBar />
      <ContextToolbar />
      <div className={styles.body} data-panel={panelOpen || undefined}>
        <SlideStrip />
        <main className={styles.center} id="main">
          <div className={styles.canvasArea}>
            {overview ? <SlideOverview /> : <Canvas />}
            {!overview ? <Toolbar /> : null}
            {!overview ? <div className={styles.layersDock} data-with-tools={canEdit || undefined} data-testid="layers-dock" data-sq="surface"><LayersControl /></div> : null}
          </div>
          {!overview && (codeElement ? <CodePanel /> : <NotesPane />)}
          <FindReplace />
        </main>
        {panelOpen ? <RightPanel /> : null}
      </div>
      <ShortcutsDialog />
    </div>
  );
}

function PhoneNav() {
  const editor = useEditor();
  const deck = useDeck();
  const slideId = useUi(s => s.slideId);
  const index = Math.max(0, deck.slides.findIndex(s => s.id === slideId));
  return (
    <div className={styles.phoneNav}>
      <button type="button" className={styles.tool} aria-label="Previous slide" onClick={() => editor.stepSlide(-1)} disabled={index <= 0} data-sq="surface">
        <ChevronLeft size={18} aria-hidden="true" />
      </button>
      <span className={styles.phoneCount}>
        {deck.slides.length ? index + 1 : 0} / {deck.slides.length}
      </span>
      <button type="button" className={styles.tool} aria-label="Next slide" onClick={() => editor.stepSlide(1)} disabled={index >= deck.slides.length - 1} data-sq="surface">
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
