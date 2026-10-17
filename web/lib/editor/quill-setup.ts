/**
 * Quill 2, set up to speak exactly the deck's rich text attributes (docs/architecture.md, "Rich text"), so a Quill
 * delta *is* the Y.Text delta and no translation sits between them:
 *
 *   inline:    bold, italic, underline, strike, color (hex), highlight (hex), size (px number), font, link, code
 *   paragraph: align, list (bullet|ordered), indent (1-8), heading (1-3), lineHeight (number)
 *
 * Only these formats are registered (from quill/core, not the full build), so pasting from elsewhere can never bring
 * in an attribute the deck format doesn't have. Browser-only: import it dynamically.
 */
import Quill, { Parchment } from "quill/core";
import Bold from "quill/formats/bold";
import Italic from "quill/formats/italic";
import Underline from "quill/formats/underline";
import Strike from "quill/formats/strike";
import Link from "quill/formats/link";
import { Code } from "quill/formats/code";
import ListItem, { ListContainer } from "quill/formats/list";
import IndentClass from "quill/formats/indent";
import { AlignStyle } from "quill/formats/align";
import { ColorAttributor } from "quill/formats/color";
import Header from "quill/formats/header";

const { Scope, StyleAttributor } = Parchment;
type Scope = Parchment.Scope;

/** A style attributor whose value is a number (font-size in px, line-height unitless). */
class NumberAttributor extends StyleAttributor {
  constructor(
    name: string,
    cssName: string,
    private readonly unit: string,
    scope: Scope,
  ) {
    super(name, cssName, { scope });
  }

  override add(node: HTMLElement, value: unknown): boolean {
    const number = typeof value === "number" ? value : parseFloat(String(value));
    if (!Number.isFinite(number) || number <= 0) return false;
    node.style.setProperty(this.keyName, `${number}${this.unit}`);
    return true;
  }

  override value(node: HTMLElement): string {
    const raw = node.style.getPropertyValue(this.keyName);
    const number = parseFloat(raw);
    // Quill's attributor contract types values as strings; a number is what the deck stores.
    return (Number.isFinite(number) ? number : "") as unknown as string;
  }

  override canAdd(): boolean {
    return true;
  }
}

class FontAttributor extends StyleAttributor {
  override value(node: HTMLElement): string {
    return super.value(node).replace(/^["']|["']$/g, "");
  }

  override canAdd(): boolean {
    return true;
  }
}

class Heading extends Header {
  static override blotName = "heading";
  static override tagName = ["H1", "H2", "H3"];
}

let registered = false;

export function setupQuill(): typeof Quill {
  if (registered) return Quill;
  registered = true;
  const Color = new ColorAttributor("color", "color", { scope: Scope.INLINE });
  const Highlight = new ColorAttributor("highlight", "background-color", { scope: Scope.INLINE });
  const Size = new NumberAttributor("size", "font-size", "px", Scope.INLINE);
  const LineHeight = new NumberAttributor("lineHeight", "line-height", "", Scope.BLOCK);
  const Font = new FontAttributor("font", "font-family", { scope: Scope.INLINE });
  Quill.register(
    {
      "formats/bold": Bold,
      "formats/italic": Italic,
      "formats/underline": Underline,
      "formats/strike": Strike,
      "formats/link": Link,
      "formats/code": Code,
      "formats/list": ListItem,
      "formats/list-container": ListContainer,
      "formats/indent": IndentClass,
      "formats/align": AlignStyle,
      "formats/color": Color,
      "formats/highlight": Highlight,
      "formats/size": Size,
      "formats/lineHeight": LineHeight,
      "formats/font": Font,
      "formats/heading": Heading,
    },
    true,
  );
  return Quill;
}

export const QUILL_FORMATS = ["bold", "italic", "underline", "strike", "link", "code", "list", "indent", "align", "color", "highlight", "size", "lineHeight", "font", "heading"];

export type { Quill };
