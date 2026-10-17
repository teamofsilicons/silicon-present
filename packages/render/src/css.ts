// The base CSS every rendered slide needs, plus the keyframes for element animations and slide transitions.
// Everything is scoped under .sp-slide / .sp-* so it can sit inside the web app's own page.

export const BODY_SIZE = 44; // px, default body text on a 1920-wide slide
export const HEADING_SIZES = { 1: 112, 2: 80, 3: 56 } as const;
export const TABLE_SIZE = 30;

const ANIMATION_KEYFRAMES = `
@keyframes sp-appear { from { opacity: 0 } to { opacity: 1 } }
@keyframes sp-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes sp-zoom { from { opacity: 0; transform: scale(.3) } to { opacity: 1; transform: none } }
@keyframes sp-rise { from { opacity: 0; transform: translateY(60px) } to { opacity: 1; transform: none } }
@keyframes sp-fly-up { from { transform: translateY(1200px) } to { transform: none } }
@keyframes sp-fly-down { from { transform: translateY(-1200px) } to { transform: none } }
@keyframes sp-fly-left { from { transform: translateX(2100px) } to { transform: none } }
@keyframes sp-fly-right { from { transform: translateX(-2100px) } to { transform: none } }
@keyframes sp-wipe-right { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0 0 0 0) } }
@keyframes sp-wipe-left { from { clip-path: inset(0 0 0 100%) } to { clip-path: inset(0 0 0 0) } }
@keyframes sp-wipe-down { from { clip-path: inset(0 0 100% 0) } to { clip-path: inset(0 0 0 0) } }
@keyframes sp-wipe-up { from { clip-path: inset(100% 0 0 0) } to { clip-path: inset(0 0 0 0) } }
`;

const TRANSITION_KEYFRAMES = `
@keyframes sp-tr-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes sp-tr-fade-out { from { opacity: 1 } to { opacity: 0 } }
@keyframes sp-tr-zoom-in { from { opacity: 0; transform: scale(.85) } to { opacity: 1; transform: none } }
@keyframes sp-tr-zoom-out { from { opacity: 1; transform: none } to { opacity: 0; transform: scale(1.08) } }
@keyframes sp-tr-push-left-in { from { transform: translateX(100%) } to { transform: none } }
@keyframes sp-tr-push-left-out { from { transform: none } to { transform: translateX(-100%) } }
@keyframes sp-tr-push-right-in { from { transform: translateX(-100%) } to { transform: none } }
@keyframes sp-tr-push-right-out { from { transform: none } to { transform: translateX(100%) } }
@keyframes sp-tr-push-up-in { from { transform: translateY(100%) } to { transform: none } }
@keyframes sp-tr-push-up-out { from { transform: none } to { transform: translateY(-100%) } }
@keyframes sp-tr-push-down-in { from { transform: translateY(-100%) } to { transform: none } }
@keyframes sp-tr-push-down-out { from { transform: none } to { transform: translateY(100%) } }
@keyframes sp-tr-wipe-left-in { from { clip-path: inset(0 0 0 100%) } to { clip-path: inset(0) } }
@keyframes sp-tr-wipe-right-in { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0) } }
@keyframes sp-tr-wipe-up-in { from { clip-path: inset(100% 0 0 0) } to { clip-path: inset(0) } }
@keyframes sp-tr-wipe-down-in { from { clip-path: inset(0 0 100% 0) } to { clip-path: inset(0) } }
@keyframes sp-tr-hold { from { opacity: 1 } to { opacity: 1 } }
`;

export const SLIDE_CSS = `
.sp-slide { position: relative; overflow: hidden; box-sizing: border-box; isolation: isolate; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; contain: layout paint; }
.sp-slide *, .sp-slide *::before, .sp-slide *::after { box-sizing: border-box; }
.sp-bg { position: absolute; inset: 0; z-index: 0; background-repeat: no-repeat; background-position: center; }
.sp-layer { position: absolute; inset: 0; }
.sp-el { position: absolute; transform-origin: center center; }
.sp-in { position: absolute; inset: 0; }
.sp-text { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: visible; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; }
.sp-va-top { justify-content: flex-start; } .sp-va-middle { justify-content: center; } .sp-va-bottom { justify-content: flex-end; }
.sp-text p { margin: 0; padding: 0; position: relative; }
.sp-text p.sp-li + p.sp-li { margin-top: .3em; }
.sp-text .sp-marker { position: absolute; left: 0; white-space: nowrap; text-align: left; }
.sp-text a { color: inherit; text-decoration: underline; }
.sp-text code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: rgba(127,127,127,.16); border-radius: .2em; padding: 0 .2em; font-size: .9em; }
.sp-shape-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.sp-img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.sp-media { position: absolute; inset: 0; width: 100%; height: 100%; display: block; background: #000; object-fit: contain; }
.sp-audio { position: absolute; inset: 0; display: flex; align-items: center; gap: 12px; padding: 0 16px; border-radius: 999px; }
.sp-audio svg { flex: none; }
.sp-audio audio { flex: 1; min-width: 0; height: 60%; }
.sp-placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border: 3px dashed rgba(127,127,127,.45); border-radius: 12px; background: rgba(127,127,127,.06); }
.sp-table { position: absolute; inset: 0; width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
.sp-table td { vertical-align: middle; overflow: hidden; }
.sp-table td .sp-text { position: static; inset: auto; }
.sp-html { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: transparent; color-scheme: light; }
.sp-html-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font: 600 32px ui-monospace, Menlo, monospace; border-radius: 8px; }
.sp-link { position: absolute; inset: 0; z-index: 2; }
.sp-chart { position: absolute; inset: 0; overflow: visible; }
[data-sp-animate="1"] .sp-el > .sp-in { animation-timing-function: cubic-bezier(.2,.7,.2,1); }
${ANIMATION_KEYFRAMES}
${TRANSITION_KEYFRAMES}
`;

/** The CSS a page needs once to show rendered slides (fragments from renderSlideHtml with includeCss: false). */
export function slideCss(): string {
  return SLIDE_CSS;
}
