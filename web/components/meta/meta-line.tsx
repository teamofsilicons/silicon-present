/**
 * One quiet line of facts about a row ("Deck · Owner c:ada · Edited 3 hours ago"). On a narrow screen it wraps between
 * the facts, never inside one, and a separator never starts a line (the dot that would is clipped away), so nothing is
 * cut off mid-word and no "·" dangles.
 *
 *   <MetaLine parts={["Deck", owner && `Owner ${owner.id}`, <LocalTime value={at} prefix="Edited " />]} />
 *
 * Falsy parts are left out. Server-safe.
 */
import { Fragment, type ReactNode } from "react";
import styles from "./meta-line.module.css";

export function MetaLine({ parts, className }: { parts: Array<ReactNode | null | undefined | false>; className?: string }) {
  const shown = parts.filter(part => part !== null && part !== undefined && part !== false && part !== "");
  return (
    <span className={[styles.line, className].filter(Boolean).join(" ")}>
      {shown.map((part, index) => <Fragment key={index}><span className={styles.part}>{part}</span></Fragment>)}
    </span>
  );
}
