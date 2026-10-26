"use client";

/**
 * Small controls for the editor's dense toolbars and panels, in the Silicon look (tokens, squircles, focus as fills):
 * an icon button with a tooltip, a compact select, a number field, a colour swatch picker.
 */
import { forwardRef, useId, useMemo, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, Pipette } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { colorKey, documentSwatches, normalizeHexColor, recentColors, uniqueSwatches } from "@/lib/editor/colors";
import { useDeck, useEditor } from "./editor-context";
import colorStyles from "./color-controls.module.css";
import styles from "./editor.module.css";

interface ToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  active?: boolean;
  children: ReactNode;
  tip?: boolean;
}

export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton({ label, shortcut, active, children, tip = true, className, ...props }, ref) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-active={active || undefined}
      className={[styles.tool, className].filter(Boolean).join(" ")}
      data-sq="surface"
      {...props}
    >
      {children}
    </button>
  );
  if (!tip) return button;
  return <Tooltip content={shortcut ? `${label} · ${shortcut}` : label} side="top" compact>{button}</Tooltip>;
});

export function MiniSelect<T extends string>({ label, value, options, onChange, width, disabled }: { label: string; value: T | ""; options: { value: T | ""; label: string }[]; onChange: (value: T) => void; width?: number; disabled?: boolean }) {
  return (
    <select className={styles.miniSelect} aria-label={label} title={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value as T)} style={width ? { width } : undefined} data-sq="surface">
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A number that commits on Enter, blur or the arrow keys (not on every keystroke, so typing "120" is one change). */
export function NumberField({ label, value, onChange, step = 1, min, max, suffix, width = 72, disabled }: { label: string; value: number | null | undefined; onChange: (value: number) => void; step?: number; min?: number; max?: number; suffix?: string; width?: number; disabled?: boolean }) {
  const shown = value === null || value === undefined || Number.isNaN(value) ? "" : String(Math.round(value * 100) / 100);
  const [draft, setDraft] = useState(shown);
  // A new value from the doc (someone else, undo) replaces what the field shows.
  const [prev, setPrev] = useState(shown);
  if (prev !== shown) {
    setPrev(shown);
    setDraft(shown);
  }
  const commit = (text: string) => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) {
      setDraft(shown);
      return;
    }
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n));
    if (clamped !== value) onChange(clamped);
    setDraft(String(clamped));
  };
  return (
    <label className={styles.numberField} style={{ width }} data-sq="surface" data-disabled={disabled || undefined}>
      <span className={styles.numberLabel}>{label}</span>
      <input
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={event => setDraft(event.target.value)}
        onBlur={event => commit(event.target.value)}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Enter") commit((event.target as HTMLInputElement).value);
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const base = Number(draft) || 0;
            commit(String(base + (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1)));
          }
        }}
      />
      {suffix ? <span className={styles.numberSuffix}>{suffix}</span> : null}
    </label>
  );
}

export interface Swatch {
  color: string | null;
  name: string;
}

const RECENT_COLORS_KEY = "silicon-present:recent-colors";
const STANDARD_COLORS: Swatch[] = [
  { color: "#000000", name: "Black" }, { color: "#FFFFFF", name: "White" },
  { color: "#64748B", name: "Slate" }, { color: "#EF4444", name: "Red" },
  { color: "#F59E0B", name: "Amber" }, { color: "#22C55E", name: "Green" },
  { color: "#3B82F6", name: "Blue" }, { color: "#A855F7", name: "Purple" },
];
const colorSurface = (color: string | null | undefined) => ({ "--color-value": color ?? "transparent" }) as CSSProperties;

