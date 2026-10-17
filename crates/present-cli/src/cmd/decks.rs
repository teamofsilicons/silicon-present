//! Decks and folders: list, new, open, rename, move, trash, untrash, delete, transfers, folder.

use crate::args::{FolderCmd, TransferAction};
use crate::cmd::auth::confirm_typed;
use crate::ctx::{Ctx, to_value};
use crate::fail::{Fail, R};
use serde_json::{Value, json};
use silicon_present_client::{Client, Deck, Folder, FromVersion, NewDeck, ResourceKind, Scope};
use std::path::Path;

fn scope(shared: bool, trash: bool) -> Scope {
    if trash {
        Scope::Trash
    } else if shared {
        Scope::Shared
    } else {
        Scope::Mine
    }
}

fn deck_line(d: &Deck) -> String {
    let owner = d.owner.as_ref().map(|o| o.label().to_owned()).unwrap_or_default();
    let role = d.role.clone().unwrap_or_default();
    let public = d.public.as_deref().filter(|p| *p != "off").map(|p| format!("  public:{p}")).unwrap_or_default();
    let when = d.updated_at.clone().or_else(|| d.trashed_at.clone()).unwrap_or_default();
    format!("{}  {:<40}  {:<14} {:<9} {}{}", d.id, d.title, owner, role, when, public)
}

pub async fn list(ctx: &Ctx, shared: bool, trash: bool, folder: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let raw = c.decks_raw(scope(shared, trash), folder).await?;
    let decks = c.decks(scope(shared, trash), folder).await?;
    if ctx.json {
        // Keep everything the service sent (folders too, when it sends them alongside).
        let v = if raw.is_array() { json!({ "decks": decks }) } else { raw };
        ctx.print_json(&v);
        return Ok(());
    }
    let folders: Vec<Folder> = raw
        .get("folders")
        .and_then(|f| serde_json::from_value(f.clone()).ok())
        .unwrap_or_default();
    for f in &folders {
        println!("{}  {}/", f.id, f.name);
    }
    if decks.is_empty() && folders.is_empty() {
        println!(
            "{}",
            match scope(shared, trash) {
                Scope::Mine => "No decks yet. Make one: present new \"My deck\"",
                Scope::Shared => "Nothing is shared with you yet.",
                Scope::Trash => "The trash is empty.",
            }
        );
    }
    for d in &decks {
        println!("{}", deck_line(d));
    }
    Ok(())
}

pub async fn new(ctx: &Ctx, title: &str, folder: Option<&str>, from: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let from = match from {
        None => None,
        Some(f) => {
            let (d, v) = match f.rsplit_once('@') {
                Some((d, v)) => (
                    d,
                    Some(v.parse::<u64>().map_err(|_| {
                        Fail::new("invalid_input", format!("`{v}` in --from {f} is not a version number."), "Use <deck>@<version>, e.g. dk7Hq2mP9xRt@42.")
                    })?),
                ),
                None => (f, None),
            };
            Some(FromVersion { deck: ctx.deck_id(&c, d).await?, version: v })
        }
    };
    let d = c
        .create_deck(&NewDeck { title: Some(title.to_owned()), folder: folder.map(str::to_owned), from })
        .await?;
    ctx.out(&to_value(&d), || {
        format!("{}\nCreated \"{}\". Next: present slide add {} --layout title --title \"{}\"", d.id, d.title, d.id, d.title)
    });
    Ok(())
}

/// The MIME type for a file name.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ppt" => "application/vnd.ms-powerpoint",
        "key" => "application/vnd.apple.keynote",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "json" => "application/json",
        "lottie" => "application/json",
        "css" => "text/css",
        "js" => "text/javascript",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

pub fn read_file(path: &Path) -> R<Vec<u8>> {
    std::fs::read(path).map_err(|e| Fail::io(&format!("read {}", path.display()), &e))
}

pub async fn open(ctx: &Ctx, file: &Path, into: Option<&str>, folder: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let bytes = read_file(file)?;
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_owned();
    let ct = content_type(file);
    match into {
        Some(d) => {
            let id = ctx.deck_id(&c, d).await?;
            let v = c.import_into(&id, &name, ct, bytes).await?;
            ctx.out(&v, || format!("Opened {name} on top of {id} as its next version. See it: present read {id}"));
        }
        None => {
            let d = c.import(&name, ct, bytes, folder).await?;
            ctx.out(&to_value(&d), || format!("{}\nOpened {name} as \"{}\". Next: present read {}", d.id, d.title, d.id));
        }
    }
    Ok(())
}

