"use client";

/**
 * The panel on the right: Design (the selected element's properties, or the slide's: layout, background, transition,
 * master), Animate (the element's animation and the slide's transition, with previews), Theme, and Comments.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Plus, Minus, Upload, X } from "lucide-react";
import { MASTER, LAYOUTS, SHAPES, THEMES, applyOps, getSize, getSlide, getTheme, type Animation, type ChartType, type Element, type Slide, type Theme, type Transition } from "@silicon-present/deck";
import { slideSteps, transitionCss } from "@silicon-present/render";
import { ThreadsPanel } from "@/components/comments/threads-panel";
import { useAbilities, useCurrentSlide, useDeck, useEditor, useMeta, useUi } from "./editor-context";
import { ColorButton, MiniSelect, NumberField, PanelSection, Row, Toggle } from "./controls";
import { LayoutGlyph, LAYOUT_NAMES } from "./slide-strip";
import { SHAPE_NAMES, themeSwatches } from "./toolbar";
import type { RightPanel as Tab } from "@/lib/editor/editor";
import { colorKey, commonTextColor, elementFillColor, elementTextColor } from "@/lib/editor/colors";
import { layoutChangeOps } from "@/lib/editor/layout-change";
import { useStore } from "@/lib/editor/store";
import { isBuiltInLook, listThemes, saveTheme, suggestedThemeName, themeForDeck, themeLook, type SavedTheme } from "@/lib/present/themes";
import { notify } from "@/lib/notify";
import styles from "./editor.module.css";

const TABS: { value: Tab; label: string }[] = [
  { value: "design", label: "Design" },
  { value: "animate", label: "Animate" },
  { value: "theme", label: "Theme" },
  { value: "comments", label: "Comments" },
];

export function RightPanel() {
  const editor = useEditor();
  const panel = useUi(s => s.panel);
  const { canEdit } = useAbilities();
  const tabs = canEdit ? TABS : TABS.filter(t => t.value === "comments");
  const current = canEdit ? panel : "comments";
  return (
    <aside className={styles.panel} aria-label="Properties and comments">
      {tabs.length > 1 ? (
        <div className={styles.tabs} role="tablist" aria-label="Panel">
          {tabs.map(tab => (
            <button key={tab.value} type="button" role="tab" aria-selected={current === tab.value} className={styles.tab} data-active={current === tab.value || undefined} onClick={() => {
              if (tab.value !== "comments") editor.setTool("select");
              editor.ui.set({ panel: tab.value });
            }} data-testid={`tab-${tab.value}`}>
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.panelBody} role="tabpanel">
        {current === "design" ? <DesignPanel /> : null}
        {current === "animate" ? <AnimatePanel /> : null}
        {current === "theme" ? <ThemePanel /> : null}
        {current === "comments" ? <ThreadsPanel /> : null}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- design

function DesignPanel() {
  const editor = useEditor();
  useUi(s => s.selection);
  useDeck();
  const selected = editor.selectedElements();
  if (selected.length === 1) return <ElementPanel element={selected[0]!} />;
  if (selected.length > 1) return <MultiPanel elements={selected} />;
  return <SlidePanel />;
}

function MultiPanel({ elements }: { elements: Element[] }) {
  const editor = useEditor();
  const deck = useDeck();
  const swatches = themeSwatches(deck.theme.colors as unknown as Record<string, string>);
  const fills = elements.map(element => elementFillColor(element, deck.theme));
  return (
    <>
      <PanelSection title={`${elements.length} elements`}>
        <TextColorRow elements={elements} />
        <Row label="Fill">
          <ColorButton label="Fill" value={fills[0]} mixed={fills.some(fill => (fill ? colorKey(fill) : null) !== (fills[0] ? colorKey(fills[0]) : null))} swatches={swatches} allowNone showValue onChange={fill => editor.setStyle({ fill: fill ?? "transparent" })} />
        </Row>
        <Row label="Border">
          <ColorButton label="Border colour" value={elements[0]!.style.stroke ?? null} mixed={elements.some(element => element.style.stroke !== elements[0]!.style.stroke)} swatches={swatches} allowNone showValue onChange={stroke => editor.setStyle({ stroke: stroke ?? undefined })} />
        </Row>
        <Row label="Opacity">
          <NumberField label="%" value={Math.round((elements[0]!.style.opacity ?? 1) * 100)} min={0} max={100} onChange={v => editor.setStyle({ opacity: v / 100 })} />
        </Row>
      </PanelSection>
    </>
  );
}

/** Text colour is useful before entering the text editor as well as while editing a selection. */
function TextColorRow({ elements }: { elements: Element[] }) {
  const editor = useEditor();
  const deck = useDeck();
  const editing = useUi(state => state.editing);
  const formats = useStore(editor.textUi, state => state.formats) as Record<string, unknown>;
  const texts = elements.filter(element => element.kind === "text" || element.kind === "shape");
  if (!texts.length) return null;
  const active = editing && texts.some(element => element.id === editing.elementId);
  const color = active ? typeof formats.color === "string" ? formats.color : Array.isArray(formats.color) ? undefined : null : commonTextColor(texts.map(element => element.text));
  const defaults = texts.map(element => elementTextColor(element, deck.theme));
  const sameDefault = defaults.every(value => colorKey(value) === colorKey(defaults[0]!));
  return <Row label="Text colour">
    <ColorButton label="Text colour" value={color} mixed={color === undefined || color === null && !sameDefault} swatches={themeSwatches(deck.theme.colors as unknown as Record<string, string>)} allowNone noneLabel="Automatic" defaultColor={sameDefault ? defaults[0] : undefined} showValue onChange={next => editor.setTextFormat("color", next ?? false)} />
  </Row>;
}

