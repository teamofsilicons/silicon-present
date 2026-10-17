"use client";

/**
 * A menu of actions behind one trigger, in Arc's dropdown look (components/arc/dropdown-menu's styles) but with a
 * trigger of our own (an icon button for a row's "More actions", or a labelled button) and items that can be links
 * (downloads) as well as actions. Radix gives it the keyboard: arrows, Home/End, type to find, Escape.
 *
 *   <ActionMenu label="More actions for Q4 review" icon={<MoreHorizontal />} items={[{ label: "Rename", onSelect }]} />
 */
import { Fragment, type CSSProperties, type ReactNode } from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import arc from "@/components/arc/dropdown-menu/dropdown-menu.module.css";
import styles from "./action-menu.module.css";

export interface ActionMenuItem {
  label: string;
  /** A second, quieter line (what a format is, why something is unavailable). */
  hint?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  /** A link instead of an action (a download goes through the proxy with its file name). */
  href?: string;
  /** Download instead of opening: true (the answer names the file) or the file name to save it as. */
  download?: boolean | string;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
  /** A heading above this item (groups). */
  group?: string;
}

export interface ActionMenuProps {
  /** The trigger's accessible name (and its visible words unless `iconOnly`). */
  label: string;
  items: ActionMenuItem[];
  icon?: ReactNode;
  iconOnly?: boolean;
  align?: "start" | "end";
  /** "quiet" (an icon button in a row) or "button" (a bordered button with a chevron). */
  look?: "quiet" | "button";
  className?: string;
  /** Test hook / styling of the menu panel. */
  menuLabel?: string;
}

export function ActionMenu({ label, items, icon, iconOnly = false, align = "end", look = iconOnly ? "quiet" : "button", className, menuLabel }: ActionMenuProps) {
  return (
    <DropdownPrimitive.Root modal={false}>
      <DropdownPrimitive.Trigger
        type="button"
        data-sq="surface"
        aria-label={iconOnly ? label : undefined}
        className={[look === "quiet" ? styles.quiet : arc.trigger, className].filter(Boolean).join(" ")}
      >
        {icon ? <span className={look === "quiet" ? styles.quietIcon : arc.triggerIcon} aria-hidden="true">{icon}</span> : null}
        {iconOnly ? null : <span>{label}</span>}
        {look === "button" ? <ChevronDown className={arc.chevron} size={15} strokeWidth={1.8} aria-hidden="true" /> : null}
      </DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content className={`${arc.menu} ${styles.menu}`} data-sq="surface" sideOffset={6} align={align} collisionPadding={12} loop aria-label={menuLabel ?? label}>
          {items.map((item, index) => {
            const body = (
              <>
                {item.icon ? <span className={arc.icon} aria-hidden="true">{item.icon}</span> : null}
                <span className={styles.text}>
                  <span>{item.label}</span>
                  {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
                </span>
              </>
            );
            const className = [arc.item, styles.item, item.destructive ? arc.destructive : ""].filter(Boolean).join(" ");
            return (
              <Fragment key={`${item.label}-${index}`}>
                {item.separatorBefore ? <DropdownPrimitive.Separator className={arc.separator} /> : null}
                {item.group ? <DropdownPrimitive.Label className={styles.group}>{item.group}</DropdownPrimitive.Label> : null}
                {item.href ? (
                  <DropdownPrimitive.Item asChild disabled={item.disabled} className={className} style={{ "--i": index } as CSSProperties}>
                    <a href={item.href} download={typeof item.download === "string" ? item.download : item.download ? "" : undefined} onClick={item.onSelect}>{body}</a>
                  </DropdownPrimitive.Item>
                ) : (
                  <DropdownPrimitive.Item className={className} data-tone={item.destructive ? "danger" : undefined} style={{ "--i": index } as CSSProperties} disabled={item.disabled} onSelect={item.onSelect}>
                    {body}
                  </DropdownPrimitive.Item>
                )}
              </Fragment>
            );
          })}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}
