# This file is only meant to be changed by carbons (humans), if you are an agent DONT EDIT THIS FILE.


# UNDERSTANDING.md - Present

This understanding contains the understanding for the entire Silicon Present, the service, the web editor at `present.teamofsilicons.com` and the `present` CLI.

Silicon Present is where Carbons and Silicons make, present and comment on slides together. It has everything people expect from Google Slides or PowerPoint. The difference is that Silicons are first-hand users: a Silicon can build a whole deck itself, through the CLI, as easily as a Carbon does in the web editor.

Slides can also hold live HTML that renders, animates and runs JS, so a slide can be anything a web page can be.

Silicons will mostly make and edit decks, and Carbons will mostly review and present them. So commenting has to be effortless for Carbons, and every deck has to be a comfortable place for a Silicon to work.


# Glossary

`Carbon` - The human in the system. Every human account is called a carbon.
`Silicon` - Our AI Agent account is referred to as a Silicon.
`Deck` - A single presentation in Silicon Present.
`Slide` - One page of a deck.
`Element` - Anything placed on a slide: text, an image, a shape, a table, a chart, a video, or an HTML element.
`HTML element` - An element made of HTML, CSS and JS that renders and runs live on the slide.
`Folder` - A place to keep decks and other folders together.
`Owner` - The Carbon or Silicon a deck or folder belongs to. Every deck and folder has exactly one owner.
`Comment` - A note attached to a deck, a slide, or a part of a slide. A comment and its replies are a `thread`.


# Sign in

Signing in and signing up are handled entirely by Silicon Accounts. Use the official and latest Silicon Accounts client everywhere. Carbons and Silicons are always stored by their Silicon Accounts uuid, and shown by their c:id or si:id.

Viewing a public deck never needs signing in.


# Decks and folders

Decks are personal. Every deck belongs to the Carbon or Silicon who created it. There are no Teams or workspaces. Everyone has two places: their own decks, and the decks and folders shared with them.

An owner can sort their decks into folders, and folders into other folders. A deck created inside someone else's shared folder belongs to that folder's owner, and still shows who created it.

The owner can transfer a deck or folder to another Carbon or Silicon, who has to accept before it moves. Anything deleted goes to the trash with its full history and can be restored at any time. It stays there until the owner permanently deletes it, which asks them to confirm first. That is the only way anything in Silicon Present is ever truly gone.


# Slides and elements

A slide is built from elements. Every element can be placed, resized, rotated, layered, grouped, aligned, locked and animated, whoever made it.

Carbons edit text, images, shapes, tables, charts and videos directly on the slide, just like in Google Slides or PowerPoint. Silicons can make and change every kind of element through the CLI.

## HTML elements

An HTML element can be a small part of a slide or cover the whole of it. It renders live, animates, and runs its JS, in the editor, in present mode and on a public link alike.

Carbons can move and resize an HTML element like any other element. To change what's inside it, they edit its code or, more often, comment on it and mention a Silicon.

Every HTML element runs sandboxed. It can load anything it needs from the internet, like libraries, fonts, images or live data. But it can never see or act as the Carbon or Silicon viewing it, never reach their account, their device or the rest of the deck, and never run outside its own box on the slide.

## Everything else

Every deck has what people expect: layouts, themes and masters, slide transitions, element animations, speaker notes, a slide sorter, skipped slides, sections, guides and snapping, tables, charts, video and audio, links, find and replace, and undo.


# Formats

Silicon Present opens every kind of slides and every kind of asset. Opening a file creates a new deck from it. These open:

| Format          | Extension        |
| --------------- | ---------------- |
| PowerPoint      | `.pptx`, `.ppt`  |
| Keynote         | `.key`           |
| OpenDocument    | `.odp`           |
| PDF             | `.pdf`           |
| Web page        | `.html`          |
| Images          | `.png`, `.jpg`   |

Any deck can be downloaded in exactly these formats, and no others:

| Format          | Extension                      |
| --------------- | ------------------------------ |
| PowerPoint      | `.pptx`                        |
| OpenDocument    | `.odp`                         |
| PDF             | `.pdf`                         |
| Plain text      | `.txt`                         |
| Images          | `.png`, `.jpg`, `.svg` (one slide) |

For Keynote, download `.pptx` and open it in Keynote.

Google Slides decks are opened through their export. Any image, video, audio, font, SVG or animation can be added to a slide.

Nothing is dropped on the way in. When a format can't hold something on the way out, like an HTML element in a PDF, it's exported as the closest thing that format allows, so no slide ever comes out blank.


# Sharing

Decks and folders are shared the same way. The owner, and anyone who can edit, can invite Carbons and Silicons by their c:id, si:id or email. Inviting an email that isn't on Silicon Accounts yet sends them an invite to join.

Everyone invited gets one of three roles:
- `Editor` - can edit, comment and invite others.
- `Commenter` - can view and comment.
- `Viewer` - can only view.

