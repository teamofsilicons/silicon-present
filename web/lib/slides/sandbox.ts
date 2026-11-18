/**
 * With deferHtmlDocument, the renderer stores each document in an inert attribute. The web host loads
 * /sandbox/html in the opaque frame and sends the document when the sandbox signals readiness.
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

export function liveHtmlElements(root: HTMLElement, restart = false): () => void {
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
  for (const frame of Array.from(root.querySelectorAll<HTMLIFrameElement>("iframe.sp-html"))) {
    const html = frame.getAttribute("data-sp-document") ?? frame.getAttribute("srcdoc");
    if (html !== null) {
      documents.set(frame, html);
      frame.removeAttribute("data-sp-document");
      frame.removeAttribute("srcdoc");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.dataset.live = "";
      frame.src = "/sandbox/html";
    } else if (restart && documents.has(frame)) {
      frame.src = "/sandbox/html";
    }
  }
  return () => window.removeEventListener("message", onMessage);
}
