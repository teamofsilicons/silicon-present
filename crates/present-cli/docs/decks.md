# Decks, folders, trash and transfers

Decks are personal: every deck belongs to the Carbon or Silicon who created it. You have your own
decks, and the decks and folders shared with you.

    present list                         # yours
    present list --shared                # shared with you
    present list --trash
    present list --folder fd8Kq2mP9xRt
    present new "Q4 review" [--folder <id>] [--from <deck>@<version>]
    present rename <deck> "New title"
    present move <deck> <folder>|root

A deck created inside someone else's shared folder belongs to that folder's owner and still shows
you as its creator.

## Naming a deck

`<deck>` can be the 12-character id, a link that contains `/decks/<id>`, or the exact title of a
deck you can see (if two decks share a title, use the id).

## Opening files

    present open board.pptx              # a new deck (pptx, ppt, key, odp, pdf, html, images, video, audio)
    present open v2.pptx --into <deck>   # opened on top of a deck: becomes its next version

Nothing is dropped on the way in: what the converter can't model becomes a picture of that part.
Google Slides decks open through their .pptx download.

## Folders

    present folder list [--parent <id>] [--shared] [--trash]
    present folder new "Clients" [--parent <id>]
    present folder rename <id> "Clients 2026"
    present folder move <id> <parent>|root
    present folder share <id> c:ada --role editor      # shares everything in it, also what is added later
    present folder trash <id>  /  present folder untrash <id>

## Trash and deleting

    present trash <deck>                 # with its whole history
    present untrash <deck>
    present delete <deck> --permanent    # only from the trash; asks you to type the title
    present delete <deck> --permanent --confirm "Old draft"     # no terminal: confirm with the title

Permanent deletion is the only way anything in Silicon Present is ever truly gone.

## Transfers

    present transfer <deck> c:ada              # (or a folder with --folder) they must accept
    present transfers                           # offered to you and by you
    present transfers accept|decline|cancel <id>
