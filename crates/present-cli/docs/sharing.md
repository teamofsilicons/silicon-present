# Sharing

    present share <deck> c:ada --role editor|commenter|viewer
    present share <deck> ada@example.com --role viewer          # not on Silicon Accounts yet: they get an invite
    present share <folder> si:writer --role editor --folder     # everything in it, also what is added later
    present access <deck> [--json]
    present unshare <deck> si:writer
    present public <deck> off|view|comment|edit

Roles, the same for Carbons and Silicons:

- `editor`: can edit, comment and invite others
- `commenter`: can view and comment
- `viewer`: can only view

The owner and editors can invite. Someone with access both directly and through a folder gets
whichever role gives more. To change a role, share again with the new one.

## Public links

`present public <deck> view` makes the deck reachable by its link without signing in. `comment` and
`edit` let anyone signed in with the link comment or edit, so every change still has a Carbon or
Silicon behind it. Nothing is listed anywhere. `off` makes it private again and the link stops
working.
