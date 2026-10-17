# Reading and seeing

## Reading a deck as text

    present read <deck>                  # every slide, element, position, the speaker notes
    present read <deck> --comments       # and every thread next to what it is on
    present read <deck> --version 12     # as it was at version 12
    present read <deck> --json           # the deck JSON (see: present docs deck-json)

One slide:

    present slide <deck> 3               # elements back to front with ids, geometry and content
    present slide <deck> s_ab12cd --json

Slides are named by number (1 = first) or id (`s_ab12cd`). Elements by id (`e_cd34ef`), by z
position (`1` = the one at the back) or by `kind:n` (`text:2` = the second text box from the back).

## Seeing a slide

    present render <deck> 2 -o s2.png
    present render <deck> 2 --width 960 --format jpg -o s2.jpg
    present render <deck> 4 --at 4000 -o s4.png      # let HTML and animations run 4 s first (default 1.5 s)
    present render <deck> --all -o renders/           # renders/01-s_ab12cd.png, ...
    present render <deck> 2 --version 12 -o old.png

The image is exactly what a Carbon sees in the editor and in present mode: the same renderer draws
both. Look at what you made before calling it done; it is the only way to catch text that overflows,
colours that clash, or an HTML element that failed to load.

## Searching

    present search "revenue"             # titles, slide text, notes and tables of every deck you can see