function ElementPanel({ element }: { element: Element }) {
  const editor = useEditor();
  const deck = useDeck();
  const swatches = themeSwatches(deck.theme.colors as unknown as Record<string, string>);
  const set = (patch: Record<string, unknown>) => editor.updateElement(element.id, patch);
  const s = element.style;
  const KIND: Record<string, string> = { text: "Text", shape: "Shape", image: "Image", video: "Video", audio: "Audio", table: "Table", chart: "Chart", html: "HTML element" };
  return (
    <>
      {element.kind !== "audio" ? (
        <PanelSection title="Appearance">
          <TextColorRow elements={[element]} />
          <Row label="Fill">
            <ColorButton label="Fill" value={elementFillColor(element, deck.theme)} swatches={swatches} allowNone showValue onChange={fill => editor.setStyle({ fill: fill ?? "transparent" })} />
          </Row>
          <Row label="Border">
            <ColorButton label="Border colour" value={s.stroke ?? null} swatches={swatches} allowNone onChange={stroke => editor.setStyle({ stroke: stroke ?? undefined })} />
            <NumberField label="Width" value={s.strokeWidth ?? (s.stroke ? 2 : 0)} min={0} max={80} onChange={strokeWidth => editor.setStyle({ strokeWidth })} />
          </Row>
          {element.kind !== "shape" ? (
            <Row label="Corners">
              <NumberField label="Radius" value={s.radius ?? 0} min={0} onChange={radius => editor.setStyle({ radius: radius || undefined })} width={96} />
            </Row>
          ) : null}
          <Toggle label="Shadow" checked={Boolean(s.shadow)} onChange={shadow => editor.setStyle({ shadow: shadow || undefined })} />
        </PanelSection>
      ) : null}
      <PanelSection title={KIND[element.kind] ?? "Element"}>
        <div className={styles.grid2}>
          <NumberField label="X" value={element.x} onChange={x => set({ x })} disabled={element.locked} />
          <NumberField label="Y" value={element.y} onChange={y => set({ y })} disabled={element.locked} />
          <NumberField label="W" value={element.w} min={1} onChange={w => set({ w })} disabled={element.locked} />
          <NumberField label="H" value={element.h} min={1} onChange={h => set({ h })} disabled={element.locked} />
          <NumberField label="Rotate" value={element.rotation} suffix="°" onChange={rotation => set({ rotation: ((rotation % 360) + 360) % 360 })} disabled={element.locked} />
          <NumberField label="Opacity" value={Math.round((s.opacity ?? 1) * 100)} suffix="%" min={0} max={100} onChange={v => editor.setStyle({ opacity: v >= 100 ? undefined : v / 100 })} />
        </div>
        <Toggle label="Locked" checked={element.locked} onChange={locked => set({ locked })} />
      </PanelSection>
      {element.kind === "shape" ? (
        <PanelSection title="Shape">
          <MiniSelect label="Shape" value={element.shape} width={200} options={SHAPES.map(shape => ({ value: shape, label: SHAPE_NAMES[shape] ?? shape }))} onChange={shape => set({ shape })} />
        </PanelSection>
      ) : null}
      {element.kind === "text" || element.kind === "shape" ? (
        <PanelSection title="Text box">
          <Row label="Vertical">
            <MiniSelect label="Vertical alignment" value={s.verticalAlign ?? (element.kind === "shape" ? "middle" : "top")} width={120} options={[{ value: "top", label: "Top" }, { value: "middle", label: "Middle" }, { value: "bottom", label: "Bottom" }]} onChange={verticalAlign => editor.setStyle({ verticalAlign })} />
          </Row>
          <Row label="Padding">
            <NumberField label="px" value={s.padding ?? (element.kind === "shape" ? 16 : 0)} min={0} max={400} onChange={padding => editor.setStyle({ padding })} />
          </Row>
          <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => editor.startEditing(element.id)}>
            Edit text
          </button>
        </PanelSection>
      ) : null}
      {element.kind === "image" ? <ImageSection element={element} /> : null}
      {element.kind === "video" || element.kind === "audio" ? <MediaSection element={element} /> : null}
      {element.kind === "table" ? <TableSection element={element} /> : null}
      {element.kind === "chart" ? <ChartSection element={element} /> : null}
      {element.kind === "html" ? <HtmlSection element={element} /> : null}
    </>
  );
}

