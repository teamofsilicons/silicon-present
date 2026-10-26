"use client";

/**
 * The editor's toolbar: undo and redo, inserting every kind of element, and then what fits what you're doing: the text
 * toolbar while editing text, arrange/align/group/lock for a selection. Zoom, snapping, the grid, find and the
 * shortcuts sit at the end.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  MousePointer2,
  Hand,
  MessageSquare,
  Plus,
  ChartColumn,
  Clapperboard,
  Code,
  CodeXml,
  Copy,
  Grid3x3,
  Group,
  Highlighter,
  ImagePlus,
  Italic,
  Keyboard,
  Layers,
  Link,
  ListIndentDecrease,
  ListIndentIncrease,
  List,
  ListOrdered,
  Lock,
  LockOpen,
  Magnet,
  MessageSquarePlus,
  Music,
  Redo2,
  Search,
  Strikethrough,
  Table,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Trash,
  Type,
  Underline,
  Undo2,
  Ungroup,
  ZoomIn,
  ZoomOut,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Baseline,
  PaintBucket,
  Check,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { useStore } from "@/lib/editor/store";
import { chartInput, htmlInput, insertFiles, tableInput, textInput } from "@/lib/editor/insert";
import { keyLabel } from "@/lib/editor/keys";
import { PICK_MEDIA_EVENT } from "@/lib/editor/insert-shortcuts";
import { ShapeMenu } from "./shape-menu";
export { SHAPE_NAMES, ShapeGlyph } from "./shape-menu";
import { useAbilities, useDeck, useEditor, useUi } from "./editor-context";
import { ColorButton, MiniSelect, NumberField, ToolButton, type Swatch } from "./controls";
import styles from "./editor.module.css";

const FONTS = ["Inter", "Fraunces", "Space Grotesk", "IBM Plex Sans", "IBM Plex Mono", "DM Serif Display", "Playfair Display", "Georgia", "system-ui"];
const SIZES = [16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 96, 120, 160];

export function themeSwatches(colors: Record<string, string>): Swatch[] {
  return [
    { color: colors.text ?? null, name: "Text" },
    { color: colors.accent ?? null, name: "Accent" },
    { color: colors.accent2 ?? null, name: "Accent 2" },
    { color: colors.accent3 ?? null, name: "Accent 3" },
    { color: colors.muted ?? null, name: "Muted" },
    { color: colors.background ?? null, name: "Background" },
  ];
}

function InsertTools() {
  const editor = useEditor();
  const { shape, shapeArmed } = useUi(s => ({ shape: s.shape, shapeArmed: s.shapeArmed }));
  const files = useRef<HTMLInputElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 3, c: 3 });
  const pick = useCallback((kind: string) => {
    const input = files.current;
    if (!input) return;
    input.accept = kind;
    input.click();
  }, []);
  useEffect(() => {
    const onPickMedia = () => pick("image/*,video/*");
    window.addEventListener(PICK_MEDIA_EVENT, onPickMedia);
    return () => window.removeEventListener(PICK_MEDIA_EVENT, onPickMedia);
  }, [pick]);
  return (
    <div className={styles.toolGroup} role="group" aria-label="Insert">
      <ToolButton label="Text box" shortcut="T" onClick={() => editor.addElement(textInput(editor), { edit: true })} data-testid="insert-text">
        <Type size={17} aria-hidden="true" />
      </ToolButton>
      <ShapeMenu shape={shape} armed={shapeArmed} onArm={choice => editor.armShape(choice)} onMedia={() => { editor.setTool("select"); pick("image/*,video/*"); }} />
      <ToolButton label="Image" onClick={() => pick("image/*")} data-testid="insert-image">
        <ImagePlus size={17} aria-hidden="true" />
      </ToolButton>
      <Popover open={moreOpen} onOpenChange={open => { setMoreOpen(open); if (!open) setTableOpen(false); }}>
        <PopoverTrigger asChild><ToolButton label="More tools" data-testid="more-tools"><Plus size={18} aria-hidden="true" /></ToolButton></PopoverTrigger>
        <PopoverContent side="top" align="center" className={styles.insertMenu}>
          <p className={styles.menuTitle}>Add to your slide</p>
          <div className={styles.insertMenuGrid}>
      <ToolButton className={styles.insertMenuTool} label="Video" tip={false} onClick={() => { setMoreOpen(false); pick("video/*"); }} data-testid="insert-video">
        <Clapperboard size={17} aria-hidden="true" /><span>Video</span>
      </ToolButton>
      <ToolButton className={styles.insertMenuTool} label="Audio" tip={false} onClick={() => { setMoreOpen(false); pick("audio/*"); }} data-testid="insert-audio">
        <Music size={17} aria-hidden="true" /><span>Audio</span>
      </ToolButton>
      <Popover open={tableOpen} onOpenChange={setTableOpen}>
        <PopoverTrigger asChild>
          <ToolButton className={styles.insertMenuTool} label="Table" tip={false} data-testid="insert-table">
            <Table size={17} aria-hidden="true" /><span>Table</span>
          </ToolButton>
        </PopoverTrigger>
        <PopoverContent align="start" className={styles.tableMenu}>
          <p className={styles.menuTitle}>
            Table {hover.r} × {hover.c}
          </p>
          <div className={styles.tableGrid} onMouseLeave={() => setHover({ r: 3, c: 3 })}>
            {Array.from({ length: 8 * 8 }, (_, i) => {
              const r = Math.floor(i / 8) + 1;
              const c = (i % 8) + 1;
              return (
                <button
                  key={i}
                  type="button"
                  className={styles.tableCell}
                  data-on={(r <= hover.r && c <= hover.c) || undefined}
                  aria-label={`${r} by ${c} table`}
                  onMouseEnter={() => setHover({ r, c })}
                  onFocus={() => setHover({ r, c })}
                  onClick={() => {
                    setTableOpen(false);
                    setMoreOpen(false);
                    editor.addElement(tableInput(editor, r, c));
                  }}
                />
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      <ToolButton className={styles.insertMenuTool} label="Chart" tip={false} onClick={() => { setMoreOpen(false); editor.addElement(chartInput(editor)); }} data-testid="insert-chart">
        <ChartColumn size={17} aria-hidden="true" /><span>Chart</span>
      </ToolButton>
      <ToolButton
        className={styles.insertMenuTool}
        label="HTML element"
        tip={false}
        onClick={() => {
          setMoreOpen(false);
          const id = editor.addElement(htmlInput(editor));
          if (id) editor.ui.set({ codeElement: id });
        }}
        data-testid="insert-html"
      >
        <CodeXml size={17} aria-hidden="true" /><span>HTML</span>
      </ToolButton>
          </div>
        </PopoverContent>
      </Popover>
      <input
        ref={files}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        data-testid="file-input"
        onChange={event => {
          const list = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (list.length) void insertFiles(editor, list);
        }}
      />
    </div>
  );
}

function LinkButton({ value, onChange }: { value: string | null; onChange: (link: string | null) => void }) {
  const deck = useDeck();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) setDraft(value ?? "");
      }}
    >
      <PopoverTrigger asChild>
        <ToolButton label="Link" active={Boolean(value)}>
          <Link size={16} aria-hidden="true" />
        </ToolButton>
      </PopoverTrigger>
      <PopoverContent align="start" className={styles.linkMenu}>
        <p className={styles.menuTitle}>Link</p>
        <form
          className={styles.linkForm}
          onSubmit={event => {
            event.preventDefault();
            const text = draft.trim();
            onChange(text ? (/^(https?:|mailto:|tel:|slide:)/.test(text) ? text : `https://${text}`) : null);
            setOpen(false);
          }}
        >
          <input className={styles.textInput} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => event.stopPropagation()} placeholder="https://… or pick a slide" aria-label="Link address" autoFocus />
          <button type="submit" className={styles.smallPrimary} data-sq="surface">
            Apply
          </button>
        </form>
        <p className={styles.menuTitle}>Or a slide in this deck</p>
        <div className={styles.slideLinks}>
          {deck.slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              className={styles.slideLink}
              onClick={() => {
                onChange(`slide:${slide.id}`);
                setOpen(false);
              }}
            >
              Slide {index + 1}
            </button>
          ))}
        </div>
        {value ? (
          <button
            type="button"
            className={styles.slideLink}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            Remove link
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function TextTools() {
  const editor = useEditor();
  const deck = useDeck();
  const { quill, formats } = useStore(editor.textUi, s => s);
  if (!quill) return null;
  const f = formats as Record<string, unknown>;
  const set = (name: string, value: unknown) => quill.format(name, value);
  const toggle = (name: string) => set(name, !f[name]);
  const swatches = themeSwatches(deck.theme.colors as unknown as Record<string, string>);
  const heading = typeof f.heading === "number" ? String(f.heading) : "";
  return (
    <div className={styles.toolGroup} role="group" aria-label="Text" onMouseDown={event => {
        // Keep the caret in the text box when a button is pressed (selects and fields still take focus).
        if (!(event.target as HTMLElement).closest("select, input")) event.preventDefault();
      }}>
      <MiniSelect label="Paragraph style" value={heading} width={112} options={[{ value: "", label: "Normal text" }, { value: "1", label: "Heading 1" }, { value: "2", label: "Heading 2" }, { value: "3", label: "Heading 3" }]} onChange={value => set("heading", value ? Number(value) : false)} />
      <MiniSelect label="Font" value={(f.font as string) ?? ""} width={124} options={[{ value: "", label: deck.theme.fonts.body }, ...FONTS.filter(font => font !== deck.theme.fonts.body).map(font => ({ value: font, label: font }))]} onChange={value => set("font", value || false)} />
      <MiniSelect label="Size" value={f.size ? String(f.size) : ""} width={72} options={[{ value: "", label: "Size" }, ...SIZES.map(size => ({ value: String(size), label: String(size) }))]} onChange={value => set("size", value ? Number(value) : false)} />
      <ToolButton label="Bold" shortcut={keyLabel("Mod+B")} active={Boolean(f.bold)} onClick={() => toggle("bold")}>
        <Bold size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Italic" shortcut={keyLabel("Mod+I")} active={Boolean(f.italic)} onClick={() => toggle("italic")}>
        <Italic size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Underline" shortcut={keyLabel("Mod+U")} active={Boolean(f.underline)} onClick={() => toggle("underline")}>
        <Underline size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Strikethrough" active={Boolean(f.strike)} onClick={() => toggle("strike")}>
        <Strikethrough size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Code" active={Boolean(f.code)} onClick={() => toggle("code")}>
        <Code size={16} aria-hidden="true" />
      </ToolButton>
      <ColorButton label="Text colour" value={(f.color as string) ?? null} swatches={swatches} onChange={color => set("color", color ?? false)}>
        <Baseline size={16} aria-hidden="true" />
      </ColorButton>
      <ColorButton label="Highlight" value={(f.highlight as string) ?? null} swatches={[{ color: "#fff3a3", name: "Yellow" }, { color: "#cdeccd", name: "Green" }, { color: "#d6e6ff", name: "Blue" }, { color: "#ffd9d6", name: "Red" }]} allowNone onChange={color => set("highlight", color ?? false)}>
        <Highlighter size={16} aria-hidden="true" />
      </ColorButton>
      <LinkButton value={(f.link as string) ?? null} onChange={link => set("link", link ?? false)} />
      <span className={styles.toolDivider} />
      {(
        [
          ["", "Align left", TextAlignStart],
          ["center", "Align centre", TextAlignCenter],
          ["right", "Align right", TextAlignEnd],
          ["justify", "Justify", TextAlignJustify],
        ] as const
      ).map(([value, label, Icon]) => (
        <ToolButton key={label} label={label} active={(f.align ?? "") === value} onClick={() => set("align", value || false)}>
          <Icon size={16} aria-hidden="true" />
        </ToolButton>
      ))}
      <ToolButton label="Bulleted list" active={f.list === "bullet"} onClick={() => set("list", f.list === "bullet" ? false : "bullet")}>
        <List size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Numbered list" active={f.list === "ordered"} onClick={() => set("list", f.list === "ordered" ? false : "ordered")}>
        <ListOrdered size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Outdent" onClick={() => set("indent", Math.max(0, Number(f.indent ?? 0) - 1) || false)}>
        <ListIndentDecrease size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Indent" onClick={() => set("indent", Math.min(8, Number(f.indent ?? 0) + 1))}>
        <ListIndentIncrease size={16} aria-hidden="true" />
      </ToolButton>
      <MiniSelect label="Line spacing" value={f.lineHeight ? String(f.lineHeight) : ""} width={84} options={[{ value: "", label: "Spacing" }, ...["1", "1.15", "1.25", "1.5", "2"].map(v => ({ value: v, label: v }))]} onChange={value => set("lineHeight", value ? Number(value) : false)} />
      <ToolButton
        label="Comment on the selected words"
        shortcut={keyLabel("Mod+Alt+M")}
        onClick={() => {
          const anchor = quill.selectionAnchor();
          const el = editor.selectedElements()[0];
          if (anchor && el) editor.ui.set({ composer: { anchor, at: { x: el.x + el.w, y: el.y } }, panel: "comments" });
        }}
      >
        <MessageSquarePlus size={16} aria-hidden="true" />
      </ToolButton>
    </div>
  );
}

/** The selected part of an HTML element being edited inside: its text colour, size, weight, slant, background; delete. */
function HtmlInsideTools() {
  const editor = useEditor();
  const deck = useDeck();
  const inside = useUi(s => s.htmlInside);
  if (!inside) return null;
  const info = inside.part === null ? null : inside.info;
  const swatches = themeSwatches(deck.theme.colors as unknown as Record<string, string>);
  const set = (style: Record<string, string | null>) => {
    if (inside.part === null) return;
    if (!editor.changeHtmlInside({ kind: "style", part: inside.part, set: style })) return;
    // The frame reports the part again once it redraws; until then show what was just set.
    const patch: Partial<NonNullable<typeof info>> = {};
    if ("color" in style) patch.color = style.color;
    if ("background-color" in style) patch.background = style["background-color"] === "transparent" ? null : style["background-color"];
    if ("font-size" in style && style["font-size"]) patch.fontSize = parseFloat(style["font-size"]);
    if ("font-weight" in style) patch.bold = style["font-weight"] === "bold";
    if ("font-style" in style) patch.italic = style["font-style"] === "italic";
    const now = editor.ui.get().htmlInside;
    if (now?.info && now.part === inside.part) editor.ui.set({ htmlInside: { ...now, info: { ...now.info, ...patch } } });
  };
  return (
    <div className={styles.toolGroup} role="group" aria-label="HTML element parts" data-testid="html-inside-tools">
      {info ? <>
        <span className={styles.toolHint} data-testid="html-inside-part">&lt;{info.tag}&gt;</span>
        <ColorButton label="Text colour" value={info.color} swatches={swatches} onChange={color => set({ color })}>
          <Baseline size={16} aria-hidden="true" />
        </ColorButton>
        <NumberField label="Size" value={info.fontSize} min={1} max={2000} suffix="px" width={84} onChange={size => set({ "font-size": `${Math.round(size * 10) / 10}px` })} />
        <ToolButton label="Bold" active={info.bold} onClick={() => set({ "font-weight": info.bold ? "normal" : "bold" })}>
          <Bold size={16} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Italic" active={info.italic} onClick={() => set({ "font-style": info.italic ? "normal" : "italic" })}>
          <Italic size={16} aria-hidden="true" />
        </ToolButton>
        <ColorButton label="Background colour" value={info.background} swatches={swatches} allowNone onChange={color => set({ "background-color": color ?? "transparent" })}>
          <PaintBucket size={16} aria-hidden="true" />
        </ColorButton>
        <ToolButton label="Delete this part" shortcut="Delete" onClick={() => inside.part !== null && editor.changeHtmlInside({ kind: "delete", part: inside.part })} data-testid="html-inside-delete">
          <Trash size={16} aria-hidden="true" />
        </ToolButton>
        <span className={styles.toolDivider} />
      </> : <span className={styles.toolHint}>Click a part to select it · drag to move it · double-click text to type</span>}
      <ToolButton label="Edit the code" onClick={() => editor.ui.set({ codeElement: inside.elementId })}>
        <Code size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Done · Esc" onClick={() => editor.exitHtmlInside()} data-testid="html-inside-done">
        <Check size={16} aria-hidden="true" />
      </ToolButton>
    </div>
  );
}

