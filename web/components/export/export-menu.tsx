"use client";

/**
 * Download a deck as PowerPoint, OpenDocument, PDF or plain text, or the current slide as JPEG, PNG or SVG.
 * Each item is a plain link to `/api/v1/decks/{id}/export?format=…`; the proxy streams the
 * file with the service's `Content-Disposition` (named after the deck), so the browser saves it as a normal download.
 *
 *   import { ExportMenu } from "@/components/export";
 *   <ExportMenu deck={deck.id} />                         the whole deck, live
 *   <ExportMenu deck={deck.id} version={42} />            the deck as it was at version 42
 *   <ExportMenu deck={deck.id} slide={slideId} />         the whole deck, plus the current slide as an image
 *
 * Image downloads need a current slide; deck formats always download the whole deck.
 * Anyone who can view the deck can download it, public visitors too.
 */
import { Download } from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "@/components/menu/action-menu";
import { exportUrl } from "@/lib/present/files";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/present/types";

export interface ExportMenuProps {
  deck: string;
  version?: number | null;
  /** The slide on screen, used for JPEG, PNG and SVG downloads. */
  slide?: string | null;
  /** The trigger's words (default "Download"). */
  label?: string;
  /** Only these formats (default: all). */
  formats?: ExportFormat[];
  iconOnly?: boolean;
  align?: "start" | "end";
  className?: string;
}

export function ExportMenu({ deck, version, slide, label = "Download", formats, iconOnly = false, align = "end", className }: ExportMenuProps) {
  const items: ActionMenuItem[] = EXPORT_FORMATS.filter(entry => !formats || formats.includes(entry.format)).map(entry => ({
    label: `${entry.label} (${entry.extension}${entry.currentSlide ? ", current slide" : ""})`,
    href: entry.currentSlide && !slide ? undefined : exportUrl(deck, entry.format, { version, slide: entry.currentSlide ? slide : undefined }),
    disabled: entry.currentSlide && !slide,
    download: true,
  }));
  return <ActionMenu label={label} icon={<Download size={16} strokeWidth={1.75} />} items={items} iconOnly={iconOnly} align={align} className={className} menuLabel="Download formats" />;
}
