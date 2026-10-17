"use client";

/**
 * Other people on the canvas: each one's selection outline and cursor with their name in their colour, and a brief
 * highlight of every element a remote change touched, labelled with who made it (a Silicon's change arrives as one
 * update, so its whole change lights up at once).
 */
import type { Element } from "@silicon-present/deck";
import { useStore } from "@/lib/editor/store";
import { nameOf } from "@/lib/editor/normalize-api";
import { colorFor, safeColor } from "@/lib/editor/people";
import { useEditor } from "./editor-context";
import styles from "./editor.module.css";

export function CanvasPresence({ slideId, elements, scale }: { slideId: string; elements: Element[]; scale: number }) {
  const editor = useEditor();
  const { others } = useStore(editor.presence, state => state);
  const { list } = useStore(editor.touches, state => state);
  const here = others.filter(other => other.slide === slideId);
  const byId = new Map(elements.map(element => [element.id, element]));
  const touched = list.filter(touch => touch.slideId === slideId && touch.elementId && byId.has(touch.elementId));
  const label = 12 / scale;
  const line = 2 / scale;
  return (
    <>
      {here.flatMap(other => {
        const color = safeColor(other.color, other.account?.uuid ?? other.session);
        return other.selection
          .map(id => byId.get(id))
          .filter(Boolean)
          .map(element => (
            <div
              key={`${other.session}/${element!.id}`}
              className={styles.remoteSelection}
              data-testid="remote-selection"
              style={{ left: element!.x, top: element!.y, width: element!.w, height: element!.h, transform: element!.rotation ? `rotate(${element!.rotation}deg)` : undefined, outline: `${line}px solid ${color}` }}
            >
              <span className={styles.remoteName} style={{ background: color, fontSize: label, padding: `${2 / scale}px ${6 / scale}px`, top: -label * 1.9 }}>
                {nameOf(other.account)}
              </span>
            </div>
          ));
      })}
      {touched.map(touch => {
        const element = byId.get(touch.elementId!)!;
        const color = colorFor(touch.author?.uuid ?? touch.author?.id);
        return (
          <div
            key={`${touch.at}/${touch.elementId}`}
            className={styles.changeFlash}
            data-testid="change-highlight"
            data-author={touch.author?.id ?? ""}
            style={{ left: element.x, top: element.y, width: element.w, height: element.h, transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined, outline: `${line * 1.5}px solid ${color}` }}
          >
            <span className={styles.remoteName} style={{ background: color, fontSize: label, padding: `${2 / scale}px ${6 / scale}px`, top: -label * 1.9 }}>
              {nameOf(touch.author)}
            </span>
          </div>
        );
      })}
      {here
        .filter(other => other.cursor)
        .map(other => {
          const color = safeColor(other.color, other.account?.uuid ?? other.session);
          return (
            <div key={`c/${other.session}`} className={styles.cursor} data-testid="remote-cursor" style={{ left: other.cursor!.x, top: other.cursor!.y, transform: `scale(${1 / scale})` }}>
              <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true">
                <path d="M1 1l6.5 19 2.6-7.6L17.6 10z" fill={color} stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              <span className={styles.cursorName} style={{ background: color }}>
                {nameOf(other.account)}
              </span>
            </div>
          );
        })}
    </>
  );
}
