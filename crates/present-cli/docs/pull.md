# Working in a folder

    present pull <deck> [dir] [--version N]
    present status [dir]
    present push [dir] [--summary "…"] [--dry-run] [--no-refresh]

`pull` writes the deck as files you can work on with any tools:

    q4/
      deck.json                          id, title, version, size, theme   (edit title and theme here)
      master/slide.json                  elements under every slide
      slides/01-s_ab12cd/slide.json      the slide: layout, background, notes, ..., elements back to front
      slides/01-s_ab12cd/e_cd34ef.html   an HTML element's code (.html, .css, .js), referenced in slide.json
                                         as {"file": "e_cd34ef.html"}
      assets/<id>.<ext>                  every asset the deck uses, referenced as "asset:<id>"
      .present/base.json                 the deck exactly as pulled; push diffs against it. Don't edit.
      .present/pull.json                 the deck id, the version and the API it came from

## Changing things

- Edit any field in slide.json or deck.json. Text may be written as a plain string: it becomes rich
  text, one paragraph per line.
- New slide: make a directory under `slides/` (e.g. `02a-new/`) with a slide.json without an `id`.
- Delete a slide: delete its directory.
- Reorder: rename the directories; slides go in the order of their names (leading numbers sort
  numerically).
- New element: add it to `elements` without an `id`. Delete one: remove it. Reorder: move it in
  the array (back to front).
- New media: put the file in the folder and reference it by path (`"src": "assets/photo.png"`); push
  uploads it and swaps in `asset:<id>`.
- A field missing from your file is left as it is; set it to `null` to clear it.

## Pushing and merging

`present status` shows exactly the ops `push` would send. `push` sends only what differs from
`.present/base.json`, written against the pulled version (`base`), so the service merges your change
with anything others did since you pulled: their edits to other slides, elements and fields stay,
and concurrent text edits merge. Nothing is refused silently: an invalid file stops the push with its
path and what is wrong, and nothing is sent.

After a push the folder is refreshed to the merged deck (unless `--no-refresh`), so you can keep
working from it. `pull` refuses to overwrite a folder with changes that were not pushed unless you
pass `--force`.
