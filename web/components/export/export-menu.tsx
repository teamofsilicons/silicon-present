"use client";

/**
 * Download a deck in any format Present writes (UNDERSTANDING.md "Formats"): PowerPoint, Keynote, OpenDocument, PDF,
 * a web page, or images. Each item is a plain link to `/api/v1/decks/{id}/export?format=…`; the proxy streams the
 * file with the service's `Content-Disposition` (named after the deck), so the browser saves it as a normal download.
 *
 *   import { ExportMenu } from "@/components/export";
 *   <ExportMenu deck={deck.id} />                         the whole deck, live
 *   <ExportMenu deck={deck.id} version={42} />            the deck as it was at version 42
 *   <ExportMenu deck={deck.id} slide={slideId} />         the whole deck, plus "This slide" as one PNG or JPG
 *
 * The formats always give the whole deck (a download from the editor is the deck people expect); with `slide`, the
 * slide on screen is offered as a picture too. Anyone who can view the deck can download it, public visitors too.
 */
import { Download } from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "@/components/menu/action-menu";
import { exportUrl } from "@/lib/present/files";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/present/types";

export interface ExportMenuProps {
  deck: string;
  version?: number | null;
  /** The slide on screen: offered as one picture besides the whole deck's formats. */
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
  const items: ActionMenuItem[] = EXPORT_FORMATS.filter(entry => !formats || formats.includes(entry.format)).map((entry, index) => ({
    label: `${entry.label} (${entry.extension})`,
    hint: entry.note,
    href: exportUrl(deck, entry.format, { version }),
    download: true,
    separatorBefore: index > 0 && (entry.format === "pdf" || entry.format === "png"),
  }));
  if (slide) {
    for (const [index, format] of (["png", "jpg"] as const).entries()) {
      if (formats && !formats.includes(format)) continue;
      items.push({
        label: `${format.toUpperCase()} image (.${format})`,
        group: index === 0 ? "This slide" : undefined,
        separatorBefore: index === 0,
        href: exportUrl(deck, format, { version, slide }),
        download: true,
      });
    }
  }
  return <ActionMenu label={label} icon={<Download size={16} strokeWidth={1.75} />} items={items} iconOnly={iconOnly} align={align} className={className} menuLabel="Download formats" />;
}
