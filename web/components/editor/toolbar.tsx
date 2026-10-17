"use client";

/**
 * The editor's toolbar: undo and redo, inserting every kind of element, and then what fits what you're doing: the text
 * toolbar while editing text, arrange/align/group/lock for a selection. Zoom, snapping, the grid, find and the
 * shortcuts sit at the end.
 */
import { useRef, useState } from "react";
import {
  Bold,
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
  Shapes,
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
} from "lucide-react";
import { SHAPES, type ShapeName } from "@silicon-present/deck";
import { shapeGeometry } from "@silicon-present/render";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { useStore } from "@/lib/editor/store";
import { chartInput, htmlInput, insertFiles, shapeInput, tableInput, textInput } from "@/lib/editor/insert";
import { keyLabel } from "@/lib/editor/keys";
import { useDeck, useEditor, useUi } from "./editor-context";
import { ColorButton, MiniSelect, ToolButton, type Swatch } from "./controls";
import styles from "./editor.module.css";

export const SHAPE_NAMES: Record<string, string> = {
  rect: "Rectangle",
  "round-rect": "Rounded rectangle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  "right-triangle": "Right triangle",
  diamond: "Diamond",
  pentagon: "Pentagon",
  hexagon: "Hexagon",
  octagon: "Octagon",
  star: "Star",
  "arrow-right": "Arrow right",
  "arrow-left": "Arrow left",
  "arrow-up": "Arrow up",
  "arrow-down": "Arrow down",
  chevron: "Chevron",
  line: "Line",
  callout: "Callout",
  heart: "Heart",
  cloud: "Cloud",
  plus: "Plus",
};

export function ShapeGlyph({ shape, size = 22 }: { shape: string; size?: number }) {
  const w = size;
  const h = shape === "line" ? size : Math.round(size * 0.78);
  const geo = shapeGeometry(shape, w, h);
  return (
    <svg width={w} height={h} viewBox={`-1 -1 ${w + 2} ${h + 2}`} aria-hidden="true">
      <path d={geo.d} fill={geo.open ? "none" : "currentColor"} fillOpacity={0.18} stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

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
  const deck = useDeck();
  const files = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState("image/*");
  const [shapesOpen, setShapesOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 3, c: 3 });
  const pick = (kind: string) => {
    setAccept(kind);
    requestAnimationFrame(() => files.current?.click());
  };
  return (
    <div className={styles.toolGroup} role="group" aria-label="Insert">
      <ToolButton label="Text box" onClick={() => editor.addElement(textInput(editor), { edit: true })} data-testid="insert-text">
        <Type size={17} aria-hidden="true" />
      </ToolButton>
      <Popover open={shapesOpen} onOpenChange={setShapesOpen}>
        <PopoverTrigger asChild>
          <ToolButton label="Shape" data-testid="insert-shape">
            <Shapes size={17} aria-hidden="true" />
          </ToolButton>
        </PopoverTrigger>
        <PopoverContent align="start" className={styles.shapeMenu}>
          <p className={styles.menuTitle}>Shapes</p>
          <div className={styles.shapeGrid}>
            {SHAPES.map(shape => (
              <button
                key={shape}
                type="button"
                className={styles.shapeOption}
                aria-label={SHAPE_NAMES[shape]}
                title={SHAPE_NAMES[shape]}
                data-shape={shape}
                onClick={() => {
                  setShapesOpen(false);
                  editor.addElement(shapeInput(editor, shape as ShapeName, deck.theme));
                }}
              >
                <ShapeGlyph shape={shape} />
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <ToolButton label="Image" onClick={() => pick("image/*")} data-testid="insert-image">
        <ImagePlus size={17} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Video" onClick={() => pick("video/*")} data-testid="insert-video">
        <Clapperboard size={17} aria-hidden="true" />
      </ToolButton>
      <ToolButton label="Audio" onClick={() => pick("audio/*")} data-testid="insert-audio">
        <Music size={17} aria-hidden="true" />
      </ToolButton>
      <Popover open={tableOpen} onOpenChange={setTableOpen}>
        <PopoverTrigger asChild>
          <ToolButton label="Table" data-testid="insert-table">
            <Table size={17} aria-hidden="true" />
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
                    editor.addElement(tableInput(editor, r, c));
                  }}
                />
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      <ToolButton label="Chart" onClick={() => editor.addElement(chartInput(editor))} data-testid="insert-chart">
        <ChartColumn size={17} aria-hidden="true" />
      </ToolButton>
      <ToolButton
        label="HTML element"
        onClick={() => {
          const id = editor.addElement(htmlInput(editor));
          if (id) editor.ui.set({ codeElement: id });
        }}
        data-testid="insert-html"
      >
        <CodeXml size={17} aria-hidden="true" />
      </ToolButton>
      <input
        ref={files}
        type="file"
        accept={accept}
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
      <button type="button" className={styles.zoomValue} onClick={() => editor.ui.set({ zoom: "fit" })} title="Fit to the window" aria-label={`Zoom ${Math.round(current * 100)} percent. Fit to the window`}>
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

export function Toolbar() {
  const editor = useEditor();
  const { editing, master } = useUi(s => ({ editing: s.editing, master: s.master }));
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Editing">
      <div className={styles.toolGroup} role="group" aria-label="History">
        <ToolButton label="Undo" shortcut={keyLabel("Mod+Z")} onClick={() => editor.undo()} data-testid="undo">
          <Undo2 size={17} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Redo" shortcut={keyLabel("Mod+Shift+Z")} onClick={() => editor.redo()} data-testid="redo">
          <Redo2 size={17} aria-hidden="true" />
        </ToolButton>
      </div>
      <span className={styles.toolDivider} />
      <InsertTools />
      <span className={styles.toolDivider} />
      {editing ? <TextTools /> : <SelectionTools />}
      <div className={styles.toolSpacer} />
      {master ? (
        <button type="button" className={styles.masterBanner} onClick={() => editor.setMaster(false)} data-sq="surface">
          Editing the master · Done
        </button>
      ) : null}
      <ViewTools />
    </div>
  );
}
