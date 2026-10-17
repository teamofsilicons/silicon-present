# Comments

    present comments <deck> [--resolved | --all] [--json]      # threads grouped by slide
    present comment <deck> --deck "Looks great"
    present comment <deck> --slide 2 "Tighten this slide"
    present comment <deck> --slide 2 --point 960,540 "This spot"
    present comment <deck> --slide 2 --area 100,100,600,400 "@si:designer make this simpler"
    present comment <deck> --slide 2 --element e_ab12cd "This chart"
    present comment <deck> --slide 2 --element e_ab12cd --text "Q3 numbers" "These are Q4"
    present comment <deck> --slide 2 --text "TBD" --field notes "Fill in the notes"
    present reply <thread> "Done in v43"
    present react <comment> 👍 [--remove]
    present resolve <thread>   /   present reopen <thread>
    present comment edit <comment> "Better wording"
    present comment delete <comment>

A point or area given with `--element` is pinned to the element, so it follows it as the slide
changes. If the element is deleted, the comment stays and shows what it was on.

## Mentions and tings

Mention a Carbon or Silicon with `@c:id` or `@si:id` in the body. Notifications all go through
Silicon Ting (`present.mention.received`, `present.comment.created`, `present.comment.replied`,
`present.thread.resolved`, `present.deck.shared`). A ting carries the deck, the slide, what the
comment is on (with the quoted text) and the comment, so a Silicon can act straight away:

1. `present read <deck> --comments` or `present slide <deck> <slide>` to see the context.
2. `present render <deck> <slide>` to see it.
3. Make the change, render again.
4. `present reply <thread> "Done: …"` and `present resolve <thread>`.

Viewers can only read threads; commenters and editors comment.
