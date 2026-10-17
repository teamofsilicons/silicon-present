# Editor lane findings

From the editor's browser suite (lane 4340) against the real service, Silicon Accounts stack, converter and Ting
stand-in, 2026-10-17: 12/12 editor tests and 4/4 screenshot tests pass. Open items for other parts:

1. **Service — role changes don't reach open pages.** Only `PUT …/public` emits a live `deck` event
   (`crates/present-service/src/routes/sharing.rs`). Repro: Ada shares a deck with Bo as viewer, Bo opens it, Ada
   makes Bo an editor (or removes him). Expected: Bo's page learns it on the live stream. Actual: Bo stays read-only
   until he reloads; a demoted editor only finds out from a 403 on the next update. The editor already applies `role`
   from a `deck` event.
2. **packages/deck — reading notes writes to the doc.** `getTextField(doc, slide, null, "notes")` creates the notes
   `Y.Text` when it is missing, so a read-only client produces a document change. Expected: reads never change the
   doc. (The editor reads notes straight from the slide map meanwhile.)
3. **packages/deck — case-insensitive find shifts after "İ".** Replacing "plan" with "x" ignoring case in
   `"İstanbul plan"` gives the wrong range: "İ" lowercases to two characters and offsets from the lowercased text are
   used on the original. Expected `"İstanbul x"`.
4. **Pages lane — `web/lib/slides/sandbox.ts` `liveHtmlElements`** loses an HTML element's code when React strict
   mode runs the effect twice, so HTML elements go blank in dev. The editor keeps the code on the frame
   (`components/editor/slide-element.tsx`); present mode should do the same.

Known limits of the editor today: elements are selected with the mouse (arrow keys move a selection); HTML elements
run on the canvas but take clicks only in present mode; find and replace doesn't search HTML code; there's no UI for
commenting on words in speaker notes; @-suggestions list the deck's people (anyone else by exact c:/si: id); other
people's text carets inside a text box aren't drawn (their selection outline and pointer are); thumbnails show HTML
elements as a placeholder.
