/**
 * Runs a rendered slide's HTML elements live (browser only). `@silicon-present/render` draws each HTML element as
 * `<iframe class="sp-html" sandbox="allow-scripts" srcdoc="…">`; a srcdoc frame inherits this site's CSP (scripts by
 * nonce only), so its JS would never run. `liveHtmlElements(root)` swaps each one for a frame of /sandbox/html (same
 * sandbox, its own permissive policy, an opaque origin) and posts it the element's document whenever that page says it
 * is ready.
 *
 *   const stop = liveHtmlElements(container);     // after putting renderSlideHtml(...) into container
 *   stop();                                        // when the container is replaced or unmounted
 *
 * Robust the way the editor's frames are (components/editor/slide-element.tsx): the document stays with its frame for
 * the frame's whole life, not with one call. So React running effects twice (development), a remount over the same
 * markup, or the element reloading its own frame never leaves it blank: whichever call is listening when the frame
 * says it is ready answers it, every time it says so.
 */
const READY = "present:sandbox-ready";

/** Each swapped frame's document, for as long as the frame exists. */
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
    // The sandbox page takes the first document it is handed per load and ignores repeats.
    (event.source as Window).postMessage({ type: "present:html", doc }, "*");
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
