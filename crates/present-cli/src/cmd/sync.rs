//! Working in a folder: pull, push, status.
//!
//! ```text
//! q4/
//!   deck.json                     id, title, version, size, theme (title and theme can be edited)
//!   master/slide.json             elements drawn under every slide
//!   slides/01-s_ab12cd/slide.json one slide: layout, background, notes, ..., elements (back to front)
//!   slides/01-s_ab12cd/e_cd34ef.html, .css, .js   an HTML element's code, referenced as {"file": "e_cd34ef.html"}
//!   assets/<id>.<ext>             every asset the deck uses (referenced as "asset:<id>")
//!   .present/base.json            the deck exactly as pulled (what push diffs against)
//!   .present/pull.json            deck id, version and API it came from
//! ```
//!
//! Slide order is the order of the `slides/` directories by name. A new slide is a new directory
//! with a slide.json without an id; a new element is one without an id. A local file referenced
//! as `src`/`poster`/`background.image` (e.g. `"assets/photo.png"`) is uploaded on push.

use crate::cmd::decks::{content_type, read_file};
use crate::ctx::Ctx;
use crate::fail::{Fail, R};
use crate::state::write_atomic;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use silicon_present_client::deck;
use silicon_present_client::diff::{ops_between, prepare_against};
use silicon_present_client::ops::{EditRequest, Op};
use silicon_present_client::{Client, accounts::now};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

const CODE_FIELDS: [&str; 3] = ["html", "css", "js"];

fn slug(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let s = s
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if s.is_empty() {
        "deck".into()
    } else {
        s.chars().take(60).collect()
    }
}

fn write(path: &Path, bytes: &[u8]) -> R<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| Fail::io(&format!("create {}", p.display()), &e))?;
    }
    std::fs::write(path, bytes).map_err(|e| Fail::io(&format!("write {}", path.display()), &e))
}

fn pretty(v: &Value) -> Vec<u8> {
    let mut s = serde_json::to_vec_pretty(v).unwrap_or_default();
    s.push(b'\n');
    s
}

fn ext_for(ct: &str) -> &'static str {
    match ct.split(';').next().unwrap_or_default().trim() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/mp4" => "m4a",
        "font/woff2" => "woff2",
        "font/woff" => "woff",
        "font/ttf" => "ttf",
        "font/otf" => "otf",
        "application/json" => "json",
        _ => "bin",
    }
}

/// Every `asset:<id>` in a value.
fn asset_refs(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::String(s) => {
            if let Some(id) = s.strip_prefix("asset:") {
                out.insert(id.to_owned());
            }
        }
        Value::Array(a) => a.iter().for_each(|x| asset_refs(x, out)),
        Value::Object(o) => o.values().for_each(|x| asset_refs(x, out)),
        _ => {}
    }
}

/// An id is content, never a filesystem path. Escape bytes injectively (including `%`).
fn file_component(id: &str) -> String {
    let mut out = String::new();
    for b in id.bytes() {
        if b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    if out.is_empty() { "%00".into() } else { out }
}

fn unsafe_path(path: &Path) -> Fail {
    Fail::new(
        "unsafe_local_path",
        format!(
            "{} is outside the deck folder or uses a symbolic link.",
            path.display()
        ),
        "Copy the file into the deck folder and reference that local copy. Nothing outside the folder is read or written.",
    )
}

fn reject_symlinks(path: &Path) -> R<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(unsafe_path(path)),
        Ok(m) if m.is_dir() => {
            for entry in std::fs::read_dir(path).map_err(|e| Fail::io("read deck folder", &e))? {
                reject_symlinks(
                    &entry
                        .map_err(|e| Fail::io("read deck folder entry", &e))?
                        .path(),
                )?;
            }
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Fail::io("inspect deck folder", &e)),
    }
}

fn check_folder(dir: &Path) -> R<()> {
    for name in ["deck.json", "slides", "master", "assets", ".present"] {
        reject_symlinks(&dir.join(name))?;
    }
    Ok(())
}

