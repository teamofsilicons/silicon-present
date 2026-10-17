/**
 * Runs a rendered slide's HTML elements live (browser only). `@silicon-present/render` draws each HTML element as
 * `<iframe class="sp-html" sandbox="allow-scripts" srcdoc="…">`; a srcdoc frame inherits this site's CSP (scripts by
 * nonce only), so its JS would never run. `liveHtmlElements(root)` swaps each one for a frame of /sandbox/html (same
 * sandbox, its own permissive policy, an opaque origin) and posts it the element's document once that page says it is
 * ready.
 *
 *   const stop = liveHtmlElements(container);     // after putting renderSlideHtml(...) into container
 *   stop();                                        // when the container is replaced or unmounted
 *
 * Idempotent and safe to call twice (React runs effects twice in development): the document stays with its frame
 * until it is posted, so whichever call is listening when the frame is ready answers it.
 */
const READY = "present:sandbox-ready";

/** Each swapped frame's document, until it has been handed over. */
const documents = new WeakMap<HTMLIFrameElement, string>();

export function liveHtmlElements(root: HTMLElement): () => void {
  for (const frame of Array.from(root.querySelectorAll<HTMLIFrameElement>("iframe.sp-html[srcdoc]"))) {
    documents.set(frame, frame.getAttribute("srcdoc") ?? "");
    frame.removeAttribute("srcdoc");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.dataset.live = "";
    frame.src = "/sandbox/html";
  }
  const onMessage = (event: MessageEvent) => {
    if (!event.data || event.data.type !== READY || !event.source) return;
    const frame = Array.from(root.querySelectorAll<HTMLIFrameElement>("iframe[data-live]")).find(item => item.contentWindow === event.source);
    if (!frame) return;
    const doc = documents.get(frame);
    if (doc === undefined) return;
    documents.delete(frame);
    (event.source as Window).postMessage({ type: "present:html", doc }, "*");
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