function SelectionTools() {
  const editor = useEditor();
  const selection = useUi(s => s.selection);
  useDeck();
  const selected = editor.selectedElements();
  if (!selected.length) return null;
  const locked = selected.every(e => e.locked);
  const grouped = selected.some(e => e.group);
  return (
    <div className={styles.toolGroup} role="group" aria-label="Selection" data-count={selection.length}>
      <Popover>
        <PopoverTrigger asChild>
          <ToolButton label="Arrange">
            <Layers size={16} aria-hidden="true" />
          </ToolButton>
        </PopoverTrigger>
        <PopoverContent align="start" className={styles.menuList}>
          <button type="button" className={styles.menuItem} onClick={() => editor.reorder("front")}>
            Bring to front <kbd>{keyLabel("Mod+Shift+]")}</kbd>
          </button>
          <button type="button" className={styles.menuItem} onClick={() => editor.reorder("forward")}>
            Bring forward <kbd>{keyLabel("Mod+]")}</kbd>
          </button>
          <button type="button" className={styles.menuItem} onClick={() => editor.reorder("backward")}>
            Send backward <kbd>{keyLabel("Mod+[")}</kbd>
          </button>
          <button type="button" className={styles.menuItem} onClick={() => editor.reorder("back")}>
            Send to back <kbd>{keyLabel("Mod+Shift+[")}</kbd>
          </button>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <ToolButton label="Align">
            <AlignCenterHorizontal size={16} aria-hidden="true" />
          </ToolButton>
        </PopoverTrigger>
        <PopoverContent align="start" className={styles.alignMenu}>
          <p className={styles.menuTitle}>{selected.length === 1 ? "Align to the slide" : "Align the selection"}</p>
          <div className={styles.alignGrid}>
            <ToolButton label="Align left" onClick={() => editor.align("left")}>
              <AlignStartVertical size={16} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Align centres" onClick={() => editor.align("center")}>
              <AlignCenterVertical size={16} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Align right" onClick={() => editor.align("right")}>
              <AlignEndVertical size={16} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Align top" onClick={() => editor.align("top")}>
              <AlignStartHorizontal size={16} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Align middles" onClick={() => editor.align("middle")}>
              <AlignCenterHorizontal size={16} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Align bottom" onClick={() => editor.align("bottom")}>
              <AlignEndHorizontal size={16} aria-hidden="true" />
            </ToolButton>
          </div>
          <p className={styles.menuTitle}>Distribute</p>
          <div className={styles.alignGrid}>
            <ToolButton label="Distribute horizontally" disabled={selected.length < 3} onClick={() => editor.distribute("horizontal")}>
              <AlignHorizontalDistributeCenter size={16} aria-hidden="true" />
            </ToolButton>
            <ToolButton label="Distribute vertically" disabled={selected.length < 3} onClick={() => editor.distribute("vertical")}>
              <AlignVerticalDistributeCenter size={16} aria-hidden="true" />
            </ToolButton>
          </div>
        </PopoverContent>
      </Popover>
      {selected.length > 1 && !grouped ? (
        <ToolButton label="Group" shortcut={keyLabel("Mod+G")} onClick={() => editor.group()}>
          <Group size={16} aria-hidden="true" />
        </ToolButton>
      ) : null}
      {grouped ? (
        <ToolButton label="Ungroup" shortcut={keyLabel("Mod+Shift+G")} onClick={() => editor.ungroup()}>
          <Ungroup size={16} aria-hidden="true" />
        </ToolButton>
      ) : null}
      <ToolButton label={locked ? "Unlock" : "Lock"} shortcut={keyLabel("Mod+Shift+L")} active={locked} onClick={() => editor.toggleLock()}>
        {locked ? <Lock size={16} aria-hidden="true" /> : <LockOpen size={16} aria-hidden="true" />}
      </ToolButton>
      <ToolButton label="Duplicate" shortcut={keyLabel("Mod+D")} onClick={() => editor.duplicateSelection()}>
        <Copy size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Delete" shortcut="Delete" onClick={() => editor.deleteSelection()}>
        <Trash size={16} aria-hidden="true" />
      </ToolButton>
      {selected.length === 1 ? <LinkButton value={selected[0]!.link} onChange={link => editor.updateElement(selected[0]!.id, { link })} /> : null}
    </div>
  );
}