function ImageSection({ element }: { element: Extract<Element, { kind: "image" }> }) {
  const editor = useEditor();
  return (
    <PanelSection title="Image">
      <Row label="Fit">
        <MiniSelect label="Fit" value={element.fit} width={120} options={[{ value: "contain", label: "Contain" }, { value: "cover", label: "Cover" }, { value: "fill", label: "Stretch" }]} onChange={fit => editor.updateElement(element.id, { fit })} />
      </Row>
      <TextSetting label="Description" value={element.alt} placeholder="What the image shows" onCommit={alt => editor.updateElement(element.id, { alt })} />
      <ReplaceFile accept="image/*" onFile={async file => {
        const asset = await editor.upload(file);
        if (asset) editor.updateElement(element.id, { src: `asset:${asset.id}` });
      }} label="Replace image" />
    </PanelSection>
  );
}

function MediaSection({ element }: { element: Extract<Element, { kind: "video" | "audio" }> }) {
  const editor = useEditor();
  return (
    <PanelSection title={element.kind === "video" ? "Video" : "Audio"}>
      <Toggle label="Play automatically" checked={element.autoplay} onChange={autoplay => editor.updateElement(element.id, { autoplay })} />
      <Toggle label="Loop" checked={element.loop} onChange={loop => editor.updateElement(element.id, { loop })} />
      <Toggle label="Muted" checked={element.muted} onChange={muted => editor.updateElement(element.id, { muted })} />
      <TextSetting label="Description" value={element.alt} placeholder="What it is" onCommit={alt => editor.updateElement(element.id, { alt })} />
      <ReplaceFile accept={`${element.kind}/*`} onFile={async file => {
        const asset = await editor.upload(file);
        if (asset) editor.updateElement(element.id, { src: `asset:${asset.id}` });
      }} label={`Replace ${element.kind}`} />
    </PanelSection>
  );
}

function TableSection({ element }: { element: Extract<Element, { kind: "table" }> }) {
  const editor = useEditor();
  const deck = useDeck();
  const [cell, setCell] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const editing = useUi(s => s.editing);
  const active = editing && editing.elementId === element.id ? /^cell:(\d+):(\d+)$/.exec(editing.field) : null;
  const current = active ? { r: Number(active[1]), c: Number(active[2]) } : cell;
  const resize = (rows: number, cols: number) => {
    if (rows < 1 || cols < 1 || rows > 40 || cols > 20) return;
    const rowH = element.h / element.rows;
    editor.updateElement(element.id, { rows, cols, h: Math.round(rowH * rows), rowHeights: Array.from({ length: rows }, (_, i) => element.rowHeights[i] ?? rowH) });
  };
  const setFill = (fill: string | null) => {
    const cells = element.cells.map((row, r) => row.map((c, ci) => (r === current.r && ci === current.c ? { ...c, fill } : c)));
    editor.updateElement(element.id, { cells });
  };
  return (
    <PanelSection title="Table">
      <Row label="Rows">
        <button type="button" className={styles.stepper} aria-label="Remove a row" onClick={() => resize(element.rows - 1, element.cols)} data-testid="table-remove-row">
          <Minus size={14} aria-hidden="true" />
        </button>
        <span className={styles.stepValue}>{element.rows}</span>
        <button type="button" className={styles.stepper} aria-label="Add a row" onClick={() => resize(element.rows + 1, element.cols)} data-testid="table-add-row">
          <Plus size={14} aria-hidden="true" />
        </button>
      </Row>
      <Row label="Columns">
        <button type="button" className={styles.stepper} aria-label="Remove a column" onClick={() => resize(element.rows, element.cols - 1)} data-testid="table-remove-col">
          <Minus size={14} aria-hidden="true" />
        </button>
        <span className={styles.stepValue}>{element.cols}</span>
        <button type="button" className={styles.stepper} aria-label="Add a column" onClick={() => resize(element.rows, element.cols + 1)} data-testid="table-add-col">
          <Plus size={14} aria-hidden="true" />
        </button>
      </Row>
      <Toggle label="Header row" checked={element.headerRow} onChange={headerRow => editor.updateElement(element.id, { headerRow })} />
      <Row label="Cell">
        <MiniSelect label="Row" value={String(current.r)} width={64} options={Array.from({ length: element.rows }, (_, r) => ({ value: String(r), label: `R${r + 1}` }))} onChange={v => setCell({ ...current, r: Number(v) })} />
        <MiniSelect label="Column" value={String(current.c)} width={64} options={Array.from({ length: element.cols }, (_, c) => ({ value: String(c), label: `C${c + 1}` }))} onChange={v => setCell({ ...current, c: Number(v) })} />
        <ColorButton label="Cell fill" value={element.cells[current.r]?.[current.c]?.fill ?? null} swatches={themeSwatches(deck.theme.colors as unknown as Record<string, string>)} allowNone onChange={setFill} />
      </Row>
      <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => editor.startEditing(element.id, `cell:${current.r}:${current.c}`)}>
        Edit cell text
      </button>
      <p className={styles.hint}>Double-click a cell on the slide to type in it.</p>
    </PanelSection>
  );
}