/// Keep this inode in place: the OS releases its advisory lock even when a command is killed.
/// Pull and push both hold it across planning, uploads, saved state and folder replacement.
fn lock_folder(dir: &Path) -> R<std::fs::File> {
    check_folder(dir)?;
    let state_dir = dir.join(".present");
    std::fs::create_dir_all(&state_dir).map_err(|e| Fail::io("create folder state", &e))?;
    let path = state_dir.join("folder.lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|e| Fail::io("open folder lock", &e))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(Fail::new(
            "folder_busy",
            format!("Another pull or push is using {}.", dir.display()),
            "Wait for that command to finish, then retry. The lock releases automatically if it exits.",
        )),
        Err(std::fs::TryLockError::Error(e)) => Err(Fail::io("lock deck folder", &e)),
    }
}

fn confined_file(dir: &Path, relative: &str) -> R<PathBuf> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(unsafe_path(path));
    }
    let mut joined = dir.to_path_buf();
    for c in path.components() {
        joined.push(c);
        if std::fs::symlink_metadata(&joined).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(unsafe_path(&joined));
        }
    }
    Ok(joined)
}

/// Download and serialize everything before replacing the pulled copy. Network failures leave it intact.
async fn write_folder(c: &Client, dir: &Path, content: &Value, api_url: &str) -> R<usize> {
    std::fs::create_dir_all(dir).map_err(|e| Fail::io("create deck folder", &e))?;
    check_folder(dir)?;
    let stage = tempfile::Builder::new()
        .prefix(".present-stage-")
        .tempdir_in(dir)
        .map_err(|e| Fail::io("stage deck download", &e))?;
    let count = write_folder_staged(c, stage.path(), content, api_url).await?;
    check_folder(dir)?;
    std::fs::create_dir_all(dir.join(".present")).map_err(|e| Fail::io("create pull state", &e))?;
    write_atomic(
        &dir.join(".present/refreshing.json"),
        &pretty(&json!({"version":content.get("version")})),
    )?;
    for name in ["slides", "master", "assets", "deck.json"] {
        let source = stage.path().join(name);
        if !source.exists() {
            continue;
        }
        let target = dir.join(name);
        if name == "assets" {
            std::fs::create_dir_all(&target).map_err(|e| Fail::io("create assets folder", &e))?;
            for entry in
                std::fs::read_dir(&source).map_err(|e| Fail::io("read staged assets", &e))?
            {
                let entry = entry.map_err(|e| Fail::io("read staged asset", &e))?;
                std::fs::rename(entry.path(), target.join(entry.file_name()))
                    .map_err(|e| Fail::io("install asset", &e))?;
            }
            continue;
        }
        if target.exists() {
            if target.is_dir() {
                std::fs::remove_dir_all(&target)
            } else {
                std::fs::remove_file(&target)
            }
            .map_err(|e| Fail::io("replace pulled deck", &e))?;
        }
        std::fs::rename(source, target).map_err(|e| Fail::io("install pulled deck", &e))?;
    }
    std::fs::create_dir_all(dir.join(".present")).map_err(|e| Fail::io("create pull state", &e))?;
    for name in ["base.json", "pull.json"] {
        write_atomic(
            &dir.join(".present").join(name),
            &read_file(&stage.path().join(".present").join(name))?,
        )?;
    }
    let _ = std::fs::remove_file(dir.join(".present/pending.json"));
    std::fs::remove_file(dir.join(".present/refreshing.json"))
        .map_err(|e| Fail::io("finish deck refresh", &e))?;
    Ok(count)
}

