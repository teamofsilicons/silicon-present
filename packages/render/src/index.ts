// @silicon-present/render: the single definition of how a Silicon Present slide looks.
export { renderSlideHtml, renderSlideDocument, renderElementHtml, slideSteps, transitionCss, fontCss, deckFonts, scaleToFit, resolveSrc, backgroundCss, htmlElementDoc } from "./slide";
export type { RenderOptions, StepInfo, TransitionCss } from "./slide";
export { renderDeckHtml, scriptJson, DECK_JSON_ID, DECK_ASSETS_ID } from "./deck";
export type { DeckHtmlOptions, EmbeddedAsset } from "./deck";
export { SLIDE_CSS, slideCss, BODY_SIZE, HEADING_SIZES, TABLE_SIZE } from "./css";
export { richTextHtml } from "./text";
export { chartSvg, niceScale, formatNumber } from "./chart";
export { shapeGeometry } from "./shapes";
export { escapeHtml, fontStack } from "./safe";