const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "column", label: "Column" },
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "pie", label: "Pie" },
  { value: "donut", label: "Donut" },
  { value: "scatter", label: "Scatter" },
];

function ChartSection({ element }: { element: Extract<Element, { kind: "chart" }> }) {
  const editor = useEditor();
  const deck = useDeck();
  const chart = element.chart;
  const set = (patch: Partial<typeof chart>) => editor.updateElement(element.id, { chart: { ...chart, ...patch } });
  const setValue = (si: number, li: number, value: number) => set({ series: chart.series.map((s, i) => (i === si ? { ...s, values: chart.labels.map((_, j) => (j === li ? value : (s.values[j] ?? 0))) } : s)) });
  return (
    <PanelSection title="Chart">
      <Row label="Type">
        <MiniSelect label="Chart type" value={chart.type} width={140} options={CHART_TYPES} onChange={type => set({ type })} />
      </Row>
      <TextSetting label="Title" value={chart.title ?? ""} placeholder="No title" onCommit={title => set({ title: title || undefined })} />
      <Toggle label="Legend" checked={chart.legend} onChange={legend => set({ legend })} />
      <div className={styles.dataGridWrap}>
        <table className={styles.dataGrid} aria-label="Chart data">
          <thead>
            <tr>
              <th scope="col">Label</th>
              {chart.series.map((s, si) => (
                <th key={si} scope="col">
                  <input className={styles.gridInput} value={s.name} aria-label={`Series ${si + 1} name`} onKeyDown={e => e.stopPropagation()} onChange={event => set({ series: chart.series.map((x, i) => (i === si ? { ...x, name: event.target.value } : x)) })} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.labels.map((label, li) => (
              <tr key={li}>
                <td>
                  <input className={styles.gridInput} value={label} aria-label={`Label ${li + 1}`} onKeyDown={e => e.stopPropagation()} onChange={event => set({ labels: chart.labels.map((l, j) => (j === li ? event.target.value : l)) })} />
                </td>
                {chart.series.map((s, si) => (
                  <td key={si}>
                    <input
                      className={styles.gridInput}
                      inputMode="decimal"
                      defaultValue={String(s.values[li] ?? 0)}
                      key={`${si}-${li}-${s.values[li]}`}
                      aria-label={`${s.name || `Series ${si + 1}`}, ${label}`}
                      onKeyDown={e => {
                        e.stopPropagation();
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={event => {
                        const n = Number(event.target.value);
                        if (Number.isFinite(n) && n !== s.values[li]) setValue(si, li, n);
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => set({ labels: [...chart.labels, `Item ${chart.labels.length + 1}`], series: chart.series.map(s => ({ ...s, values: [...s.values, 0] })) })}>
          Add row
        </button>
        <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => set({ series: [...chart.series, { name: `Series ${chart.series.length + 1}`, values: chart.labels.map(() => 0) }] })}>
          Add series
        </button>
      </div>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.secondaryButton} data-sq="surface" disabled={chart.labels.length <= 1} onClick={() => set({ labels: chart.labels.slice(0, -1), series: chart.series.map(s => ({ ...s, values: s.values.slice(0, chart.labels.length - 1) })) })}>
          Remove last row
        </button>
        <button type="button" className={styles.secondaryButton} data-sq="surface" disabled={chart.series.length <= 1} onClick={() => set({ series: chart.series.slice(0, -1) })}>
          Remove last series
        </button>
      </div>
      {chart.series.map((s, si) => (
        <Row key={si} label={s.name || `Series ${si + 1}`}>
          <ColorButton label={`${s.name || `Series ${si + 1}`} colour`} value={s.color ?? null} swatches={themeSwatches(deck.theme.colors as unknown as Record<string, string>)} allowNone onChange={color => set({ series: chart.series.map((x, i) => (i === si ? { ...x, color: color ?? undefined } : x)) })} />
        </Row>
      ))}
    </PanelSection>
  );
}

function HtmlSection({ element }: { element: Element }) {
  const editor = useEditor();
  return (
    <PanelSection title="HTML element">
      <p className={styles.hint}>It runs live in its own sandbox: it can load anything from the internet, and never sees this page or your account. Double-click it to edit its text, colours and parts in place.</p>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.secondaryButton} data-sq="surface" disabled={element.locked} onClick={() => editor.enterHtmlInside(element.id)} data-testid="edit-inside">
          Edit inside
        </button>
        <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => editor.ui.set({ codeElement: element.id })} data-testid="open-code">
          Edit code
        </button>
        <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => window.dispatchEvent(new CustomEvent("present:run-html", { detail: element.id }))}>
          <Play size={14} aria-hidden="true" /> Run again
        </button>
      </div>
    </PanelSection>
  );
}

function TextSetting({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (value: string) => void }) {
  return (
    <label className={styles.textSetting}>
      <span className={styles.rowLabel}>{label}</span>
      <input
        className={styles.textInput}
        defaultValue={value}
        key={value}
        placeholder={placeholder}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        onBlur={event => {
          if (event.target.value !== value) onCommit(event.target.value);
        }}
      />
    </label>
  );
}

function ReplaceFile({ accept, onFile, label }: { accept: string; onFile: (file: File) => void | Promise<void>; label: string }) {
  return (
    <label className={styles.secondaryButton} data-sq="surface">
      <Upload size={14} aria-hidden="true" /> {label}
      <input
        type="file"
        accept={accept}
        hidden
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onFile(file);
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------- slide

function SlidePanel() {
  const editor = useEditor();
  const deck = useDeck();
  const slide = useCurrentSlide();
  const master = useUi(s => s.master);
  if (!slide) return null;
  if (master) {
    return (
      <PanelSection title="Master">
        <p className={styles.hint}>What you put here is drawn under every slide that shows the master: a logo, a footer, a page frame.</p>
        <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => editor.setMaster(false)}>
          Back to the slides
        </button>
      </PanelSection>
    );
  }
  const swatches = themeSwatches(deck.theme.colors as unknown as Record<string, string>);
  const bg = slide.background;
  const applyLayout = (layout: string) => {
    editor.stopCapturing();
    editor.change(() => {
      const ops = layoutChangeOps(getSlide(editor.doc, slide.id), layout, getTheme(editor.doc), getSize(editor.doc));
      applyOps(editor.doc, ops, undefined, { atomic: false });
    }, "Changing the layout");
    editor.stopCapturing();
  };
  return (
    <>
      <PanelSection title="Background">
        <Row label="Colour">
          <ColorButton label="Background colour" value={bg && "color" in bg ? bg.color : null} swatches={swatches} allowNone noneLabel="Theme default" defaultColor={bg && "image" in bg ? undefined : deck.theme.colors.background} showValue onChange={color => editor.updateSlide(slide.id, { background: color ? { color } : null })} />
        </Row>
        <ReplaceFile
          accept="image/*"
          label={bg && "image" in bg ? "Replace background image" : "Background image"}
          onFile={async file => {
            const asset = await editor.upload(file);
            if (asset) editor.updateSlide(slide.id, { background: { image: `asset:${asset.id}`, fit: "cover" } });
          }}
        />
        {bg && "image" in bg ? (
          <Row label="Fit">
            <MiniSelect label="Background fit" value={bg.fit} width={120} options={[{ value: "cover", label: "Cover" }, { value: "contain", label: "Contain" }]} onChange={fit => editor.updateSlide(slide.id, { background: { ...bg, fit } })} />
            <button type="button" className={styles.stepper} aria-label="Remove the background" onClick={() => editor.updateSlide(slide.id, { background: null })}>
              <X size={14} aria-hidden="true" />
            </button>
          </Row>
        ) : null}
      </PanelSection>
      <PanelSection title="Layout">
        <div className={styles.layoutGridPanel}>
          {LAYOUTS.map(layout => (
            <button key={layout} type="button" className={styles.layoutOption} data-sq="surface" data-current={slide.layout === layout || undefined} onClick={() => applyLayout(layout)} title={LAYOUT_NAMES[layout]}>
              <LayoutGlyph layout={layout} />
              <span>{LAYOUT_NAMES[layout]}</span>
            </button>
          ))}
        </div>
        <p className={styles.hint}>Rearranges text and pictures. Extra content stays on the slide.</p>
      </PanelSection>
      {slide.id !== MASTER ? <TransitionSection slide={slide} /> : null}
      <PanelSection title="Slide">
        <Toggle label="Skip this slide when presenting" checked={slide.skipped} onChange={skipped => editor.updateSlide(slide.id, { skipped })} />
        <Toggle label="Show the master" checked={!slide.hideMaster} onChange={show => editor.updateSlide(slide.id, { hideMaster: !show })} />
        <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => editor.setMaster(true)} data-testid="edit-master">
          Edit the master
        </button>
      </PanelSection>
    </>
  );
}

function TransitionSection({ slide }: { slide: Slide }) {
  const editor = useEditor();
  const t = slide.transition;
  const set = (next: Transition | null) => editor.updateSlide(slide.id, { transition: next });
  const preview = () => {
    const target = document.querySelector<HTMLElement>("[data-transition-target]");
    const css = transitionCss(t ?? { type: "fade", duration: 500 });
    if (!target || !css) return;
    target.style.animation = "none";
    void target.offsetWidth;
    target.style.animation = css.in;
    setTimeout(() => (target.style.animation = ""), css.duration + 50);
  };
  return (
    <PanelSection
      title="Transition"
      actions={
        <button type="button" className={styles.linkButton} onClick={preview} disabled={!t} data-testid="preview-transition">
          <Play size={13} aria-hidden="true" /> Preview
        </button>
      }
    >
      <Row label="Effect">
        <MiniSelect
          label="Transition"
          value={t?.type ?? ""}
          width={130}
          options={[{ value: "", label: "None" }, { value: "fade", label: "Fade" }, { value: "push", label: "Push" }, { value: "wipe", label: "Wipe" }, { value: "zoom", label: "Zoom" }, { value: "cover", label: "Cover" }]}
          onChange={type => set(type ? { type: type as Transition["type"], duration: t?.duration ?? 500, ...(type === "push" || type === "wipe" || type === "cover" ? { direction: t?.direction ?? "left" } : {}) } : null)}
        />
      </Row>
      {t ? (
        <>
          <Row label="Duration">
            <NumberField label="ms" value={t.duration} min={50} max={10000} step={50} onChange={duration => set({ ...t, duration })} width={90} />
          </Row>
          {t.type === "push" || t.type === "wipe" || t.type === "cover" ? (
            <Row label="From">
              <MiniSelect label="Direction" value={t.direction ?? "left"} width={110} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }, { value: "up", label: "Up" }, { value: "down", label: "Down" }]} onChange={direction => set({ ...t, direction })} />
            </Row>
          ) : null}
        </>
      ) : null}
    </PanelSection>
  );
}

// ---------------------------------------------------------------- animate

function AnimatePanel() {
  const editor = useEditor();
  const slide = useCurrentSlide();
  useUi(s => s.selection);
  const selected = editor.selectedElements();
  if (!slide) return null;
  const animated = slide.elements.filter(e => e.animation).sort((a, b) => (a.animation!.order ?? 0) - (b.animation!.order ?? 0));
  const element = selected.length === 1 ? selected[0]! : null;
  return (
    <>
      {element ? <AnimationSection element={element} slide={slide} /> : <PanelSection title="Animation"><p className={styles.hint}>Select an element to animate it.</p></PanelSection>}
      <PanelSection title="Order on this slide">
        {animated.length ? (
          <ol className={styles.animList}>
            {animated.map(e => (
              <li key={e.id}>
                <button type="button" className={styles.animItem} data-current={element?.id === e.id || undefined} onClick={() => editor.select([e.id])}>
                  <span>{e.animation!.order}.</span> {e.kind} · {e.animation!.effect} · {e.animation!.trigger.replace("-", " ")}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.hint}>Nothing on this slide is animated.</p>
        )}
      </PanelSection>
      {slide.id !== MASTER ? <TransitionSection slide={slide} /> : null}
    </>
  );
}

function AnimationSection({ element, slide }: { element: Element; slide: Slide }) {
  const editor = useEditor();
  const a = element.animation;
  const set = (next: Animation | null) => editor.updateElement(element.id, { animation: next });
  const nextOrder = Math.max(0, ...slide.elements.map(e => e.animation?.order ?? 0)) + 1;
  const preview = () => {
    const node = document.querySelector<HTMLElement>(`[data-element-id="${element.id}"] .sp-in`);
    const info = slideSteps({ ...slide, elements: slide.elements.map(e => (e.id === element.id ? { ...e, animation: a ?? null } : e)) }).elements.get(element.id);
    if (!node || !info) return;
    node.style.animation = "none";
    void node.offsetWidth;
    node.style.animation = `${info.keyframes} ${info.duration}ms cubic-bezier(.2,.7,.2,1) 0ms both`;
    setTimeout(() => (node.style.animation = ""), info.duration + 60);
  };
  return (
    <PanelSection
      title="Animation"
      actions={
        <button type="button" className={styles.linkButton} onClick={preview} disabled={!a} data-testid="preview-animation">
          <Play size={13} aria-hidden="true" /> Preview
        </button>
      }
    >
      <Row label="Effect">
        <MiniSelect
          label="Effect"
          value={a?.effect ?? ""}
          width={130}
          options={[{ value: "", label: "None" }, { value: "appear", label: "Appear" }, { value: "fade", label: "Fade" }, { value: "fly-in", label: "Fly in" }, { value: "zoom", label: "Zoom" }, { value: "wipe", label: "Wipe" }, { value: "rise", label: "Rise" }]}
          onChange={effect => set(effect ? { effect: effect as Animation["effect"], trigger: a?.trigger ?? "click", order: a?.order ?? nextOrder, duration: a?.duration ?? 500, delay: a?.delay ?? 0, ...(effect === "fly-in" || effect === "wipe" ? { direction: a?.direction ?? "up" } : {}) } : null)}
        />
      </Row>
      {a ? (
        <>
          <Row label="Start">
            <MiniSelect label="Trigger" value={a.trigger} width={150} options={[{ value: "click", label: "On click" }, { value: "with-previous", label: "With previous" }, { value: "after-previous", label: "After previous" }]} onChange={trigger => set({ ...a, trigger })} />
          </Row>
          <div className={styles.grid2}>
            <NumberField label="Order" value={a.order} min={0} onChange={order => set({ ...a, order })} />
            <NumberField label="ms" value={a.duration} min={1} max={20000} step={50} onChange={duration => set({ ...a, duration })} />
            <NumberField label="Delay" value={a.delay} min={0} max={20000} step={50} onChange={delay => set({ ...a, delay })} />
          </div>
          {a.effect === "fly-in" || a.effect === "wipe" ? (
            <Row label="Direction">
              <MiniSelect label="Direction" value={a.direction ?? "up"} width={110} options={[{ value: "up", label: "Up" }, { value: "down", label: "Down" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }]} onChange={direction => set({ ...a, direction })} />
            </Row>
          ) : null}
        </>
      ) : null}
    </PanelSection>
  );
}

// ---------------------------------------------------------------- theme

/** Your saved themes (usable in any deck you edit), and saving this deck's theme to them. */
function YourThemes() {
  const editor = useEditor();
  const deck = useDeck();
  const { role } = useMeta();
  const queryClient = useQueryClient();
  const theme = deck.theme;
  const saved = useQuery({ queryKey: ["themes"], queryFn: ({ signal }) => listThemes(signal), enabled: Boolean(editor.me), meta: { toast: false } });
  const [naming, setNaming] = useState<string | null>(null);
  const use = useMutation({
    mutationFn: (t: SavedTheme) => themeForDeck(t.id, editor.deckId),
    onSuccess: next => editor.setTheme(next),
    meta: { errorTitle: "Couldn't use that theme" },
  });
  const save = useMutation({
    mutationFn: (name: string) => saveTheme(editor.deckId, name),
    onSuccess: async t => {
      setNaming(null);
      await queryClient.invalidateQueries({ queryKey: ["themes"] });
      notify.success(`Saved ${t.name} to your themes`, "Use it in any deck you edit, from the Theme panel.");
    },
    meta: { errorTitle: "Couldn't save the theme" },
  });
  if (!editor.me) return null;
  const themes = saved.data ?? [];
  const look = themeLook(theme);
  const alreadySaved = themes.some(t => themeLook(t) === look);
  const canSave = !isBuiltInLook(theme) && !alreadySaved;
  const label = role === "owner" ? "Save to my themes" : "Add to my themes";
  return (
    <PanelSection title="Your themes">
      {themes.length ? (
        <div className={styles.themeList} data-testid="your-themes">
          {themes.map(t => (
            <button key={t.id} type="button" className={styles.themeOption} data-sq="surface" data-current={themeLook(t) === look || undefined} disabled={use.isPending} onClick={() => use.mutate(t)} title={t.name} style={{ background: t.colors.background, color: t.colors.text }} data-testid="saved-theme-option">
              <span className={styles.themeName} style={{ fontFamily: `"${t.fonts.heading}", system-ui` }}>
                {t.name}
              </span>
              <span className={styles.themeDots}>
                {[t.colors.accent, t.colors.accent2, t.colors.accent3].map(c => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
            </button>
          ))}
        </div>
      ) : saved.isSuccess ? (
        <p className={styles.hint}>Change this deck&apos;s colours or fonts, then save the theme to use it in your other decks.</p>
      ) : saved.isError ? (
        <p className={styles.hint}>Your themes didn&apos;t load: {saved.error.message}</p>
      ) : null}
      {naming !== null ? (
        <form
          className={styles.themeSave}
          onSubmit={event => {
            event.preventDefault();
            if (naming.trim()) save.mutate(naming.trim());
          }}
        >
          <input className={styles.textInput} value={naming} autoFocus maxLength={80} aria-label="Theme name" placeholder="Theme name" onChange={event => setNaming(event.target.value)} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") setNaming(null); }} data-testid="theme-name" />
          <div className={styles.buttonRow}>
            <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => setNaming(null)}>
              Cancel
            </button>
            <button type="submit" className={styles.smallPrimary} data-sq="surface" disabled={!naming.trim() || save.isPending} data-testid="theme-save-confirm">
              Save
            </button>
          </div>
        </form>
      ) : canSave && saved.isSuccess ? (
        <button type="button" className={styles.secondaryButton} data-sq="surface" onClick={() => setNaming(suggestedThemeName(theme))} data-testid="theme-save">
          <Plus size={14} aria-hidden="true" /> {label}
        </button>
      ) : null}
    </PanelSection>
  );
}

function ThemePanel() {
  const editor = useEditor();
  const deck = useDeck();
  const theme = deck.theme;
  const set = (patch: Partial<Theme>) => editor.setTheme({ ...theme, ...patch });
  const ratio = deck.size.width / deck.size.height;
  return (
    <>
      <PanelSection title="Colours">
        {(Object.keys(theme.colors) as (keyof Theme["colors"])[]).map(key => (
          <Row key={key} label={key === "accent2" ? "Accent 2" : key === "accent3" ? "Accent 3" : key[0]!.toUpperCase() + key.slice(1)}>
            <ColorButton label={`${key} colour`} value={theme.colors[key]} swatches={themeSwatches(theme.colors as unknown as Record<string, string>)} showValue onChange={color => { if (color) set({ colors: { ...theme.colors, [key]: color } }); }} />
          </Row>
        ))}
      </PanelSection>
      <PanelSection title="Themes">
        <div className={styles.themeList}>
          {THEMES.map(t => (
            <button key={t.name} type="button" className={styles.themeOption} data-sq="surface" data-current={t.name === theme.name || undefined} onClick={() => editor.setTheme({ ...t, customFonts: theme.customFonts })} style={{ background: t.colors.background, color: t.colors.text }} data-testid="theme-option">
              <span className={styles.themeName} style={{ fontFamily: `"${t.fonts.heading}", system-ui` }}>
                {t.name}
              </span>
              <span className={styles.themeDots}>
                {[t.colors.accent, t.colors.accent2, t.colors.accent3].map(c => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
            </button>
          ))}
        </div>
      </PanelSection>
      <YourThemes />
      <PanelSection title="Fonts">
        <TextSetting label="Headings" value={theme.fonts.heading} onCommit={heading => set({ fonts: { ...theme.fonts, heading: heading || "Inter" } })} />
        <TextSetting label="Body" value={theme.fonts.body} onCommit={body => set({ fonts: { ...theme.fonts, body: body || "Inter" } })} />
        <p className={styles.hint}>Any Google Fonts family, or a font uploaded to the deck.</p>
      </PanelSection>
      <PanelSection title="Slide size">
        <MiniSelect
          label="Slide size"
          value={Math.abs(ratio - 16 / 9) < 0.01 ? "16:9" : Math.abs(ratio - 4 / 3) < 0.01 ? "4:3" : ""}
          width={200}
          options={[{ value: "16:9", label: "Widescreen 16:9" }, { value: "4:3", label: "Standard 4:3" }, ...(Math.abs(ratio - 16 / 9) < 0.01 || Math.abs(ratio - 4 / 3) < 0.01 ? [] : [{ value: "" as const, label: `${deck.size.width} × ${deck.size.height}` }])]}
          onChange={value => editor.change(() => editor.doc.getMap("deck").set("size", value === "4:3" ? { width: 1440, height: 1080 } : { width: 1920, height: 1080 }), "Changing the slide size")}
        />
      </PanelSection>
    </>
  );
}