pub async fn rename(ctx: &Ctx, deck: &str, title: &str) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let d = c.update_deck(&id, Some(title), None).await?;
    ctx.out(&to_value(&d), || format!("Renamed {id} to \"{}\".", d.title));
    Ok(())
}

pub async fn move_deck(ctx: &Ctx, deck: &str, folder: &str) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let target = (folder != "root" && folder != "-").then_some(folder);
    let d = c.update_deck(&id, None, Some(target)).await?;
    ctx.out(&to_value(&d), || match target {
        Some(f) => format!("Moved {id} into folder {f}."),
        None => format!("Moved {id} out of folders."),
    });
    Ok(())
}

pub async fn trash(ctx: &Ctx, deck: &str) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let v = c.trash_deck(&id).await?;
    ctx.out(&v, || format!("Moved {id} to the trash. Bring it back with: present untrash {id}"));
    Ok(())
}

pub async fn untrash(ctx: &Ctx, deck: &str) -> R<()> {
    let c = ctx.authed().await?;
    let id = deck_id_any(ctx, &c, deck).await?;
    let v = c.untrash_deck(&id).await?;
    ctx.out(&v, || format!("Restored {id} from the trash."));
    Ok(())
}

/// Like `deck_id`, but also looks in the trash for titles.
async fn deck_id_any(ctx: &Ctx, c: &Client, deck: &str) -> R<String> {
    match ctx.deck_id(c, deck).await {
        Ok(id) => Ok(id),
        Err(f) if f.code == "deck_not_found" => {
            let found: Vec<Deck> = c.decks(Scope::Trash, None).await?.into_iter().filter(|d| d.title == deck).collect();
            match found.as_slice() {
                [d] => Ok(d.id.clone()),
                _ => Err(f),
            }
        }
        Err(f) => Err(f),
    }
}

pub async fn delete_permanent(ctx: &Ctx, deck: &str, confirm: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let id = deck_id_any(ctx, &c, deck).await?;
    let d = c.deck(&id).await?;
    if d.trashed_at.is_none() {
        return Err(Fail::new(
            "deck_not_in_trash",
            format!("{id} (\"{}\") is not in the trash; only trashed decks can be deleted for good.", d.title),
            format!("Trash it first: present trash {id}"),
        ));
    }
    let title = match confirm {
        Some(t) => t.to_owned(),
        None => {
            confirm_typed(&format!("\"{}\" ({id}) and its whole history", d.title), &d.title)?;
            d.title.clone()
        }
    };
    let v = c.delete_deck_permanently(&id, &title).await?;
    ctx.out(&if v.is_null() { json!({ "deleted": id }) } else { v }, || format!("Deleted {id} (\"{}\") for good.", d.title));
    Ok(())
}

pub async fn transfer(ctx: &Ctx, target: &str, to: &str, folder: bool) -> R<()> {
    let c = ctx.authed().await?;
    let (kind, id) = if folder { (ResourceKind::Folder, target.to_owned()) } else { (ResourceKind::Deck, ctx.deck_id(&c, target).await?) };
    let t = c.transfer(kind, &id, to).await?;
    ctx.out(&to_value(&t), || format!("{}\nOffered {id} to {to}. They accept with: present transfers accept {}", t.id, t.id));
    Ok(())
}

pub async fn transfers(ctx: &Ctx, action: Option<TransferAction>, id: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    match (action, id) {
        (None, _) => {
            let t = c.transfers(false).await?;
            let line = |dir: &str, t: &silicon_present_client::Transfer| {
                format!(
                    "{}  {dir} {} {} \"{}\"  {} → {}  {}",
                    t.id,
                    t.kind(),
                    t.resource_id(),
                    t.name(),
                    t.from.as_ref().map(|a| a.label().to_owned()).unwrap_or_default(),
                    t.to.as_ref().map(|a| a.label().to_owned()).unwrap_or_default(),
                    t.state
                )
            };
            ctx.out(&to_value(&t), || {
                if t.incoming.is_empty() && t.outgoing.is_empty() {
                    return "No pending transfers.".into();
                }
                t.incoming.iter().map(|x| line("to you ", x)).chain(t.outgoing.iter().map(|x| line("by you ", x))).collect::<Vec<_>>().join("\n")
            });
        }
        (Some(_), None) => {
            return Err(Fail::new("missing_argument", "Which transfer? The id is missing.", "List them with `present transfers`, then e.g. `present transfers accept <id>`."));
        }
        (Some(a), Some(id)) => {
            let action = match a {
                TransferAction::Accept => "accept",
                TransferAction::Decline => "decline",
                TransferAction::Cancel => "cancel",
            };
            let v = c.answer_transfer(id, action).await?;
            ctx.out(&v, || format!("Transfer {id}: {action}{}.", if action == "cancel" { "led" } else { "ed" }));
        }
    }
    Ok(())
}

