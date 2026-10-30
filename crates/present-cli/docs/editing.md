# Editing

Every command here turns into edit ops sent in one transaction: the whole change appears at once
for everyone, highlighted with your name, and it only touches the slide or element you name, so it
merges cleanly with anyone else's edits.

## Slides

    present slide add <deck> [--after N|--first] [--layout L] [--title T] [--subtitle S] [--body B] [--right R] [--caption C] [--notes N]
    present slide duplicate <deck> <slide>
    present slide move <deck> <slide> --after <slide> | --first
    present slide delete <deck> <slide>
    present slide skip <deck> <slide> [--off]
    present slide section <deck> <slide> "Results" | --clear
    present slide notes <deck> <slide> ["text" | --file f | -]
    present slide transition <deck> <slide> fade|push|wipe|zoom|cover|none [--duration ms] [--direction left|right|up|down]
    present slide background <deck> <slide> "#111214" | image.jpg | https://… | none [--fit cover|contain]
    present slide layout <deck> <slide> <layout>
    present slide master <deck> <slide> [--hide]

Layouts: title, title-body, two-columns, section, title-only, image-caption, blank. Each one adds the
same placeholders as the web editor.

## Elements

    present add text  <deck> <slide> "text" [--x --y --w --h] [--size --bold --italic --color --font --align --heading --list --fill --valign --link]
    present add shape <deck> <slide> <shape> [--text T] [--fill] [--stroke] [--stroke-width]
    present add image <deck> <slide> photo.png|https://…|asset:<id> [--alt] [--fit cover|contain|fill]
    present add video <deck> <slide> demo.mp4 [--poster p.png] [--autoplay] [--loop] [--muted]
    present add audio <deck> <slide> intro.mp3 [--autoplay] [--loop]
    present add table <deck> <slide> --csv data.csv [--header] | --rows R --cols C --cell r,c=text ...
    present add chart <deck> <slide> --type bar|column|line|area|pie|donut|scatter --labels a,b --series "Name=1,2[@#hex]" [--title] [--no-legend]
    present add html  <deck> <slide> --html w.html [--css w.css] [--js w.js]      (see: present docs html)

Add `--master` to put the element on the master (drawn under every slide). Local files are uploaded
as assets first. Positions are slide pixels (1920×1080 unless the deck says otherwise); each command
prints the new element id on its first line.

Shapes: rect, round-rect, ellipse, triangle, right-triangle, diamond, pentagon, hexagon, octagon,
star, arrow-right, arrow-left, arrow-up, arrow-down, chevron, line, callout, heart, cloud, plus.

## Changing elements

    present set <deck> <slide> <element> key=value ...

Values are JSON when they parse as JSON, else text; dotted keys change one key of a plain value;
`@file` reads a file. Examples:

    present set <deck> 2 e_ab12cd x=100 y=200 w=800 rotation=5
    present set <deck> 2 text:1 text="New title" style.fill=#fff8f5 style.radius=24
    present set <deck> 2 e_ab12cd locked=true group=g1 link=https://example.com
    present set <deck> 2 e_ab12cd 'animation={"effect":"fly-in","trigger":"click","order":1,"duration":500,"delay":0,"direction":"left"}'
    present set <deck> 3 e_tab001 'cells=[[{"text":"A","fill":null}]]'

Grouping, locking, aligning and animating are all fields: `group`, `locked`, `x`/`y`, `animation`.

## Find and replace

    present replace <deck> <slide> [<element>] --find "exact passage" --replace "new" [--all] [--field text|notes|html|css|js|cell:r:c]

Only the passage changes: formatting of the rest and anyone's concurrent typing survive. It fails with
`text_not_found` (the hint shows the closest match) or `text_ambiguous` (pass `--all` or a longer
passage).

## Order, delete, theme

    present layers <deck> <slide>
    present layers move <deck> <slide> <elements>... --to front|back|forward|backward
    present layers move <deck> <slide> <elements>... --before <target> | --after <target>
    present front|back <deck> <slide> <element> [--step]
    present delete <deck> <slide> <element>
    present theme <deck> Paper|Ivory|Ink|Slate|Forest|Coral|Mono|<your theme> [--heading F] [--body F] [--color accent=#hex]
    present theme <deck> --save <name>        save the deck's theme (fonts, colours, uploaded fonts) to your themes
    present theme --list                      the built-in themes and yours
    present theme --rename <name|id> --to <new name>
    present theme --delete <name|id>

Your themes belong to your account and work in any deck you can edit: `present theme <deck> Brand`
copies the theme's uploaded fonts into that deck. Editors of a shared deck can `--save` its theme as
their own copy; later changes to either don't affect the other.

Layers are listed front first. Moves preserve selection order, keep groups together and respect
locks. `--before` means in front of the target; `--after` means behind it. See `present docs layers`.

## Undo

There is no undo stack in the CLI: every change is a version. Bring back what you need with
`present restore <deck> <version> [--slide] [--element]` (see: present docs versions).

## Em dashes in Silicon writing

When signed in as a Silicon, the CLI replaces `—` with `-` in outgoing authored
text, including titles, edits, notes and comments. Carbon sessions preserve text.
Exact-match search text and comment anchors are preserved so existing passages can
still be found. Reading, copying/restoring existing content and binary imports do
not rewrite the original file.

Pass `--dangerously-use-em-dash` to preserve em dashes for that command only:

```sh
present --dangerously-use-em-dash reply THREAD "Keep this — intentionally"
```

The override also lasts for the duration of a long-running command. It is never
saved in the sign-in session; the next command returns to the default.

## At most 50 words on a slide

A slide holds up to 50 words from the CLI: text boxes, text in shapes and table cells
count; notes, charts, images and HTML don't. `add`, `slide add` and `set text=` refuse
a change that adds words past 50 with `slide_too_text_heavy`. Prefer graphical elements
(a chart, a diagram, an image, a split into two slides) to carry the idea. Shortening
text is always allowed. If the text really belongs there, pass
`--dangerously-add-long-text` for that command only:

```sh
present add text <deck> 3 "The full quote, as said" --dangerously-add-long-text
```
