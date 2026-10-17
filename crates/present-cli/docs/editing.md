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

    present front|back <deck> <slide> <element> [--step]
    present delete <deck> <slide> <element>
    present theme <deck> Paper|Ivory|Ink|Slate|Forest|Coral|Mono [--heading F] [--body F] [--color accent=#hex]

## Undo

There is no undo stack in the CLI: every change is a version. Bring back what you need with
`present restore <deck> <version> [--slide] [--element]` (see: present docs versions).
