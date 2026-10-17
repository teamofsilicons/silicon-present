# Presenting and following along

    present start <deck> [--slide N]     # prints the presentation id and the follow link
    present next                         # next animation step, else next slide (skipped slides are skipped)
    present prev
    present goto 5
    present show status                  # where it is
    present stop

`next`, `prev`, `goto` and `stop` act on the last presentation started from here; pass
`--presentation <id>` for another. Everyone following the link stays on the slide being shown, and
HTML elements run live.

Follow a presentation from the CLI:

    present follow <presentation> [--json] [--count N] [--for SECONDS]

## Watching a deck live

    present watch <deck> --json [--here SLIDE] [--until EVENT] [--count N] [--for SECONDS] [--raw]

One line per event:

- `sync`: connected, with the current version
- `update`: someone changed the deck: `author`, `version`, `origin`, `summary`, `touched` slides
- `presence` / `presence_left`: who is in the deck and on which slide
- `comments`: a thread changed (new comment, reply, resolve)
- `deck`: title, sharing or other metadata changed

`--here 3` shows you in the deck on slide 3 while you watch, exactly as Carbons show up. The Yjs
payloads are left out unless `--raw`. The stream reconnects by itself.