/// Writes the deck JSON into `dir` as the folder layout.
async fn write_folder_staged(c: &Client, dir: &Path, content: &Value, api_url: &str) -> R<usize> {
    std::fs::create_dir_all(dir).map_err(|e| Fail::io(&format!("create {}", dir.display()), &e))?;
    for sub in ["slides", "master"] {
        let p = dir.join(sub);
        if p.exists() {
            std::fs::remove_dir_all(&p)
                .map_err(|e| Fail::io(&format!("clear {}", p.display()), &e))?;
        }
        std::fs::create_dir_all(&p).map_err(|e| Fail::io("create staged slide folders", &e))?;
    }
    let mut meta = Map::new();
    for k in ["id", "title", "version", "size", "theme"] {
        if let Some(v) = content.get(k) {
            meta.insert(k.into(), v.clone());
        }
    }
    write(&dir.join("deck.json"), &pretty(&Value::Object(meta)))?;

    let write_slide = |sdir: PathBuf, slide: &Value| -> R<()> {
        let mut slide = slide.clone();
        if let Some(els) = slide.get_mut("elements").and_then(Value::as_array_mut) {
            for el in els {
                if deck::str_field(el, "kind") != Some("html") {
                    continue;
                }
                let eid = deck::str_field(el, "id").unwrap_or("element").to_owned();
                for f in CODE_FIELDS {
                    let code = el
                        .get(f)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let name = format!("{}.{f}", file_component(&eid));
                    write(&sdir.join(&name), code.as_bytes())?;
                    el[f] = json!({ "file": name });
                }
            }
        }
        write(&sdir.join("slide.json"), &pretty(&slide))
    };
    let master = content
        .get("master")
        .cloned()
        .unwrap_or_else(|| json!({ "elements": [] }));
    write_slide(dir.join("master"), &master)?;
    let slides = deck::slides(content);
    let width = slides.len().to_string().len().max(2);
    for (i, s) in slides.iter().enumerate() {
        let sid = deck::str_field(s, "id").unwrap_or("slide");
        write_slide(
            dir.join("slides")
                .join(format!("{:0width$}-{}", i + 1, file_component(sid))),
            s,
        )?;
    }

    let mut refs = BTreeSet::new();
    asset_refs(content, &mut refs);
    let adir = dir.join("assets");
    let mut fetched = 0;
    for id in &refs {
        let exists = std::fs::read_dir(&adir)
            .map(|rd| {
                rd.flatten().any(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with(&format!("{}.", file_component(id)))
                })
            })
            .unwrap_or(false);
        if exists {
            continue;
        }
        let a = c
            .download_asset(id)
            .await
            .map_err(|e| Fail::from(e).context(&format!("Downloading asset {id}")))?;
        write(
            &adir.join(format!(
                "{}.{}",
                file_component(id),
                ext_for(&a.content_type)
            )),
            &a.bytes,
        )?;
        fetched += 1;
    }
    let pdir = dir.join(".present");
    std::fs::create_dir_all(&pdir)
        .map_err(|e| Fail::io(&format!("create {}", pdir.display()), &e))?;
    write_atomic(&pdir.join("base.json"), &pretty(content))?;
    let pull = json!({
        "deck": content.get("id"),
        "version": content.get("version"),
        "api_url": api_url,
        "pulled_at": now(),
    });
    write_atomic(&pdir.join("pull.json"), &pretty(&pull))?;
    Ok(fetched)
}

fn read_json(path: &Path) -> R<Value> {
    let bytes = read_file(path)?;
    serde_json::from_slice(&bytes).map_err(|e| {
        Fail::new(
            "invalid_json",
            format!("{} is not valid JSON: {e}.", path.display()),
            "Fix the file (or pull again to start over); nothing was sent.",
        )
    })
}

/// Natural order for slide directories: by leading number, then by name.
fn dir_key(name: &str) -> (u64, String) {
    let digits: String = name.chars().take_while(char::is_ascii_digit).collect();
    (digits.parse().unwrap_or(u64::MAX), name.to_owned())
}

fn read_slide_dir(sdir: &Path) -> R<Value> {
    let path = sdir.join("slide.json");
    let mut slide = read_json(&path)?;
    if !slide.is_object() {
        return Err(Fail::new(
            "invalid_slide",
            format!("{} must hold a JSON object.", path.display()),
            "See: present docs pull",
        ));
    }
    if let Some(els) = slide.get_mut("elements").and_then(Value::as_array_mut) {
        for el in els {
            let Some(obj) = el.as_object_mut() else {
                return Err(Fail::new(
                    "invalid_slide",
                    format!("{} has an element that is not an object.", path.display()),
                    "",
                ));
            };
            for (k, v) in obj.iter_mut() {
                if let Some(file) = v
                    .get("file")
                    .and_then(Value::as_str)
                    .filter(|_| v.as_object().is_some_and(|o| o.len() == 1))
                {
                    let fp = confined_file(sdir, file)?;
                    let text = std::fs::read_to_string(&fp).map_err(|e| {
                        Fail::io(
                            &format!(
                                "read {} (field `{k}` of an element in {})",
                                fp.display(),
                                path.display()
                            ),
                            &e,
                        )
                    })?;
                    *v = Value::String(text);
                }
            }
        }
    } else if slide.get("elements").is_some() {
        return Err(Fail::new(
            "invalid_slide",
            format!("`elements` in {} must be an array.", path.display()),
            "",
        ));
    }
    Ok(slide)
}

