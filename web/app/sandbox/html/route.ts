/**
 * GET /sandbox/html: the empty page every HTML element of a slide runs in (UNDERSTANDING.md "HTML elements": sandboxed,
 * can load anything from the internet, can never see or act as the viewer, reach their account, their device or the
 * rest of the deck).
 *
 * Why a page of its own: a `srcdoc` iframe inherits the CSP of the page around it, and this site's pages only run
 * scripts with their nonce, so an element's own JS would never run. lib/slides/sandbox.ts turns each rendered
 * `<iframe class="sp-html" sandbox="allow-scripts" srcdoc>` into `<iframe sandbox="allow-scripts" src="/sandbox/html">`
 * and hands it the element's document by postMessage once it loads. The frame is still sandboxed without
 * allow-same-origin, so it runs in an opaque origin: no cookies, no storage of this site, no access to the page.
 *
 * proxy.ts does not run here (its matcher leaves /sandbox/ out), so this answer sets its own headers: a policy that
 * lets the element load and run what it needs, and framing by this site only.
 */
export const dynamic = "force-static";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}</style><script>
(function(){var done=false;addEventListener("message",function(e){if(done||e.source!==parent)return;var d=e.data;if(!d||d.type!=="present:html"||typeof d.doc!=="string")return;done=true;document.open();document.write(d.doc);document.close();});parent.postMessage({type:"present:sandbox-ready"},"*");})();
</script></head><body></body></html>`;

export function GET() {
  return new Response(PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