pub async fn folder(ctx: &Ctx, cmd: &FolderCmd) -> R<()> {
    let c = ctx.authed().await?;
    match cmd {
        FolderCmd::List { parent, shared, trash } => {
            let list = c.folders(scope(*shared, *trash), parent.as_deref()).await?;
            ctx.out(&json!({ "folders": list }), || {
                if list.is_empty() {
                    return "No folders.".into();
                }
                list.iter()
                    .map(|f| {
                        format!(
                            "{}  {}/  {}",
                            f.id,
                            f.name,
                            f.owner.as_ref().map(|o| o.label().to_owned()).unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        }
        FolderCmd::New { name, parent } => {
            let f = c.create_folder(name, parent.as_deref()).await?;
            ctx.out(&to_value(&f), || format!("{}\nCreated folder \"{}\". Put a deck in it: present new \"Deck\" --folder {}", f.id, f.name, f.id));
        }
        FolderCmd::Rename { folder, name } => {
            let f = c.update_folder(folder, Some(name), None).await?;
            ctx.out(&to_value(&f), || format!("Renamed folder {folder} to \"{}\".", f.name));
        }
        FolderCmd::Move { folder, parent } => {
            let target = (parent != "root" && parent != "-").then_some(parent.as_str());
            let f = c.update_folder(folder, None, Some(target)).await?;
            ctx.out(&to_value(&f), || format!("Moved folder {folder}."));
        }
        FolderCmd::Trash { folder } => {
            let v = c.trash_folder(folder).await?;
            ctx.out(&v, || format!("Moved folder {folder} and everything in it to the trash."));
        }
        FolderCmd::Untrash { folder } => {
            let v = c.untrash_folder(folder).await?;
            ctx.out(&v, || format!("Restored folder {folder}."));
        }
        FolderCmd::Delete { folder, confirm } => {
            let f = c.folder(folder).await?;
            let name = match confirm {
                Some(n) => n.clone(),
                None => {
                    confirm_typed(&format!("folder \"{}\" ({folder}) and everything in it", f.name), &f.name)?;
                    f.name.clone()
                }
            };
            let v = c.delete_folder_permanently(folder, &name).await?;
            ctx.out(&if v.is_null() { json!({ "deleted": folder }) } else { v }, || format!("Deleted folder {folder} for good."));
        }
        FolderCmd::Share { folder, to, role } => {
            let m = c.share(ResourceKind::Folder, folder, to, crate::cmd::collab::role(*role)).await?;
            ctx.out(&to_value(&m), || format!("Shared folder {folder} with {to} as {}.", m.role));
        }
    }
    Ok(())
}

/// `present search`.
pub async fn search(ctx: &Ctx, q: &str) -> R<()> {
    let c = ctx.authed().await?;
    let hits = c.search(q).await?;
    ctx.out(&json!({ "results": hits }), || {
        if hits.is_empty() {
            return format!("Nothing matches \"{q}\".");
        }
        hits.iter()
            .map(|h| {
                let d = h.get("deck").unwrap_or(h);
                let id = d.get("id").and_then(Value::as_str).unwrap_or_default();
                let title = d.get("title").and_then(Value::as_str).unwrap_or_default();
                let matches: Vec<String> = h
                    .get("matches")
                    .and_then(Value::as_array)
                    .map(|m| {
                        m.iter()
                            .map(|x| {
                                let slide = x.get("slideNumber").or_else(|| x.get("slide")).map(|s| s.to_string()).unwrap_or_default();
                                let text = x.get("text").or_else(|| x.get("snippet")).and_then(Value::as_str).unwrap_or_default();
                                format!("    slide {slide}: {text}")
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                format!("{id}  {title}\n{}", matches.join("\n"))
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(())
}