Carbons and Silicons get exactly the same roles and the same rights.

Sharing a folder shares everything in it, including anything added later. If someone has access both directly and through a folder, they get whichever role gives them more.

## Public decks

Any deck can be made public at any time with one switch. Anyone with the link can then view it, or, if the owner chooses, comment on it or edit it. Nothing is listed anywhere: the deck is just reachable by its link. Making it private again stops the link working.

Viewing a public deck never needs signing in. Commenting or editing through the link does, so every change and every comment always has a Carbon or Silicon behind it.


# Editing

Everyone edits the same deck at the same time and sees every change as it happens. Each Carbon and Silicon in the deck shows up with their name, pfp, cursor and the slide they're on. Silicons show up exactly like Carbons do. When a Silicon makes a change, the whole change appears at once, briefly highlighted with its name.

If a connection drops, nothing is lost. Changes made meanwhile merge back in once it returns.


# Comments

Commenting has to be as easy as pointing. For anyone who can't edit, or who is just viewing, clicking on a slide opens the comment box right there, with no button or menu in between. Editors get a small `Comment` button and a keyboard shortcut.

A comment can be on:
- a point on a slide, by clicking it
- an area of a slide, by dragging over it
- an element, including an HTML element while it's running
- some text inside an element
- a whole slide
- the whole deck

Comments can be replied to, reacted to, edited and resolved. Resolved threads can be reopened. A comment follows its element as the slide changes. If the element is deleted, the comment stays, showing what it was on.

All of a deck's threads can be seen in one list, grouped by slide, and moved through one by one with the keyboard.


# Mentions and notifications

Anyone can mention a Carbon or Silicon in a comment with their c:id or si:id. All notifications go through Silicon Ting; Silicon Present never sends its own.

| Ting                         | When                                        | Sent to                |
| ---------------------------- | ------------------------------------------- | ---------------------- |
| `present.mention.received`   | Someone mentions you in a comment           | The one mentioned      |
| `present.comment.created`    | Someone comments on your deck               | The owner              |
| `present.comment.replied`    | Someone replies in a thread you're in       | Everyone in the thread |
| `present.thread.resolved`    | A thread you started is resolved            | Who started it         |
| `present.deck.shared`        | A deck or folder is shared with you         | The one invited        |

A ting carries enough for a Silicon to act straight away: the deck, the slide, what the comment is on, and the comment itself. Mentioning a Silicon is how a Carbon asks it for something, for example dragging over a chart and writing "@si:designer make this simpler".


# Presenting

Any deck can be presented full screen, with a presenter view showing speaker notes, the next slide and a timer. HTML elements run live while presenting.

A presentation can be followed live through a link, so everyone watching stays on the slide being shown.

Silicons can present too: a Silicon can start a presentation and move through it, and everyone following sees it live.


# Versions

Everything in Silicon Present is versioned, and nothing is ever lost. There is no save button: every change is saved the moment it's made.

Every change to a deck is kept for as long as the deck exists, with who made it and when, whether it was a Carbon or a Silicon. Changes are grouped into versions automatically, so the history reads as a list of who did what, for example "si:designer rebuilt slide 4". Anyone who can edit can also name a version, like `Sent to the client`.

Anyone who can edit can open a deck exactly as it was at any version, compare two versions slide by slide, restore a whole version, bring back a single slide or element, undo everything one Carbon or Silicon changed since a given version, or make a new deck from any older version.

Going back never deletes anything. Restoring is itself a new version. No change ever silently replaces another: when two changes meet, both are kept and merged, and anything that can't be merged is shown, with both sides kept in the history.


# Silicons

The `present` CLI is how Silicons use Silicon Present, and it can do everything the web editor can.

- **Reading** - any deck can be read as text: every slide, its elements, their positions, the speaker notes, and the comments next to what they're on.
- **Seeing** - any slide can be rendered to an image, so a Silicon can look at what it made, the same way a Carbon would see it.
- **Editing** - a Silicon changes exactly the slide or element it means to, not the whole deck, so its change merges cleanly with whatever anyone else is doing.
- **Working in a folder** - `present pull` brings a deck down as a folder, with HTML elements as their own files and assets alongside. A Silicon can work on it with any tools it likes, and `present push` merges its changes back.
- **Comments** - a Silicon can read, write, reply to, react to and resolve comments, exactly like a Carbon.
- **Presenting** - a Silicon can start a presentation and move through its slides.
- **Versions** - a Silicon can list, read, compare, name and restore versions.


# Look and feel

The web editor at `present.teamofsilicons.com` is built entirely with Silicon UI (`ui.teamofsilicons.com`), our design system for every Silicon website.


# What it is not

Silicon Present is just normal slides. It is not a docs editor, a website builder, a video editor or a place to publish or list decks. There are no Teams.
