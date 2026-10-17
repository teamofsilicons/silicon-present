"use client";

/**
 * Small controls for the editor's dense toolbars and panels, in the Silicon look (tokens, squircles, focus as fills):
 * an icon button with a tooltip, a compact select, a number field, a colour swatch picker.
 */
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
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
  return <Tooltip content={shortcut ? `${label} · ${shortcut}` : label} side="bottom">{button}</Tooltip>;
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

/** A colour from the theme's swatches, black and white, none (when allowed), or any colour. */
export function ColorButton({ label, value, swatches, onChange, allowNone = false, children }: { label: string; value: string | null | undefined; swatches: Swatch[]; onChange: (color: string | null) => void; allowNone?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const all = [...swatches, { color: "#000000", name: "Black" }, { color: "#ffffff", name: "White" }];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={label} side="bottom">
        <PopoverTrigger asChild>
          {children ? (
            <button type="button" className={styles.tool} aria-label={label} data-sq="surface">
              {children}
              <span className={styles.swatchLine} style={{ background: value ?? "transparent", borderColor: value ? "transparent" : "var(--border-strong)" }} />
            </button>
          ) : (
            <button type="button" className={styles.swatchChip} aria-label={`${label}: ${value ?? "none"}`} data-none={value ? undefined : ""} data-sq="surface">
              <span style={{ background: value ?? "transparent" }} />
            </button>
          )}
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" className={styles.swatchMenu}>
        <p className={styles.menuTitle}>{label}</p>
        <div className={styles.swatchGrid}>
          {allowNone ? (
            <button type="button" className={styles.swatch} data-none aria-label="None" title="None" onClick={() => {
                onChange(null);
                setOpen(false);
              }} />
          ) : null}
          {all.map(swatch => (
            <button
              key={`${swatch.name}-${swatch.color}`}
              type="button"
              className={styles.swatch}
              aria-label={swatch.name}
              title={swatch.name}
              data-current={swatch.color?.toLowerCase() === value?.toLowerCase() || undefined}
              style={{ background: swatch.color ?? "transparent" }}
              onClick={() => {
                onChange(swatch.color);
                setOpen(false);
              }}
            />
          ))}
        </div>
        <label className={styles.customColor}>
          <span>Any colour</span>
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(value ?? "") ? value! : "#1f5fb8"} onChange={event => onChange(event.target.value)} aria-label={`${label}: any colour`} />
        </label>
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