export function ViewTools() {
  const editor = useEditor();
  const { zoom, snap, grid, fit } = useUi(s => ({ zoom: s.zoom, snap: s.snap, grid: s.grid, fit: s.fitScale }));
  const current = zoom === "fit" ? fit : zoom;
  const step = (dir: 1 | -1) => {
    const levels = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];
    const next = dir > 0 ? levels.find(l => l > current + 0.001) ?? 2 : [...levels].reverse().find(l => l < current - 0.001) ?? 0.1;
    editor.ui.set({ zoom: next });
  };
  return (
    <div className={styles.toolGroup} role="group" aria-label="View">
      <ToolButton label="Snap to guides" active={snap} onClick={() => editor.ui.set({ snap: !snap })}>
        <Magnet size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Grid" active={grid} onClick={() => editor.ui.set({ grid: !grid })}>
        <Grid3x3 size={16} aria-hidden="true" />
      </ToolButton>
      <span className={styles.toolDivider} />
      <ToolButton label="Zoom out" shortcut={keyLabel("Mod+-")} onClick={() => step(-1)}>
        <ZoomOut size={16} aria-hidden="true" />
      </ToolButton>
      <button type="button" className={styles.zoomValue} onClick={() => { editor.ui.set({ zoom: "fit" }); window.dispatchEvent(new Event("present:fit")); }} title="Fit to the window" aria-label={`Zoom ${Math.round(current * 100)} percent. Fit to the window`}>
        {zoom === "fit" ? "Fit" : `${Math.round(current * 100)}%`}
      </button>
      <ToolButton label="Zoom in" shortcut={keyLabel("Mod+=")} onClick={() => step(1)}>
        <ZoomIn size={16} aria-hidden="true" />
      </ToolButton>
      <span className={styles.toolDivider} />
      <ToolButton label="Find and replace" shortcut={keyLabel("Mod+F")} onClick={() => editor.ui.set({ findOpen: true })} data-testid="open-find">
        <Search size={16} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Keyboard shortcuts" shortcut="?" onClick={() => editor.ui.set({ shortcutsOpen: true })}>
        <Keyboard size={16} aria-hidden="true" />
      </ToolButton>
    </div>
  );
}

