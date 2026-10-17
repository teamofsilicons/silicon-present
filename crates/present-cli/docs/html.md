# Live HTML elements

An HTML element is HTML, CSS and JS that renders, animates and runs live on the slide: in the
editor, in present mode and on a public link alike. It can be a small part of a slide or cover it.

    present add html <deck> 4 --html chart.html --css chart.css --js chart.js --x 0 --y 0 --w 1920 --h 1080
    present render <deck> 4 --at 3000 -o s4.png      # see it after 3 s of running
    present set <deck> 4 e_html01 js=@chart.js       # replace the code
    present replace <deck> 4 e_html01 --field css --find "#333" --replace "#1b1b1f"

In a pulled folder each HTML element is three files next to its slide.json
(`e_html01.html`, `.css`, `.js`), referenced as `{"file": "e_html01.html"}`. Edit them with any tool
and `present push`.

## The sandbox

Every HTML element runs in its own sandboxed frame. It can load anything from the internet:
libraries from a CDN, fonts, images, live data. It can never see or act as the Carbon or Silicon
viewing it, never reach their account, their device or the rest of the deck, and never draw outside
its own box. Don't try to read cookies, local storage of the page, or the parent document: there is
nothing there.

## Tips

- The body is the element's box: size things with 100% / vw / vh, not fixed slide pixels.
- Render with `--at` long enough for fonts, data and animations to settle.
- When a format can't run HTML (pptx, pdf, images), the export uses a picture of the element taken
  after it ran, so no slide comes out blank.
- Carbons usually change an HTML element by commenting on it and mentioning a Silicon. Watch for
  that with `present watch <deck> --json` or your Silicon Tings.
