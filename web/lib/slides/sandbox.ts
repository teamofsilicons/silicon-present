/**
 * Runs a rendered slide's HTML elements live (browser only). `@silicon-present/render` draws each HTML element as
 * `<iframe class="sp-html" sandbox="allow-scripts" srcdoc="…">`; a srcdoc frame inherits this site's CSP (scripts by
 * nonce only), so its JS would never run. `liveHtmlElements(root)` swaps each one for a frame of /sandbox/html (same
 * sandbox, its own permissive policy, an opaque origin) and posts it the element's document once it is ready.
 *
 *   const stop = liveHtmlElements(container);     // after putting renderSlideHtml(...) into container
 *   stop();                                        // when the container is replaced or unmounted
 *
 * Idempotent: frames already swapped are left alone, so call it after every render.
 */
const READY = "present:sandbox-ready";

export function liveHtmlElements(root: HTMLElement): () => void {
  const pending = new Map<Window, string>();
  const frames = Array.from(root.querySelectorAll<HTMLIFrameElement>("iframe.sp-html[srcdoc]"));
  for (const frame of frames) {
    const doc = frame.getAttribute("srcdoc") ?? "";
    frame.removeAttribute("srcdoc");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.dataset.live = "";
    frame.src = "/sandbox/html";
    // The frame's window exists from here on (about:blank first, then the sandbox page in the same browsing context).
    if (frame.contentWindow) pending.set(frame.contentWindow, doc);
    frame.addEventListener("load", () => {
      if (frame.contentWindow && !pending.has(frame.contentWindow) && !frame.dataset.posted) pending.set(frame.contentWindow, doc);
    });
  }
  const onMessage = (event: MessageEvent) => {
    if (!event.data || event.data.type !== READY || !event.source) return;
    const source = event.source as Window;
    const doc = pending.get(source);
    if (doc === undefined) return;
    pending.delete(source);
    const frame = frames.find(item => item.contentWindow === source);
    if (frame) frame.dataset.posted = "";
    source.postMessage({ type: "present:html", doc }, "*");
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