/** Creation tools stay in one place, independent of the current selection. */
export function Toolbar() {
  const editor = useEditor();
  const { canEdit, canComment, signInToComment } = useAbilities();
  const { commentMode, handMode, shapeArmed } = useUi(s => s);
  return (
    <div className={styles.creationDock} role="toolbar" aria-label="Slide tools" data-sq="surface">
      <ToolButton label="Select" shortcut="V" active={!commentMode && !handMode && !shapeArmed} onClick={() => editor.setTool("select")} data-testid="select-tool"><MousePointer2 size={19} aria-hidden="true" /></ToolButton>
      <ToolButton label="Hand" shortcut="H" active={handMode} onClick={() => editor.setTool("hand")} data-testid="hand-tool"><Hand size={19} aria-hidden="true" /></ToolButton>
      {canEdit ? <><span className={styles.toolDivider} /><InsertTools /></> : null}
      {canComment || signInToComment ? <>
        <span className={styles.toolDivider} />
        <ToolButton label="Comment" shortcut="C" active={commentMode} onClick={() => editor.setTool(commentMode ? "select" : "comment")} data-testid="comment-mode"><MessageSquare size={19} aria-hidden="true" /></ToolButton>
      </> : null}
    </div>
  );
}

/** Formatting follows the selection; file actions and creation tools no longer compete with it. */
export function ContextToolbar() {
  const editor = useEditor();
  const { canEdit } = useAbilities();
  const { editing, master, commentMode, handMode, shapeArmed, selection, overview, htmlInside } = useUi(s => s);
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={canEdit ? "Editing" : "View controls"}>
      {canEdit ? <div className={styles.toolGroup} role="group" aria-label="History">
        <ToolButton label="Undo" shortcut={keyLabel("Mod+Z")} onClick={() => editor.undo()} data-testid="undo"><Undo2 size={17} aria-hidden="true" /></ToolButton>
        <ToolButton label="Redo" shortcut={keyLabel("Mod+Shift+Z")} onClick={() => editor.redo()} data-testid="redo"><Redo2 size={17} aria-hidden="true" /></ToolButton>
        <span className={styles.toolDivider} />
      </div> : null}
      {shapeArmed ? <span className={styles.toolHint}>Drag to draw · Shift to constrain · Esc to cancel</span> :
        commentMode ? <span className={styles.toolHint}>Click to comment · drag to mark an area · Esc to finish</span> :
        handMode ? <span className={styles.toolHint}>Drag to move around · V to select</span> :
        canEdit && !overview && htmlInside ? <HtmlInsideTools /> :
        canEdit && !overview && editing ? <TextTools /> : canEdit && !overview && selection.length ? <SelectionTools /> :
        <span className={styles.toolHint}>{overview ? `Your deck at a glance · select a slide to ${canEdit ? "edit" : "view"}` : canEdit ? "Select an object to style it, or add one below" : "Select objects or use Hand to move around"}</span>}
      <div className={styles.toolSpacer} />
      {master ? <button type="button" className={styles.masterBanner} onClick={() => editor.setMaster(false)} data-sq="surface">Editing the master · Done</button> : null}
      <ViewTools />
    </div>
  );
}
