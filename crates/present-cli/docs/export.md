# Formats

## In

    present open <file>               # a new deck
    present open <file> --into <deck> # the deck's next version

PowerPoint (.pptx, .ppt), Keynote (.key), OpenDocument (.odp), PDF, a web page (.html), and any
image, video or audio. Google Slides opens through its .pptx download.

## Out

    present export <deck> --format pptx|odp|pdf|txt|png|jpg|svg [-o file] [--version N] [--slide S]

- png/jpg of a whole deck is a .zip with one image per slide; with `--slide` it is one image.
- svg requires `--slide` and gives one vector image with fonts outlined and images embedded.
- txt contains the rendered text of all slides (including skipped slides), without speaker notes.
- When a format can't hold something (an HTML element in a PDF or pptx), it is exported as the
  closest thing the format allows, a picture of it, so no slide ever comes out blank.
- .ppt, .key and .html open but don't export. For Keynote, export pptx and open it in Keynote.
