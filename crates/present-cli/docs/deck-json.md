# Deck JSON

`present read <deck> --json` prints it; `present pull` splits it into files; ops take parts of it.

    {
      "id": "dk7Hq2mP9xRt", "title": "Q4 review", "version": 42,
      "size": { "width": 1920, "height": 1080 },
      "theme": { "name": "Paper", "fonts": { "heading": "Inter", "body": "Inter" },
                 "colors": { "background", "text", "accent", "accent2", "accent3", "muted" }, "customFonts": [] },
      "master": { "elements": [ ... ] },
      "slides": [ { "id": "s_f3k9a2", "layout": "title", "background": null, "skipped": false, "section": null,
                    "hideMaster": false, "transition": null, "notes": "Say hello", "elements": [ ... back to front ] } ]
    }

Every position and size is in slide pixels of `size`.

## Elements

Every element: `id`, `kind`, `x`, `y`, `w`, `h`, `rotation`, `locked`, `group` (elements with the
same group id move together), `link` (a URL or `slide:<id>`), `animation`, `style`.

- `style`: `fill`, `stroke`, `strokeWidth`, `radius`, `opacity`, `shadow`, `padding`, `verticalAlign` (top|middle|bottom)
- `animation`: `{ effect: appear|fade|fly-in|zoom|wipe|rise, trigger: click|with-previous|after-previous, order, duration, delay, direction? }`
- text: `text` (rich text) · shape: `shape`, `text`
- image: `src` (`asset:<id>` or URL), `alt`, `fit` (cover|contain|fill)
- video / audio: `src`, `alt`, `autoplay`, `loop`, `muted`, video `poster`
- table: `rows`, `cols`, `colWidths`, `rowHeights`, `headerRow`, `cells` (rows of `{ text: rich text, fill }`)
- chart: `chart: { type: bar|column|line|area|pie|donut|scatter, title?, labels: [...], series: [{ name, values, color? }], legend }`
- html: `html`, `css`, `js` (strings)

## Rich text

    { "paragraphs": [ { "align"?, "list"?: "bullet"|"ordered", "indent"?: 0-8, "heading"?: 1-3, "lineHeight"?,
                        "runs": [ { "text": "Hi", "bold"?, "italic"?, "underline"?, "strike"?, "color"?, "highlight"?,
                                    "size"?, "font"?, "link"?, "code"? } ] } ] }

Attributes that are false, null or empty are left out, and neighbouring runs with the same attributes
are merged. A soft line break inside a paragraph is U+2028.

## Slide fields

`layout` (title|title-body|two-columns|section|title-only|image-caption|blank), `background`
(`null`, `{color}` or `{image, fit}`), `skipped`, `section` (a section starts here with this name),
`hideMaster`, `transition` (`{type: fade|push|wipe|zoom|cover, duration, direction?}`), `notes`.

## Assets

Uploaded files are referenced as `"asset:<id>"`. `present add image|video|audio` and `present push`
upload local files for you.