/// The deck as the folder holds it now.
fn read_folder(dir: &Path) -> R<(Value, Value, Value)> {
    check_folder(dir)?;
    if dir.join(".present/refreshing.json").exists() {
        return Err(Fail::new(
            "pull_needed",
            "The last refresh did not finish, so this folder's version cannot be trusted.",
            "Copy any local changes aside, then run present pull <deck> <folder> --force to finish downloading it.",
        ));
    }
    let pdir = dir.join(".present");
    if !pdir.join("base.json").is_file() {
        return Err(Fail::new(
            "not_a_pulled_folder",
            format!(
                "{} is not a pulled deck (no .present/base.json).",
                dir.display()
            ),
            "Pull a deck first: present pull <deck> <dir>",
        ));
    }
    let base = read_json(&pdir.join("base.json"))?;
    let pull = read_json(&pdir.join("pull.json"))?;
    let meta = read_json(&dir.join("deck.json"))?;
    let mut local = json!({});
    for k in ["id", "title", "size", "theme"] {
        if let Some(v) = meta.get(k) {
            local[k] = v.clone();
        }
    }
    if dir.join("master").join("slide.json").is_file() {
        local["master"] = read_slide_dir(&dir.join("master"))?;
    }
    let mut names: Vec<String> = match std::fs::read_dir(dir.join("slides")) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect(),
        Err(_) => vec![],
    };
    names.sort_by_key(|n| dir_key(n));
    let mut slides = Vec::new();
    for n in names {
        let sdir = dir.join("slides").join(&n);
        if !sdir.join("slide.json").is_file() {
            return Err(Fail::new(
                "invalid_slide",
                format!("{} has no slide.json.", sdir.display()),
                "Every directory under slides/ is a slide and needs a slide.json (at least {}). Remove the directory to delete the slide.",
            ));
        }
        slides.push(read_slide_dir(&sdir)?);
    }
    local["slides"] = Value::Array(slides);
    Ok((base, local, pull))
}

