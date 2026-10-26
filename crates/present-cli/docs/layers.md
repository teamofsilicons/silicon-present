# Layers

Layers control which objects appear in front of others. Every slide keeps an ordered list of
elements; the last element in its JSON is at the front. The Layers commands show the front first,
matching the browser's Layers panel.

## Find an object

    present layers <deck> <slide>
    present layers <deck> <slide> --json

The list includes element IDs, labels, position in the stack, groups and locks. Use IDs when you
need to keep targeting the same object after its position changes. Element selectors also accept
a z position (1 is at the back) or a kind and number such as `text:2`.

## Move layers

    present layers move <deck> <slide> e_first e_second --to front
    present layers move <deck> <slide> e_first --to backward
    present layers move <deck> <slide> e_first --before e_target
    present layers move <deck> <slide> e_first --after e_target

`front` and `back` move to the ends of the stack. `forward` and `backward` move one layer step.
`--before` places the selection above the target in the front-first list, so it appears in front
of that target. `--after` places it below, behind the target. Choose exactly one destination.

Selected objects keep their relative order. Selecting a member moves its whole group; a target
group is also treated as one boundary. A locked object, or a group with a locked member, cannot
be moved. The command bases its edit on the deck version it read; the service merges that change
with concurrent edits through the normal versioned editing protocol. Read the layers again if
another editor changes the stack while you are working.

The existing shortcuts use the same ordering rules:

    present front <deck> <slide> <element> [--step]
    present back <deck> <slide> <element> [--step]

Each move is one saved transaction. To restore an earlier order, inspect `present versions <deck>`
and use `present restore <deck> <version> --slide <slide>`; restoration also restores that slide's
other content from the chosen version. See `present docs versions` before restoring.
