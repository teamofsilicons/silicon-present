# Edit ops

`present edit <deck> --ops file.json` (or `--ops -` for stdin) sends raw ops. All ops in one request
are one transaction. The file is either an array of ops or:

    {"base": 41, "summary": "Rebuilt slide 4", "ops": [ ... ]}

With `base`, the ops are applied to the deck as it was at that version and the result is merged
into the live deck, so ops written against an older copy merge with everything that happened since.

    { "op": "update_deck",     "set": { "size"?: {width,height}, "theme"?: {...} } }
    { "op": "add_slide",       "after": "s_abc" | null,  "slide": { partial slide JSON, elements included } }
    { "op": "update_slide",    "slide": "s_abc", "set": { layout?, background?, skipped?, section?, hideMaster?, transition?, notes? } }
    { "op": "move_slide",      "slide": "s_abc", "after": "s_def" | null }
    { "op": "delete_slide",    "slide": "s_abc" }
    { "op": "add_element",     "slide": "s_abc" | "master", "element": { element JSON, id optional }, "z"?: number }
    { "op": "update_element",  "slide": "s_abc", "element": "e_123", "set": { any element fields } }
    { "op": "replace_text",    "slide": "s_abc", "element"?: "e_123", "field"?: "text"|"notes"|"html"|"css"|"js"|"cell:r:c",
                               "find": "exact passage", "replace": "new", "all"?: false }
    { "op": "reorder_element", "slide": "s_abc", "element": "e_123", "to": "front"|"back"|"forward"|"backward"|number }
    { "op": "delete_element",  "slide": "s_abc", "element": "e_123" }

- `after: null` means first. `z` is the position back to front (0 = back); leave it out for the front.
- `text`, `html`, `css`, `js` and table `cells` in `update_element` replace that field's content
  through a minimal diff, so others' concurrent typing and the formatting of untouched runs survive.
  Plain values (style, animation, chart, background, transition, theme) are replaced whole.
- In the CLI, `text` may be a plain string; it becomes rich text, one paragraph per line.
- Ids: give new slides `s_` + 6 base36 characters and new elements `e_` + 6 if you want to refer to
  them in later ops of the same request; otherwise the service makes them.

Example:

    [
      {"op": "add_slide", "after": null, "slide": {"id": "s_intro1", "layout": "title", "elements": [
        {"id": "e_title1", "kind": "text", "x": 140, "y": 300, "w": 1640, "h": 280,
         "text": {"paragraphs": [{"heading": 1, "runs": [{"text": "Hello"}]}]}}
      ]}},
      {"op": "update_slide", "slide": "s_intro1", "set": {"notes": "Smile"}}
    ]

See the element fields in `present docs deck-json`.