/// Local media paths that will be uploaded on push, relative to the deck folder.
fn local_media(local: &mut Value, dir: &Path, found: &mut Vec<(String, PathBuf)>) -> R<()> {
    fn visit(
        v: &mut Value,
        key: Option<&str>,
        dir: &Path,
        found: &mut Vec<(String, PathBuf)>,
    ) -> R<()> {
        match v {
            Value::String(s) if matches!(key, Some("src" | "poster" | "image")) => {
                if s.is_empty()
                    || s.contains("://")
                    || s.starts_with("asset:")
                    || s.starts_with("data:")
                    || s.starts_with("slide:")
                {
                    return Ok(());
                }
                let p = confined_file(dir, s)?;
                if p.is_file() {
                    found.push((s.clone(), p));
                }
            }
            Value::Array(a) => {
                for x in a {
                    visit(x, None, dir, found)?;
                }
            }
            Value::Object(o) => {
                for (k, x) in o {
                    visit(x, Some(k), dir, found)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(local, None, dir, found)
}

fn replace_strings(v: &mut Value, from: &str, to: &str) {
    match v {
        Value::String(s) if s == from => *s = to.to_owned(),
        Value::Array(a) => a.iter_mut().for_each(|x| replace_strings(x, from, to)),
        Value::Object(o) => o.values_mut().for_each(|x| replace_strings(x, from, to)),
        _ => {}
    }
}

struct Plan {
    deck_id: String,
    version: Option<u64>,
    title: Option<String>,
    ops: Vec<Op>,
    uploads: Vec<(String, PathBuf)>,
    local: Value,
    pushed: Option<Value>,
}

fn plan(dir: &Path) -> R<Plan> {
    let (base, mut local, pull) = read_folder(dir)?;
    let deck_id = pull
        .get("deck")
        .and_then(Value::as_str)
        .or_else(|| deck::str_field(&base, "id"))
        .unwrap_or_default()
        .to_owned();
    let version = pull
        .get("version")
        .and_then(Value::as_u64)
        .or_else(|| base.get("version").and_then(Value::as_u64));
    let mut uploads = Vec::new();
    local_media(&mut local, dir, &mut uploads)?;
    prepare_against(&base, &mut local);
    let title = local
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| Some(*t) != deck::str_field(&base, "title"))
        .map(str::to_owned);
    let ops = ops_between(&base, &local);
    Ok(Plan {
        deck_id,
        version,
        title,
        ops,
        uploads,
        local,
        pushed: pull.get("pushed").cloned(),
    })
}

fn summary_json(p: &Plan) -> Value {
    json!({
        "deck": p.deck_id,
        "base": p.version,
        "title": p.title,
        "uploads": p.uploads.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>(),
        "ops": p.ops,
        "changes": p.ops.iter().map(Op::describe).collect::<Vec<_>>(),
    })
}

fn has_changes(p: &Plan) -> bool {
    !p.ops.is_empty() || p.title.is_some() || !p.uploads.is_empty()
}

fn describe(p: &Plan) -> String {
    let mut lines = Vec::new();
    if let Some(t) = &p.title {
        lines.push(format!("rename deck to \"{t}\""));
    }
    for (s, _) in &p.uploads {
        lines.push(format!("upload {s}"));
    }
    lines.extend(p.ops.iter().map(Op::describe));
    lines.join("\n  ")
}

pub async fn pull(
    ctx: &Ctx,
    deck_ref: &str,
    dir: Option<&Path>,
    version: Option<u64>,
    force: bool,
) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    // A title is needed only to choose the default directory. Fetch the actual snapshot after taking the lock,
    // so another push cannot complete between reading the snapshot and inspecting this folder's state.
    let dir = match dir {
        Some(dir) => dir.to_path_buf(),
        None => {
            let content = c.content(&id, version).await?;
            PathBuf::from(slug(deck::str_field(&content, "title").unwrap_or("deck")))
        }
    };
    let _folder_lock = lock_folder(&dir)?;
    let content = c.content(&id, version).await?;
    if dir.join(".present").join("base.json").is_file() && !force {
        let p = plan(&dir)?;
        let already_pushed = p.pushed.as_ref().and_then(|v| v.get("local")) == Some(&p.local);
        if has_changes(&p) && !already_pushed {
            return Err(Fail::new(
                "local_changes",
                format!(
                    "{} has changes that were not pushed:\n  {}",
                    dir.display(),
                    describe(&p)
                ),
                format!(
                    "Push them first (present push {}), or pass --force to overwrite them.",
                    dir.display()
                ),
            ));
        }
        if p.deck_id != id {
            return Err(Fail::new(
                "different_deck",
                format!("{} holds deck {}, not {id}.", dir.display(), p.deck_id),
                "Pull into another folder.",
            ));
        }
    }
    let fetched = write_folder(&c, &dir, &content, &ctx.api_url).await?;
    let n = deck::slides(&content).len();
    let v = json!({
        "deck": id,
        "dir": dir.display().to_string(),
        "version": content.get("version"),
        "slides": n,
        "assets_downloaded": fetched,
    });
    ctx.out(&v, || {
        format!(
            "Pulled {id} at version {} into {} ({n} slides, {fetched} assets).\nEdit the files, then: present status {} and present push {}",
            content.get("version").map(ToString::to_string).unwrap_or_default(),
            dir.display(),
            dir.display(),
            dir.display()
        )
    });
    Ok(())
}

pub async fn status(ctx: &Ctx, dir: Option<&Path>) -> R<()> {
    let dir = dir.unwrap_or_else(|| Path::new("."));
    let p = plan(dir)?;
    let mut v = summary_json(&p);
    v["changed"] = json!(has_changes(&p));
    ctx.out(&v, || {
        if has_changes(&p) {
            format!(
                "{} (deck {}, pulled at version {}) would push:\n  {}",
                dir.display(),
                p.deck_id,
                p.version.map(|v| v.to_string()).unwrap_or_default(),
                describe(&p)
            )
        } else {
            format!(
                "No local changes in {} (deck {}, version {}).",
                dir.display(),
                p.deck_id,
                p.version.map(|v| v.to_string()).unwrap_or_default()
            )
        }
    });
    Ok(())
}

/// Persist generated identities and uploaded references without rewriting HTML source files or their references.
fn persist_prepared(dir: &Path, local: &Value, uploads: &[(String, String)]) -> R<()> {
    check_folder(dir)?;
    if !uploads.is_empty() {
        let meta_path = dir.join("deck.json");
        let mut meta = read_json(&meta_path)?;
        for (from, to) in uploads {
            replace_strings(&mut meta, from, to);
        }
        write_atomic(&meta_path, &pretty(&meta))?;
    }
    std::fs::create_dir_all(dir.join("slides"))
        .map_err(|e| Fail::io("create slides folder", &e))?;
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir.join("slides"))
        .map_err(|e| Fail::io("read slides", &e))?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect();
    paths.sort_by_key(|p| dir_key(&p.file_name().unwrap_or_default().to_string_lossy()));
    let mut pairs: Vec<(PathBuf, &Value)> = paths.into_iter().zip(deck::slides(local)).collect();
    if let Some(master) = local.get("master") {
        pairs.push((dir.join("master"), master));
    }
    for (path, prepared) in pairs {
        let path = path.join("slide.json");
        if !path.exists() {
            continue;
        }
        let mut raw = read_json(&path)?;
        if let Some(id) = prepared.get("id") {
            raw["id"] = id.clone();
        }
        if let Some(elements) = raw.get_mut("elements").and_then(Value::as_array_mut) {
            for (element, prepared) in elements.iter_mut().zip(
                prepared
                    .get("elements")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            ) {
                if let Some(id) = prepared.get("id") {
                    element["id"] = id.clone();
                }
            }
        }
        for (from, to) in uploads {
            replace_strings(&mut raw, from, to);
        }
        write_atomic(&path, &pretty(&raw))?;
    }
    Ok(())
}

fn push_key(deck: &str, request: &EditRequest) -> String {
    format!(
        "push:{deck}:{}:{:x}",
        request.base.unwrap_or(0),
        Sha256::digest(serde_json::to_vec(request).expect("edit serializes"))
    )
}

pub async fn push(
    ctx: &Ctx,
    dir: Option<&Path>,
    summary: Option<&str>,
    dry_run: bool,
    no_refresh: bool,
) -> R<()> {
    let dir = dir.unwrap_or_else(|| Path::new("."));
    let _folder_lock = lock_folder(dir)?;
    let mut p = plan(dir)?;
    if p.pushed.is_some() {
        return Err(Fail::new(
            "pull_needed",
            "This folder was already pushed and needs its merged copy.",
            "Run present pull before pushing again. If you edited after the push, copy those changes before using pull --force.",
        ));
    }
    if dry_run {
        let mut v = summary_json(&p);
        v["dry_run"] = json!(true);
        ctx.out(&v, || {
            if has_changes(&p) {
                format!("Would push:\n  {}", describe(&p))
            } else {
                "Nothing to push.".into()
            }
        });
        return Ok(());
    }
    let c = ctx.authed().await?;
    if !has_changes(&p) {
        ctx.out(
            &json!({ "deck": p.deck_id, "pushed": false, "reason": "no local changes" }),
            || {
                format!(
                    "Nothing to push: {} matches version {}.",
                    dir.display(),
                    p.version.map(|v| v.to_string()).unwrap_or_default()
                )
            },
        );
        return Ok(());
    }
    let pending_path = dir.join(".present/pending.json");
    if pending_path.exists() && read_json(&pending_path)?.get("local") != Some(&p.local) {
        return Err(Fail::new(
            "push_pending",
            "The previous push has no confirmed answer and this folder has changed.",
            "Copy your changes aside and inspect .present/pending.json before retrying or pulling --force.",
        ));
    }
    persist_prepared(dir, &p.local, &[])?;
    // Upload local files first and point the deck at the assets.
    let mut uploaded = Vec::new();
    for (reference, path) in &p.uploads {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let asset = c
            .upload_asset(&p.deck_id, name, content_type(path), read_file(path)?)
            .await
            .map_err(|e| Fail::from(e).context(&format!("Uploading {reference}")))?;
        replace_strings(&mut p.local, reference, &asset.reference());
        persist_prepared(dir, &p.local, &[(reference.clone(), asset.reference())])?;
        uploaded.push(json!({ "file": reference, "asset": asset.id }));
    }
    if !uploaded.is_empty() {
        let base = read_json(&dir.join(".present").join("base.json"))?;
        p.ops = ops_between(&base, &p.local);
    }
    let mut version = p.version;
    if let Some(t) = &p.title {
        c.update_deck(&p.deck_id, Some(t), None).await?;
    }
    let lines: Vec<String> = p.ops.iter().map(Op::describe).collect();
    let mut outcome = Value::Null;
    if !p.ops.is_empty() {
        let mut req = EditRequest::new(p.ops.clone());
        req.base = p.version;
        if let Some(s) = summary {
            req = req.summary(s);
        }
        let pending_path = dir.join(".present/pending.json");
        if pending_path.exists() {
            let pending = read_json(&pending_path)?;
            if pending.get("replace_em_dashes").and_then(Value::as_bool).unwrap_or(false) != c.replaces_em_dashes() {
                return Err(Fail::new(
                    "push_pending_text_policy",
                    "The pending push used a different em-dash option.",
                    "Retry with the same --dangerously-use-em-dash choice as the original push so its request stays identical.",
                ));
            }
            if pending.get("local") != Some(&p.local) {
                return Err(Fail::new(
                    "push_pending",
                    "The previous push has no confirmed answer and this folder has changed.",
                    "Restore the pending local copy from .present/pending.json and retry, or copy your changes aside and pull --force to inspect the deck.",
                ));
            }
            req = serde_json::from_value(pending["request"].clone()).map_err(|e| {
                Fail::new(
                    "invalid_push_state",
                    e.to_string(),
                    "Keep a copy of this folder before pulling again.",
                )
            })?;
        }
        let key = push_key(&p.deck_id, &req);
        write_atomic(
            &pending_path,
            &pretty(&json!({"request": req, "local": p.local, "replace_em_dashes": c.replaces_em_dashes()})),
        )?;
        let out = match c.edit_idempotent(&p.deck_id, &req, &key).await {
            Ok(out) => out,
            Err(e) => {
                // A refusal did not commit. A lost response might have: keep the exact request for retry.
                if e.status().is_some_and(|s| (400..500).contains(&s)) {
                    let _ = std::fs::remove_file(&pending_path);
                }
                return Err(e.into());
            }
        };
        version = Some(out.version);
        outcome = serde_json::to_value(&out).unwrap_or_default();
    }
    let pull_path = dir.join(".present/pull.json");
    let mut pull_state = read_json(&pull_path)?;
    pull_state["pushed"] = json!({"version": version, "local": p.local});
    write_atomic(&pull_path, &pretty(&pull_state))?;
    let _ = std::fs::remove_file(dir.join(".present/pending.json"));
    let mut refreshed = false;
    if !no_refresh {
        let content = c.content(&p.deck_id, version).await?;
        write_folder(&c, dir, &content, &ctx.api_url).await?;
        version = content.get("version").and_then(Value::as_u64).or(version);
        refreshed = true;
    }
    let v = json!({
        "deck": p.deck_id,
        "pushed": true,
        "base": p.version,
        "version": version,
        "title": p.title,
        "uploads": uploaded,
        "changes": lines,
        "outcome": outcome,
        "refreshed": refreshed,
    });
    ctx.out(&v, || {
        let mut out = format!(
            "Pushed to {} (written against version {}):\n  {}",
            p.deck_id,
            p.version.map(|v| v.to_string()).unwrap_or_default(),
            describe(&p)
        );
        out.push_str(&format!(
            "\nThe deck is now at version {}.",
            version.map(|v| v.to_string()).unwrap_or_default()
        ));
        if refreshed {
            out.push_str(&format!(" {} now holds the merged deck.", dir.display()));
        }
        out
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slide_dirs_sort_naturally() {
        let mut v = vec!["10-s_c", "2-s_b", "02a-new", "01-s_a"];
        v.sort_by_key(|n| dir_key(n));
        assert_eq!(v, vec!["01-s_a", "02a-new", "2-s_b", "10-s_c"]);
    }

    #[test]
    fn slugs_are_safe_folder_names() {
        assert_eq!(slug("Q4 review: final!"), "q4-review-final");
        assert_eq!(slug("!!!"), "deck");
    }

    #[test]
    fn deck_ids_cannot_choose_paths_or_collide_after_escaping() {
        assert_eq!(file_component("../../outside"), "%2E%2E%2F%2E%2E%2Foutside");
        assert_eq!(file_component("s_good-1"), "s_good-1");
        assert_ne!(file_component("/"), file_component("%2F"));
        assert_ne!(
            file_component("e_Title").to_ascii_lowercase(),
            file_component("e_title").to_ascii_lowercase()
        );
        assert_ne!(
            file_component("Abc123").to_ascii_lowercase(),
            file_component("abc123").to_ascii_lowercase()
        );
    }

    #[test]
    fn local_media_and_code_references_stay_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        for value in ["../secret", "/tmp/secret", "assets/../../secret"] {
            let mut local = json!({"slides":[{"elements":[{"src":value}]}]});
            assert_eq!(
                local_media(&mut local, dir.path(), &mut vec![])
                    .unwrap_err()
                    .code,
                "unsafe_local_path"
            );
            assert!(confined_file(dir.path(), value).is_err());
        }
        std::fs::create_dir(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/a.png"), b"picture").unwrap();
        let mut local = json!({"src":"assets/a.png"});
        let mut found = vec![];
        local_media(&mut local, dir.path(), &mut found).unwrap();
        assert_eq!(found.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn linked_assets_and_code_cannot_read_outside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("private"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("assets")).unwrap();
        assert!(check_folder(dir.path()).is_err());
        assert!(confined_file(dir.path(), "assets/private").is_err());
    }

    #[test]
    fn preparing_a_retry_keeps_new_ids_and_html_references() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("slides/01-new")).unwrap();
        std::fs::create_dir_all(dir.path().join(".present")).unwrap();
        let base = json!({"id":"deck12345678","version":1,"slides":[]});
        write(&dir.path().join(".present/base.json"), &pretty(&base)).unwrap();
        write(
            &dir.path().join(".present/pull.json"),
            &pretty(&json!({"deck":"deck12345678","version":1})),
        )
        .unwrap();
        write(&dir.path().join("deck.json"), &pretty(&base)).unwrap();
        write(
            &dir.path().join("slides/01-new/slide.json"),
            &pretty(&json!({"elements":[{"kind":"html","html":{"file":"code.html"}}]})),
        )
        .unwrap();
        write(&dir.path().join("slides/01-new/code.html"), b"<p>Hello</p>").unwrap();
        let first = plan(dir.path()).unwrap();
        persist_prepared(dir.path(), &first.local, &[]).unwrap();
        let retry = plan(dir.path()).unwrap();
        assert_eq!(first.ops, retry.ops);
        let raw = read_json(&dir.path().join("slides/01-new/slide.json")).unwrap();
        assert_eq!(raw["elements"][0]["html"]["file"], "code.html");
        let request = EditRequest::new(first.ops).on(1);
        assert_eq!(
            push_key("deck12345678", &request),
            push_key("deck12345678", &request)
        );
        assert_ne!(
            push_key("deck12345678", &request),
            push_key("deck12345678", &request.on(2))
        );
    }
}
