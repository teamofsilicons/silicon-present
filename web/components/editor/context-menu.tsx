"use client";

/**
 * A right-click menu in Arc's dropdown look: Radix's dropdown anchored to an invisible point where the click was, so it
 * has the keyboard (arrows, type to find, Escape) of every other menu.
 */
import { Fragment, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  /** Actions that move focus into an editor or composer own their closing focus. */
  restoreFocus?: boolean;
}

export function ContextMenu({ at, items, onClose, label }: { at: { x: number; y: number } | null; items: ContextItem[]; onClose: () => void; label: string }) {
  if (!at) return null;
  return <OpenContextMenu at={at} items={items} onClose={onClose} label={label} />;
}

function OpenContextMenu({ at, items, onClose, label }: { at: { x: number; y: number }; items: ContextItem[]; onClose: () => void; label: string }) {
  // Capture before Radix moves focus into the menu; its invisible anchor cannot receive focus on close.
  const [returnFocus] = useState(() => typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [focusScope] = useState(() => returnFocus?.closest<HTMLElement>('[role="dialog"]') ?? null);
  const restoreFocus = useRef(true);
  const actionAfterClose = useRef<(() => void) | null>(null);
  return (
    <DropdownPrimitive.Root open onOpenChange={open => !open && onClose()} modal={false}>
      {typeof document !== "undefined" ? createPortal(<DropdownPrimitive.Trigger asChild>
        <span aria-hidden="true" style={{ position: "fixed", left: at.x, top: at.y, width: 1, height: 1, pointerEvents: "none" }} />
      </DropdownPrimitive.Trigger>, document.body) : null}
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content className={arc.menu} data-sq="surface" align="start" sideOffset={2} collisionPadding={12} loop aria-label={label}
          onEscapeKeyDown={event => event.stopPropagation()}
          onInteractOutside={() => { restoreFocus.current = false; }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            const action = actionAfterClose.current;
            actionAfterClose.current = null;
            // Editor/composer actions take focus only after this popup has finished its own teardown.
            if (action) { requestAnimationFrame(action); return; }
            if (!restoreFocus.current) return;
            const target = returnFocus?.isConnected ? returnFocus : focusScope?.isConnected ? focusScope.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]') : null;
            if (target && target !== document.body) target.focus({ preventScroll: true });
          }}
          style={{ zIndex: 100, minWidth: 220, maxHeight: "var(--radix-dropdown-menu-content-available-height)", overflowY: "auto", overscrollBehavior: "contain" }}>
          {items.map((item, index) => (
            <Fragment key={`${item.label}-${index}`}>
              {item.separatorBefore ? <DropdownPrimitive.Separator className={arc.separator} /> : null}
              <DropdownPrimitive.Item
                className={[arc.item, item.destructive ? arc.destructive : ""].join(" ")}
                disabled={item.disabled}
                onSelect={() => {
                  restoreFocus.current = item.restoreFocus !== false;
                  if (item.restoreFocus === false) actionAfterClose.current = item.onSelect;
                  else item.onSelect();
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
