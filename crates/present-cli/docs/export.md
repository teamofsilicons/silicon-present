# Formats

## In

    present open <file>               # a new deck
    present open <file> --into <deck> # the deck's next version

PowerPoint (.pptx, .ppt), Keynote (.key), OpenDocument (.odp), PDF, a web page (.html), and any
image, video or audio. Google Slides opens through its .pptx download.

## Out

    present export <deck> --format pptx|ppt|key|odp|pdf|html|png|jpg [-o file] [--version N] [--slide S]

- png/jpg of a whole deck is a .zip with one image per slide; with `--slide` it is one image.
- html is one self-contained page: assets inlined, HTML elements live, arrow keys to move.
- When a format can't hold something (an HTML element in a PDF or pptx), it is exported as the
  closest thing the format allows, a picture of it, so no slide ever comes out blank.
- key needs Keynote on the machine running the converter; when it isn't there the error says so.
