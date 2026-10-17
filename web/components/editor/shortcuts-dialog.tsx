"use client";

/** The "?" dialog: every keyboard shortcut of the editor. */
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { SHORTCUTS, keyLabel } from "@/lib/editor/keys";
import { useEditor, useUi } from "./editor-context";
import styles from "./editor.module.css";

export function ShortcutsDialog() {
  const editor = useEditor();
  const open = useUi(s => s.shortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={next => editor.ui.set({ shortcutsOpen: next })}>
      <DialogContent title="Keyboard shortcuts" description="Everything common has a key.">
        <div className={styles.shortcuts}>
          {SHORTCUTS.map(group => (
            <section key={group.title} className={styles.shortcutGroup}>
              <h3 className={styles.panelSectionTitle}>{group.title}</h3>
              <dl className={styles.shortcutList}>
                {group.items.map(item => (
                  <div key={item.what} className={styles.shortcutRow}>
                    <dt>{item.what}</dt>
                    <dd>
                      <kbd>{keyLabel(item.keys)}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
