"use client";

/**
 * A right-click menu in Arc's dropdown look: Radix's dropdown anchored to an invisible point where the click was, so it
 * has the keyboard (arrows, type to find, Escape) of every other menu.
 */
import { Fragment, type ReactNode } from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import arc from "@/components/arc/dropdown-menu/dropdown-menu.module.css";

export interface ContextItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}

export function ContextMenu({ at, items, onClose, label }: { at: { x: number; y: number } | null; items: ContextItem[]; onClose: () => void; label: string }) {
  if (!at) return null;
  return (
    <DropdownPrimitive.Root open onOpenChange={open => !open && onClose()} modal={false}>
      <DropdownPrimitive.Trigger asChild>
        <span aria-hidden="true" style={{ position: "fixed", left: at.x, top: at.y, width: 1, height: 1, pointerEvents: "none" }} />
      </DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content className={arc.menu} data-sq="surface" align="start" sideOffset={2} collisionPadding={12} loop aria-label={label} style={{ minWidth: 220 }}>
          {items.map((item, index) => (
            <Fragment key={`${item.label}-${index}`}>
              {item.separatorBefore ? <DropdownPrimitive.Separator className={arc.separator} /> : null}
              <DropdownPrimitive.Item
                className={[arc.item, item.destructive ? arc.destructive : ""].join(" ")}
                disabled={item.disabled}
                onSelect={() => {
                  item.onSelect();
                  onClose();
                }}
              >
                {item.icon ? <span className={arc.icon} aria-hidden="true">{item.icon}</span> : null}
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.shortcut ? <kbd style={{ font: "inherit", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{item.shortcut}</kbd> : null}
              </DropdownPrimitive.Item>
            </Fragment>
          ))}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}
