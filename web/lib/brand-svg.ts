/** The supplied Present artwork, unchanged, for install icons, home-screen icons and Open Graph. */
export const ICON_PAPER = "#181818";
export const ICON_INK = "#EDE8E0";

/** Preserve the uploaded artwork, including the panel overlaps and their strokes. */
export function markSvg(): string {
  return "<svg width=\"200\" height=\"200\" viewBox=\"0 0 200 200\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<rect width=\"200\" height=\"200\" fill=\"#181818\"/>\n<path d=\"M20.9355 74.9355H97.6481V125.454H20.9355V74.9355Z\" fill=\"#EDE8E0\" stroke-width=\"1.87104\" stroke=\"#181818\"/>\n<path d=\"M101.936 74.9355H178.648V125.454H101.936V74.9355Z\" fill=\"#EDE8E0\" stroke-width=\"1.87104\" stroke=\"#181818\"/>\n<path d=\"M46.5265 66.5265H153.473V133.473H46.5265V66.5265Z\" fill=\"#EDE8E0\" stroke-width=\"3.05308\" stroke=\"#181818\"/>\n</svg>";
}

export const svgDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
