# Versions

Everything is versioned and nothing is ever lost. There is no save: every change is saved the
moment it is made. Changes are grouped into versions automatically (a run of changes by the same
Carbon or Silicon), so the history reads as who did what.

    present versions <deck> [--json]                 # newest first, with names and events (renames, sharing, ...)
    present read <deck> --version 12                 # the deck exactly as it was
    present render <deck> 3 --version 12 -o old.png
    present compare <deck> 12 20                     # slides and elements added, removed and changed, and by whom
    present version name <deck> 42 "Sent to the client"
    present restore <deck> 12                        # the whole deck
    present restore <deck> 12 --slide s_ab12cd       # one slide
    present restore <deck> 12 --slide s_ab12cd --element e_cd34ef
    present undo-account <deck> si:intern --since 40 # undo everything one account changed after v40
    present new "Q4 (as sent)" --from <deck>@42      # a new deck from any version
    present pull <deck> old/ --version 12            # work from an old version; push merges onto today's deck

Going back never deletes anything: restoring is itself a new version. When two changes meet, both
are kept and merged.
