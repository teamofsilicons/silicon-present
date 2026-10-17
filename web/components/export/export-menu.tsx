"use client";

/**
 * Download a deck in any format Present writes (UNDERSTANDING.md "Formats"): PowerPoint, Keynote, OpenDocument, PDF,
 * a web page, or images. Each item is a plain link to `/api/v1/decks/{id}/export?format=…`; the proxy streams the
 * file with the service's `Content-Disposition` (named after the deck), so the browser saves it as a normal download.
 *
 *   import { ExportMenu } from "@/components/export";
 *   <ExportMenu deck={deck.id} />                         the whole deck, live
 *   <ExportMenu deck={deck.id} version={42} />            the deck as it was at version 42
 *   <ExportMenu deck={deck.id} slide={slideId} />         one slide (images give one picture, not a .zip)
 *
 * Anyone who can view the deck can download it, public visitors too.
 */
import { Download } from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "@/components/menu/action-menu";
import { exportUrl, renderUrl } from "@/lib/present/files";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/present/types";

export interface ExportMenuProps {
  deck: string;
  version?: number | null;
  slide?: string | null;
  /** The trigger's words (default "Download"). */
  label?: string;
  /** Only these formats (default: all). */
  formats?: ExportFormat[];
  /** The deck's title, for the file name of a one-slide picture (the service names every other download itself). */
  title?: string;
  iconOnly?: boolean;
  align?: "start" | "end";
  className?: string;
}

export function ExportMenu({ deck, version, slide, label = "Download", formats, title, iconOnly = false, align = "end", className }: ExportMenuProps) {
  const items: ActionMenuItem[] = EXPORT_FORMATS.filter(entry => !formats || formats.includes(entry.format)).map((entry, index) => {
    // One slide as a picture is that slide's render (an image), not the export's .zip of one image.
    const picture = !!slide && (entry.format === "png" || entry.format === "jpg");
    return {
      label: `${entry.label} (${picture ? `.${entry.format}` : entry.extension})`,
      hint: picture ? "This slide as one picture" : entry.note,
      href: picture ? renderUrl(deck, slide!, { format: entry.format as "png" | "jpg", width: 1920, version }) : exportUrl(deck, entry.format, { version, slide }),
      download: picture ? `${(title || "Slide").replace(/[\\/:*?"<>|]/g, "-")}.${entry.format}` : true,
      separatorBefore: index > 0 && (entry.format === "pdf" || entry.format === "png"),
    };
  });
  return <ActionMenu label={label} icon={<Download size={16} strokeWidth={1.75} />} items={items} iconOnly={iconOnly} align={align} className={className} menuLabel={`Download formats`} />;
}