/** Swatches apply immediately; the custom colour is a preview until Apply is chosen. */
export function ColorButton({ label, value, swatches, onChange, allowNone = false, children, mixed = false, showValue = false, noneLabel = "None", paletteLabel = "Theme", defaultColor }: { label: string; value: string | null | undefined; swatches: Swatch[]; onChange: (color: string | null) => void; allowNone?: boolean; children?: ReactNode; mixed?: boolean; showValue?: boolean; noneLabel?: string; paletteLabel?: string; defaultColor?: string }) {
  const editor = useEditor();
  const deck = useDeck();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const id = useId();
  const theme = uniqueSwatches(swatches);
  const used = useMemo(() => open ? documentSwatches(deck) : [], [deck, open]);
  const suggested = new Set(theme.flatMap(swatch => swatch.color ? [colorKey(swatch.color)] : []));
  const documentColors = used.filter(swatch => !suggested.has(colorKey(swatch.color!)));
  const custom = normalizeHexColor(draft);
  const shown = mixed ? "Mixed" : value ? normalizeHexColor(value) ?? value : noneLabel;
  const changeOpen = (next: boolean) => {
    if (next) {
      setDraft(normalizeHexColor(value ?? defaultColor ?? "") ?? normalizeHexColor(deck.theme.colors.accent) ?? "#1F5FB8");
      try { setRecent(recentColors(JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? "[]"))); } catch { /* A blocked store must not block colour editing. */ }
    }
    setOpen(next);
  };
  const commit = (color: string | null) => {
    editor.stopCapturing();
    onChange(color);
    editor.stopCapturing();
    if (color) {
      const next = recentColors(recent, color);
      setRecent(next);
      try { localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next)); } catch { /* Recent colours are optional. */ }
    }
    setOpen(false);
  };
  const palette = (title: string, colors: Swatch[]) => colors.length ? (
    <div className={colorStyles.palette} role="group" aria-label={`${title} colours`}>
      <p className={colorStyles.sectionTitle}>{title}</p>
      <div className={colorStyles.swatchGrid}>
        {colors.map(swatch => {
          const current = !mixed && Boolean(value && swatch.color && colorKey(value) === colorKey(swatch.color));
          return <button key={`${swatch.name}-${swatch.color}`} type="button" className={colorStyles.swatch} aria-label={swatch.name} aria-pressed={current} title={`${swatch.name}${swatch.name === swatch.color ? "" : ` · ${swatch.color}`}`} data-current={current || undefined} data-sq="surface" style={colorSurface(swatch.color)} onClick={() => commit(swatch.color)}>
            {current ? <span className={colorStyles.selected} data-sq="surface"><Check size={12} strokeWidth={3} aria-hidden="true" /></span> : null}
          </button>;
        })}
      </div>
    </div>
  ) : null;
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <Tooltip content={label} side="bottom">
        <PopoverTrigger asChild>
          {children ? (
            <button type="button" className={styles.tool} aria-label={label} data-sq="surface" onMouseDown={event => event.preventDefault()}>
              {children}
              <span className={colorStyles.indicator} style={colorSurface(value ?? defaultColor)} data-none={!value && !defaultColor || undefined} data-mixed={mixed || undefined} data-sq="clip" />
            </button>
          ) : (
            <button type="button" className={colorStyles.trigger} aria-label={`${label}: ${shown}`} data-sq="surface" onMouseDown={event => event.preventDefault()}>
              <span className={colorStyles.chip} style={colorSurface(value ?? defaultColor)} data-none={!value && !defaultColor || undefined} data-mixed={mixed || undefined} data-sq="clip" />
              {showValue ? <span className={colorStyles.value}>{shown}</span> : null}
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          )}
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" className={colorStyles.menu} aria-label={label} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
        }
      }}>
        <div className={colorStyles.heading}>
          <p className={colorStyles.title}>{label}</p>
          <span className={colorStyles.current}>{shown}</span>
        </div>
        {allowNone ? <button type="button" className={colorStyles.noneButton} aria-pressed={!mixed && !value} onClick={() => commit(null)} data-sq="surface">
          <span className={colorStyles.chip} style={colorSurface(defaultColor)} data-none={!defaultColor || undefined} data-sq="clip" />{noneLabel}
          {!mixed && !value ? <Check size={14} aria-hidden="true" /> : null}
        </button> : null}
        {palette(paletteLabel, theme)}
        {palette("In this deck", documentColors)}
        {palette("Recent", recent.map(color => ({ color, name: color })))}
        {palette("Standard", STANDARD_COLORS)}
        <form className={colorStyles.custom} onSubmit={event => { event.preventDefault(); if (custom) commit(custom); }}>
          <p className={colorStyles.sectionTitle}>Custom colour</p>
          <div className={colorStyles.customRow}>
            <label className={colorStyles.nativePicker} data-sq="surface" style={colorSurface(custom)} title="Open the colour picker">
              <Pipette size={16} aria-hidden="true" />
              <input type="color" value={(custom ?? "#1F5FB8").slice(0, 7)} onChange={event => setDraft(event.target.value.toUpperCase())} aria-label={`${label}: any colour`} />
            </label>
            <label className={colorStyles.hexField} data-sq="surface">
              <span>Hex</span>
              <input value={draft} spellCheck={false} maxLength={9} aria-label={`${label}: hex colour`} aria-invalid={!custom} aria-describedby={!custom ? `${id}-error` : undefined} onChange={event => setDraft(event.target.value)} onFocus={event => event.target.select()} />
            </label>
            <button type="submit" className={colorStyles.apply} disabled={!custom} data-sq="surface">Apply</button>
          </div>
          {!custom ? <p id={`${id}-error`} className={colorStyles.error}>Use a hex colour, such as #1F5FB8.</p> : null}
          <div className={colorStyles.preview} aria-label="Colour preview">
            <span className={colorStyles.previewBlock} style={colorSurface(custom)} data-sq="surface" />
            <span style={{ color: custom ?? "var(--foreground)" }}>Aa</span>
            <span className={colorStyles.previewHint}>Preview · Apply to keep</span>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function PanelSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className={styles.panelSection} aria-label={title}>
      <div className={styles.panelSectionHead}>
        <h3 className={styles.panelSectionTitle}>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Row({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className={styles.row}>
      {label ? <span className={styles.rowLabel}>{label}</span> : null}
      <div className={styles.rowControls}>{children}</div>
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className={styles.toggle}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
