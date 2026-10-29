//! Reading, seeing and editing: read, slide, render, edit, add, set, replace, delete, front/back, theme.

use crate::args::{AddCmd, FrameArgs, SlideCmd, TextStyleArgs};
use crate::cmd::decks::{content_type, read_file};
use crate::ctx::{Ctx, to_value};
use crate::fail::{Fail, R};
use serde_json::{Map, Value, json};
use silicon_present_client::deck::{self, Frame, LayoutContent};
use silicon_present_client::ops::{EditRequest, Op};
use silicon_present_client::{Client, RenderOptions};
use std::io::Read as _;
use std::path::{Path, PathBuf};

/// Applies ops and prints the outcome.
async fn apply(ctx: &Ctx, c: &Client, id: &str, ops: Vec<Op>, summary: Option<String>, done: impl FnOnce(&Value) -> String) -> R<Value> {
    apply_with(ctx, c, id, ops, summary, Value::Null, done).await
}

/// Applies ops and prints the outcome with `extra` fields merged into the JSON.
async fn apply_with(ctx: &Ctx, c: &Client, id: &str, ops: Vec<Op>, summary: Option<String>, extra: Value, done: impl FnOnce(&Value) -> String) -> R<Value> {
    let lines: Vec<String> = ops.iter().map(Op::describe).collect();
    let mut req = EditRequest::new(ops);
    if let Some(s) = summary {
        req = req.summary(s);
    }
    let out = c.edit(id, &req).await?;
    let mut v = to_value(&out);
    v["deck"] = json!(id);
    v["ops"] = json!(lines);
    if let Value::Object(m) = extra {
        for (k, val) in m {
            v[k] = val;
        }
    }
    let text = done(&v);
    ctx.out(&v, || format!("{text}\nNow at version {}.", out.version));
    Ok(v)
}

pub async fn read(ctx: &Ctx, deck: &str, version: Option<u64>, comments: bool) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    if ctx.json {
        let mut v = c.content(&id, version).await?;
        if comments {
            let threads = c.threads(&id, "all").await?;
            v["threads"] = json!(threads);
        }
        ctx.print_json(&v);
    } else {
        print!("{}", c.content_text(&id, version, comments).await?);
        println!();
    }
    Ok(())
}

pub async fn slide_show(ctx: &Ctx, deck: &str, sel: &str) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let content = c.content(&id, None).await?;
    let (idx, sid) = deck::find_slide(&content, sel).ok_or_else(|| ctx.slide_id(&content, sel).err().unwrap_or_else(|| Fail::new("slide_not_found", "", "")))?;
    let slide = deck::slide_by_id(&content, &sid).cloned().unwrap_or(Value::Null);
    if ctx.json {
        ctx.print_json(&slide);
        return Ok(());
    }
    let n = idx.map_or_else(|| "master".to_owned(), |i| (i + 1).to_string());
    println!(
        "Slide {n} ({sid}) layout {}{}{}",
        deck::str_field(&slide, "layout").unwrap_or("blank"),
        if slide.get("skipped").and_then(Value::as_bool).unwrap_or(false) { ", skipped" } else { "" },
        deck::str_field(&slide, "section").map(|s| format!(", section \"{s}\"")).unwrap_or_default()
    );
    for (i, e) in deck::elements(&slide).iter().enumerate() {
        let kind = deck::str_field(e, "kind").unwrap_or("?");
        let geo = format!(
            "x{} y{} w{} h{}",
            e.get("x").unwrap_or(&Value::Null),
            e.get("y").unwrap_or(&Value::Null),
            e.get("w").unwrap_or(&Value::Null),
            e.get("h").unwrap_or(&Value::Null)
        );
        let what = match kind {
            "text" | "shape" => format!("{:?}", deck::plain_text(e.get("text").unwrap_or(&Value::Null))),
            "image" | "video" | "audio" => deck::str_field(e, "src").unwrap_or_default().to_owned(),
            "html" => format!("{} bytes of HTML", deck::str_field(e, "html").map_or(0, str::len)),
            "chart" => e.get("chart").and_then(|c| c.get("type")).map(ToString::to_string).unwrap_or_default(),
            "table" => format!("{}x{}", e.get("rows").unwrap_or(&Value::Null), e.get("cols").unwrap_or(&Value::Null)),
            _ => String::new(),
        };
        println!("  {}. {} {kind} {geo}  {what}", i + 1, deck::str_field(e, "id").unwrap_or("?"));
    }
    if let Some(notes) = deck::str_field(&slide, "notes").filter(|n| !n.is_empty()) {
        println!("  notes: {notes}");
    }
    Ok(())
}

fn read_text_arg(text: &str) -> R<String> {
    if text == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map_err(|e| Fail::io("read stdin", &e))?;
        Ok(s.trim_end_matches('\n').to_owned())
    } else {
        Ok(text.to_owned())
    }
}

/// The most words a slide holds before adding text needs --dangerously-add-long-text.
const SLIDE_WORD_LIMIT: usize = 50;

fn word_count(text: &str) -> usize {
    text.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count()
}

/// Words an element puts on the slide: its text (text boxes, shapes) and its table cells.
fn element_words(e: &Value) -> usize {
    let text = e.get("text").map_or(0, |t| word_count(&deck::plain_text(t)));
    let cells: usize = e
        .get("cells")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .flatten()
        .map(|cell| cell.get("text").map_or(0, |t| word_count(&deck::plain_text(t))))
        .sum();
    text + cells
}

fn slide_words(content: &Value, sid: &str) -> usize {
    deck::slide_by_id(content, sid).map_or(0, |s| deck::elements(s).iter().map(element_words).sum())
}

/// Refuses a change that adds words and leaves the slide with more than SLIDE_WORD_LIMIT, unless the command
/// was given --dangerously-add-long-text.
fn check_slide_words(ctx: &Ctx, before: usize, after: usize) -> R<()> {
    if ctx.dangerously_add_long_text || after <= before || after <= SLIDE_WORD_LIMIT {
        return Ok(());
    }
    Err(Fail::new(
        "slide_too_text_heavy",
        format!("This slide is getting too text heavy, prefer adding more graphical elements to convey the idea instead. (It would have {after} words; the limit is {SLIDE_WORD_LIMIT}.)"),
        "If you still need to add this text element you can add it via --dangerously-add-long-text",
    ))
}

pub async fn slide_cmd(ctx: &Ctx, cmd: &SlideCmd) -> R<()> {
    let c = ctx.authed().await?;
    let deck_ref = match cmd {
        SlideCmd::Add { deck, .. }
        | SlideCmd::Duplicate { deck, .. }
        | SlideCmd::Move { deck, .. }
        | SlideCmd::Delete { deck, .. }
        | SlideCmd::Skip { deck, .. }
        | SlideCmd::Section { deck, .. }
        | SlideCmd::Notes { deck, .. }
        | SlideCmd::Transition { deck, .. }
        | SlideCmd::Background { deck, .. }
        | SlideCmd::Layout { deck, .. }
        | SlideCmd::Master { deck, .. } => deck,
    };
    let id = ctx.deck_id(&c, deck_ref).await?;
    let content = c.content(&id, None).await?;
    let update = |slide: &str, key: &str, value: Value| -> R<Op> {
        let sid = ctx.slide_id(&content, slide)?;
        let mut set = Map::new();
        set.insert(key.into(), value);
        Ok(Op::UpdateSlide { slide: sid, set })
    };
    match cmd {
        SlideCmd::Add { after, first, layout, title, subtitle, body, right, caption, notes, .. } => {
            if !deck::LAYOUTS.contains(&layout.as_str()) {
                return Err(Fail::new("unknown_layout", format!("`{layout}` is not a layout."), format!("Use one of: {}.", deck::LAYOUTS.join(", "))));
            }
            let after = if *first {
                None
            } else {
                match after {
                    Some(a) => Some(ctx.slide_id(&content, a)?),
                    None => deck::slides(&content).last().and_then(|s| deck::str_field(s, "id")).map(str::to_owned),
                }
            };
            let accent = content.pointer("/theme/colors/accent").and_then(Value::as_str).unwrap_or("#2f5bea");
            let lc = LayoutContent {
                title: title.clone(),
                subtitle: subtitle.clone(),
                body: body.clone(),
                right: right.clone(),
                caption: caption.clone(),
                image: None,
            };
            let sid = deck::new_slide_id();
            let elements = deck::layout_elements(layout, deck::size(&content), accent, &lc);
            check_slide_words(ctx, 0, elements.iter().map(element_words).sum())?;
            let mut slide = json!({ "id": sid, "layout": layout, "elements": elements });
            if let Some(n) = notes {
                slide["notes"] = json!(n);
            }
            let element_ids: Vec<String> = deck::elements(&slide).iter().filter_map(|e| deck::str_field(e, "id").map(str::to_owned)).collect();
            let extra = json!({ "slide": sid, "elements": element_ids });
            apply_with(ctx, &c, &id, vec![Op::AddSlide { after, slide }], None, extra, |_| format!("{sid}\nAdded slide {sid} ({layout}).")).await.map(|_| ())
        }
        SlideCmd::Duplicate { slide, .. } => {
            let sid = ctx.slide_id(&content, slide)?;
            let mut copy = deck::slide_by_id(&content, &sid).cloned().unwrap_or(Value::Null);
            let new_id = deck::new_slide_id();
            copy["id"] = json!(new_id);
            if let Some(els) = copy.get_mut("elements").and_then(Value::as_array_mut) {
                for e in els {
                    e["id"] = json!(deck::new_element_id());
                }
            }
            apply_with(ctx, &c, &id, vec![Op::AddSlide { after: Some(sid.clone()), slide: copy }], None, json!({ "slide": new_id }), |_| format!("{new_id}\nCopied {sid} to {new_id}.")).await.map(|_| ())
        }
        SlideCmd::Move { slide, after, first, .. } => {
            let sid = ctx.slide_id(&content, slide)?;
            let after = if *first { None } else { Some(ctx.slide_id(&content, after.as_deref().unwrap_or_default())?) };
            apply(ctx, &c, &id, vec![Op::MoveSlide { slide: sid.clone(), after }], None, |_| format!("Moved {sid}.")).await.map(|_| ())
        }
        SlideCmd::Delete { slide, .. } => {
            let sid = ctx.slide_id(&content, slide)?;
            apply(ctx, &c, &id, vec![Op::DeleteSlide { slide: sid.clone() }], None, |_| format!("Deleted {sid} (bring it back with present restore).")).await.map(|_| ())
        }
        SlideCmd::Skip { slide, off, .. } => {
            let op = update(slide, "skipped", json!(!off))?;
            apply(ctx, &c, &id, vec![op], None, |_| if *off { "The slide is shown again when presenting.".into() } else { "The slide is skipped when presenting.".into() }).await.map(|_| ())
        }
        SlideCmd::Section { slide, name, clear, .. } => {
            let value = if *clear { Value::Null } else { json!(name.clone().ok_or_else(|| Fail::new("missing_argument", "The section name is missing.", "Give a name, or --clear to remove the section."))?) };
            let op = update(slide, "section", value)?;
            apply(ctx, &c, &id, vec![op], None, |_| "Section set.".into()).await.map(|_| ())
        }
        SlideCmd::Notes { slide, text, file, .. } => {
            let sid = ctx.slide_id(&content, slide)?;
            let new = match (text, file) {
                (Some(t), _) => Some(read_text_arg(t)?),
                (None, Some(f)) => Some(String::from_utf8_lossy(&read_file(f)?).into_owned()),
                (None, None) => None,
            };
            match new {
                None => {
                    let notes = deck::slide_by_id(&content, &sid).and_then(|s| deck::str_field(s, "notes")).unwrap_or_default().to_owned();
                    ctx.out(&json!({ "slide": sid, "notes": notes }), || notes.clone());
                    Ok(())
                }
                Some(n) => {
                    let op = update(&sid, "notes", json!(n))?;
                    apply(ctx, &c, &id, vec![op], None, |_| "Notes saved.".into()).await.map(|_| ())
                }
            }
        }
        SlideCmd::Transition { slide, kind, duration, direction, .. } => {
            let value = if kind == "none" {
                Value::Null
            } else {
                if !["fade", "push", "wipe", "zoom", "cover"].contains(&kind.as_str()) {
                    return Err(Fail::new("unknown_transition", format!("`{kind}` is not a transition."), "Use fade, push, wipe, zoom, cover or none."));
                }
                let mut t = json!({ "type": kind, "duration": duration });
                if let Some(d) = direction {
                    t["direction"] = json!(d);
                }
                t
            };
            let op = update(slide, "transition", value)?;
            apply(ctx, &c, &id, vec![op], None, |_| "Transition set.".into()).await.map(|_| ())
        }
        SlideCmd::Background { slide, value, fit, .. } => {
            let bg = if value == "none" {
                Value::Null
            } else if value.starts_with('#') {
                json!({ "color": value })
            } else {
                json!({ "image": media_src(&c, &id, value).await?, "fit": fit })
            };
            let op = update(slide, "background", bg)?;
            apply(ctx, &c, &id, vec![op], None, |_| "Background set.".into()).await.map(|_| ())
        }
        SlideCmd::Layout { slide, layout, .. } => {
            let op = update(slide, "layout", json!(layout))?;
            apply(ctx, &c, &id, vec![op], None, |_| "Layout set.".into()).await.map(|_| ())
        }
        SlideCmd::Master { slide, hide, .. } => {
            let op = update(slide, "hideMaster", json!(hide))?;
            apply(ctx, &c, &id, vec![op], None, |_| if *hide { "Master hidden on this slide.".into() } else { "Master shown on this slide.".into() }).await.map(|_| ())
        }
    }
}

/// A local file is uploaded as an asset; a URL or `asset:` reference is used as it is.
pub async fn media_src(c: &Client, deck_id: &str, source: &str) -> R<String> {
    if source.starts_with("asset:") || source.starts_with("http://") || source.starts_with("https://") || source.starts_with("data:") {
        return Ok(source.to_owned());
    }
    let path = Path::new(source);
    if !path.is_file() {
        return Err(Fail::new(
            "file_not_found",
            format!("`{source}` is not a file here, a URL or an asset:<id> reference."),
            "Pass a path to an existing file (it is uploaded), an https URL, or asset:<id>.",
        ));
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let asset = c.upload_asset(deck_id, name, content_type(path), read_file(path)?).await?;
    Ok(asset.reference())
}

pub async fn render(
    ctx: &Ctx,
    deck: &str,
    slide: Option<&str>,
    all: bool,
    output: Option<&Path>,
    opts: RenderOptions,
) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let content = c.content(&id, opts.version).await?;
    let ext = opts.format.clone().unwrap_or_else(|| "png".into());
    let targets: Vec<(usize, String)> = if all {
        deck::slides(&content)
            .iter()
            .enumerate()
            .filter_map(|(i, s)| deck::str_field(s, "id").map(|id| (i + 1, id.to_owned())))
            .collect()
    } else {
        let sel = slide.ok_or_else(|| Fail::new("missing_argument", "Which slide? Give a number or id, or --all.", "e.g. present render <deck> 1 -o s1.png"))?;
        let (i, sid) = deck::find_slide(&content, sel).ok_or_else(|| ctx.slide_id(&content, sel).err().unwrap_or_else(|| Fail::new("slide_not_found", "", "")))?;
        vec![(i.map_or(0, |i| i + 1), sid)]
    };
    let mut written = Vec::new();
    if all {
        let dir = output.map_or_else(|| PathBuf::from(format!("{id}-renders")), Path::to_path_buf);
        std::fs::create_dir_all(&dir).map_err(|e| Fail::io(&format!("create {}", dir.display()), &e))?;
        for (n, sid) in &targets {
            let img = c.render(&id, sid, &opts).await?;
            let path = dir.join(format!("{n:02}-{sid}.{ext}"));
            std::fs::write(&path, &img.bytes).map_err(|e| Fail::io(&format!("write {}", path.display()), &e))?;
            written.push(json!({ "slide": sid, "number": n, "path": path.display().to_string(), "bytes": img.bytes.len(), "contentType": img.content_type }));
        }
    } else {
        let (n, sid) = &targets[0];
        let img = c.render(&id, sid, &opts).await?;
        let path = output.map_or_else(|| PathBuf::from(format!("{id}-{n}.{ext}")), Path::to_path_buf);
        std::fs::write(&path, &img.bytes).map_err(|e| Fail::io(&format!("write {}", path.display()), &e))?;
        written.push(json!({ "slide": sid, "number": n, "path": path.display().to_string(), "bytes": img.bytes.len(), "contentType": img.content_type }));
    }
    ctx.out(&json!({ "renders": written }), || {
        written
            .iter()
            .map(|w| format!("{}  (slide {}, {} bytes)", w["path"].as_str().unwrap_or_default(), w["number"], w["bytes"]))
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(())
}

pub async fn edit_raw(ctx: &Ctx, deck: &str, ops: &str, base: Option<u64>, summary: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let text = if ops == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map_err(|e| Fail::io("read ops from stdin", &e))?;
        s
    } else {
        String::from_utf8_lossy(&read_file(Path::new(ops))?).into_owned()
    };
    let v: Value = serde_json::from_str(&text).map_err(|e| Fail::new("invalid_ops", format!("The ops are not valid JSON: {e}."), "Pass a JSON array of ops, or {\"base\",\"summary\",\"ops\"}. See: present docs ops"))?;
    let mut req: EditRequest = match v {
        Value::Array(_) => EditRequest { base: None, summary: None, ops: parse_ops(v)? },
        Value::Object(ref o) if o.contains_key("ops") => serde_json::from_value(v.clone()).map_err(|e| Fail::new("invalid_ops", format!("The edit request is not valid: {e}."), "See: present docs ops"))?,
        _ => return Err(Fail::new("invalid_ops", "The ops must be a JSON array or an object with \"ops\".", "See: present docs ops")),
    };
    if base.is_some() {
        req.base = base;
    }
    if let Some(s) = summary {
        req.summary = Some(s.to_owned());
    }
    // Text written as a plain string becomes rich text, as in pulled folders.
    for op in &mut req.ops {
        match op {
            Op::AddElement { element, .. } => silicon_present_client::diff::prepare_element(element),
            Op::AddSlide { slide, .. } => {
                if let Some(els) = slide.get_mut("elements").and_then(Value::as_array_mut) {
                    els.iter_mut().for_each(silicon_present_client::diff::prepare_element);
                }
            }
            Op::UpdateElement { set, .. } => {
                if let Some(Value::String(s)) = set.get("text") {
                    let r = deck::rich_text(s);
                    set.insert("text".into(), r);
                }
            }
            _ => {}
        }
    }
    let lines: Vec<String> = req.ops.iter().map(Op::describe).collect();
    let out = c.edit(&id, &req).await?;
    let mut v = to_value(&out);
    v["ops"] = json!(lines);
    ctx.out(&v, || format!("Applied {} op{} in one change:\n  {}\nNow at version {}.", lines.len(), if lines.len() == 1 { "" } else { "s" }, lines.join("\n  "), out.version));
    Ok(())
}

fn parse_ops(v: Value) -> R<Vec<Op>> {
    let arr = v.as_array().cloned().unwrap_or_default();
    arr.into_iter()
        .enumerate()
        .map(|(i, o)| {
            serde_json::from_value(o.clone()).map_err(|e| {
                Fail::new(
                    "invalid_ops",
                    format!("Op #{} is not valid ({e}): {}", i + 1, o.to_string().chars().take(160).collect::<String>()),
                    "Each op needs \"op\" (add_slide, update_slide, move_slide, delete_slide, add_element, update_element, replace_text, reorder_element, delete_element, update_deck) and its fields. See: present docs ops",
                )
            })
        })
        .collect()
}

fn frame_of(f: &FrameArgs, size: (f64, f64), default: Frame) -> Frame {
    let w = f.w.unwrap_or(default.w);
    let h = f.h.unwrap_or(default.h);
    Frame {
        x: f.x.unwrap_or(if f.w.is_some() && f.x.is_none() { ((size.0 - w) / 2.0).round() } else { default.x }),
        y: f.y.unwrap_or(if f.h.is_some() && f.y.is_none() { ((size.1 - h) / 2.0).round() } else { default.y }),
        w,
        h,
    }
}

fn centered(size: (f64, f64), w: f64, h: f64) -> Frame {
    Frame { x: ((size.0 - w) / 2.0).round(), y: ((size.1 - h) / 2.0).round(), w, h }
}

fn styled_text(text: &str, s: &TextStyleArgs) -> Value {
    let mut inline = Map::new();
    if let Some(v) = s.size {
        inline.insert("size".into(), json!(v));
    }
    if s.bold {
        inline.insert("bold".into(), json!(true));
    }
    if s.italic {
        inline.insert("italic".into(), json!(true));
    }
    if let Some(v) = &s.color {
        inline.insert("color".into(), json!(v));
    }
    if let Some(v) = &s.font {
        inline.insert("font".into(), json!(v));
    }
    let mut para = Map::new();
    if let Some(v) = &s.align {
        para.insert("align".into(), json!(v));
    }
    if let Some(v) = s.heading {
        para.insert("heading".into(), json!(v));
    }
    if let Some(v) = &s.list {
        para.insert("list".into(), json!(v));
    }
    deck::rich_text_styled(text, &inline, &para)
}

fn box_style(s: &TextStyleArgs) -> Map<String, Value> {
    let mut style = Map::new();
    if let Some(f) = &s.fill {
        style.insert("fill".into(), json!(f));
    }
    if let Some(v) = &s.valign {
        style.insert("verticalAlign".into(), json!(v));
    }
    style
}

pub async fn add(ctx: &Ctx, cmd: &AddCmd) -> R<()> {
    let c = ctx.authed().await?;
    let (deck_ref, slide_ref, frame_args) = match cmd {
        AddCmd::Text { deck, slide, frame, .. }
        | AddCmd::Shape { deck, slide, frame, .. }
        | AddCmd::Image { deck, slide, frame, .. }
        | AddCmd::Video { deck, slide, frame, .. }
        | AddCmd::Audio { deck, slide, frame, .. }
        | AddCmd::Table { deck, slide, frame, .. }
        | AddCmd::Chart { deck, slide, frame, .. }
        | AddCmd::Html { deck, slide, frame, .. } => (deck, slide, frame),
    };
    let id = ctx.deck_id(&c, deck_ref).await?;
    let content = c.content(&id, None).await?;
    let sid = if frame_args.master { "master".to_owned() } else { ctx.slide_id(&content, slide_ref)? };
    let size = deck::size(&content);
    let mut fields = Map::new();
    let (kind, frame) = match cmd {
        AddCmd::Text { text, style, .. } => {
            let text = read_text_arg(text)?;
            fields.insert("text".into(), styled_text(&text, style));
            fields.insert("style".into(), Value::Object(box_style(style)));
            if let Some(l) = &style.link {
                fields.insert("link".into(), json!(l));
            }
            ("text", frame_of(frame_args, size, Frame { x: 140.0, y: 300.0, w: size.0 - 280.0, h: 200.0 }))
        }
        AddCmd::Shape { shape, text, stroke, stroke_width, style, .. } => {
            if !deck::SHAPES.contains(&shape.as_str()) {
                return Err(Fail::new("unknown_shape", format!("`{shape}` is not a shape."), format!("Use one of: {}.", deck::SHAPES.join(", "))));
            }
            fields.insert("shape".into(), json!(shape));
            fields.insert("text".into(), text.as_deref().map_or_else(|| json!({ "paragraphs": [] }), |t| styled_text(t, style)));
            let mut st = box_style(style);
            if let Some(s) = stroke {
                st.insert("stroke".into(), json!(s));
            }
            if let Some(w) = stroke_width {
                st.insert("strokeWidth".into(), json!(w));
            }
            fields.insert("style".into(), Value::Object(st));
            ("shape", frame_of(frame_args, size, centered(size, 400.0, 300.0)))
        }
        AddCmd::Image { source, alt, fit, .. } => {
            fields.insert("src".into(), json!(media_src(&c, &id, source).await?));
            fields.insert("alt".into(), json!(alt));
            fields.insert("fit".into(), json!(fit));
            ("image", frame_of(frame_args, size, centered(size, 960.0, 540.0)))
        }
        AddCmd::Video { source, poster, autoplay, looped, muted, alt, .. } => {
            fields.insert("src".into(), json!(media_src(&c, &id, source).await?));
            fields.insert("poster".into(), match poster {
                Some(p) => json!(media_src(&c, &id, p).await?),
                None => Value::Null,
            });
            fields.insert("autoplay".into(), json!(autoplay));
            fields.insert("loop".into(), json!(looped));
            fields.insert("muted".into(), json!(muted));
            fields.insert("alt".into(), json!(alt));
            ("video", frame_of(frame_args, size, centered(size, 1280.0, 720.0)))
        }
        AddCmd::Audio { source, autoplay, looped, alt, .. } => {
            fields.insert("src".into(), json!(media_src(&c, &id, source).await?));
            fields.insert("autoplay".into(), json!(autoplay));
            fields.insert("loop".into(), json!(looped));
            fields.insert("muted".into(), json!(false));
            fields.insert("alt".into(), json!(alt));
            ("audio", frame_of(frame_args, size, Frame { x: 140.0, y: size.1 - 220.0, w: 600.0, h: 80.0 }))
        }
        AddCmd::Table { rows, cols, csv, cell, header, .. } => {
            let mut data: Vec<Vec<String>> = match csv {
                Some(p) => parse_csv(&String::from_utf8_lossy(&read_file(p)?)),
                None => vec![],
            };
            for spec in cell {
                let (pos, text) = spec.split_once('=').ok_or_else(|| Fail::new("invalid_input", format!("--cell {spec} is not r,c=text."), "e.g. --cell 0,1=Q4"))?;
                let (r, c2) = pos.split_once(',').ok_or_else(|| Fail::new("invalid_input", format!("--cell {spec} is not r,c=text."), "e.g. --cell 0,1=Q4"))?;
                let r: usize = r.trim().parse().map_err(|_| Fail::new("invalid_input", format!("Row `{r}` in --cell {spec} is not a number."), ""))?;
                let c2: usize = c2.trim().parse().map_err(|_| Fail::new("invalid_input", format!("Column `{c2}` in --cell {spec} is not a number."), ""))?;
                while data.len() <= r {
                    data.push(vec![]);
                }
                while data[r].len() <= c2 {
                    data[r].push(String::new());
                }
                data[r][c2] = text.to_owned();
            }
            let rows = rows.unwrap_or(data.len()).max(1);
            let cols = cols.unwrap_or_else(|| data.iter().map(Vec::len).max().unwrap_or(0)).max(1);
            let f = frame_of(frame_args, size, centered(size, (cols as f64 * 280.0).min(size.0 - 280.0), (rows as f64 * 80.0).min(size.1 - 280.0)));
            fields.insert("rows".into(), json!(rows));
            fields.insert("cols".into(), json!(cols));
            fields.insert("colWidths".into(), json!(vec![(f.w / cols as f64).round(); cols]));
            fields.insert("rowHeights".into(), json!(vec![(f.h / rows as f64).round(); rows]));
            fields.insert("headerRow".into(), json!(header));
            fields.insert("cells".into(), deck::table_cells(rows, cols, &data));
            ("table", f)
        }
        AddCmd::Chart { kind, labels, series, title, no_legend, .. } => {
            let mut ser = Vec::new();
            for s in series {
                let (name, rest) = s.split_once('=').ok_or_else(|| Fail::new("invalid_input", format!("--series {s} is not name=v1,v2,…"), "e.g. --series \"Revenue=10,12,15\""))?;
                let (vals, color) = match rest.split_once('@') {
                    Some((v, c)) => (v, Some(c)),
                    None => (rest, None),
                };
                let values: Result<Vec<f64>, _> = vals.split(',').map(|v| v.trim().parse::<f64>()).collect();
                let values = values.map_err(|_| Fail::new("invalid_input", format!("--series {s} has a value that is not a number."), "Values are comma-separated numbers."))?;
                let mut o = json!({ "name": name, "values": values });
                if let Some(c) = color {
                    o["color"] = json!(c);
                }
                ser.push(o);
            }
            let mut chart = json!({ "type": kind, "labels": labels, "series": ser, "legend": !no_legend });
            if let Some(t) = title {
                chart["title"] = json!(t);
            }
            fields.insert("chart".into(), chart);
            ("chart", frame_of(frame_args, size, centered(size, 1200.0, 700.0)))
        }
        AddCmd::Html { html, css, js, .. } => {
            let html_text = match html.as_deref() {
                Some(h) if h != "-" => String::from_utf8_lossy(&read_file(Path::new(h))?).into_owned(),
                Some(_) => read_text_arg("-")?,
                None => String::new(),
            };
            let read_opt = |p: &Option<PathBuf>| -> R<String> { p.as_ref().map_or(Ok(String::new()), |p| Ok(String::from_utf8_lossy(&read_file(p)?).into_owned())) };
            fields.insert("html".into(), json!(html_text));
            fields.insert("css".into(), json!(read_opt(css)?));
            fields.insert("js".into(), json!(read_opt(js)?));
            ("html", frame_of(frame_args, size, Frame { x: 0.0, y: 0.0, w: size.0, h: size.1 }))
        }
    };
    let element = deck::element(kind, frame, fields);
    let before = slide_words(&content, &sid);
    check_slide_words(ctx, before, before + element_words(&element))?;
    let eid = deck::str_field(&element, "id").unwrap_or_default().to_owned();
    let extra = json!({ "slide": sid, "element": eid });
    apply_with(ctx, &c, &id, vec![Op::AddElement { slide: sid.clone(), element, z: None }], None, extra, |_| format!("{eid}\nAdded {kind} {eid} to {sid}.")).await.map(|_| ())
}

fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut row = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '"' if quoted && chars.peek() == Some(&'"') => {
                    cur.push('"');
                    chars.next();
                }
                '"' => quoted = !quoted,
                ',' if !quoted => row.push(std::mem::take(&mut cur)),
                _ => cur.push(ch),
            }
        }
        row.push(cur);
        rows.push(row);
    }
    rows
}

/// Parses `key=value`: JSON when it is valid JSON, `@file` reads a file, else text.
fn parse_value(key: &str, raw: &str) -> R<Value> {
    if let Some(path) = raw.strip_prefix('@') {
        return Ok(Value::String(String::from_utf8_lossy(&read_file(Path::new(path))?).into_owned()));
    }
    // Code and text fields are always text, so `html=<b>1</b>` or `text=42` mean what they say.
    if matches!(key, "html" | "css" | "js" | "alt" | "src" | "shape" | "fit" | "group" | "link" | "notes") {
        return Ok(match serde_json::from_str::<Value>(raw) {
            Ok(Value::String(s)) => Value::String(s),
            Ok(Value::Null) if matches!(key, "group" | "link") => Value::Null,
            _ => Value::String(raw.to_owned()),
        });
    }
    if key == "text" {
        return Ok(match serde_json::from_str::<Value>(raw) {
            Ok(v @ Value::Object(_)) => v,
            Ok(Value::String(s)) => deck::rich_text(&s),
            _ => deck::rich_text(raw),
        });
    }
    Ok(serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_owned())))
}

pub async fn set(ctx: &Ctx, deck: &str, slide: &str, element: &str, pairs: &[String]) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let content = c.content(&id, None).await?;
    let sid = ctx.slide_id(&content, slide)?;
    let el = ctx.element(&content, &sid, element)?.clone();
    let eid = deck::str_field(&el, "id").unwrap_or_default().to_owned();
    let mut set = Map::new();
    for pair in pairs {
        let (key, raw) = pair.split_once('=').ok_or_else(|| {
            Fail::new("invalid_input", format!("`{pair}` is not key=value."), "e.g. x=100, style.fill=#ff0000, text=\"Hello\"")
        })?;
        let key = key.trim();
        if key == "id" || key == "kind" {
            return Err(Fail::new("invalid_input", format!("`{key}` can't be changed."), "Delete the element and add a new one instead."));
        }
        match key.split_once('.') {
            None if key == "text" && !raw.trim_start().starts_with('{') => {
                // Plain text keeps the look of what it replaces: the first paragraph's attributes
                // (heading, list, align) and the first run's (size, bold, colour, font).
                let text = match parse_value("notes", raw)? {
                    Value::String(t) => t,
                    other => other.to_string(),
                };
                let first_p = el.pointer("/text/paragraphs/0").and_then(Value::as_object).cloned().unwrap_or_default();
                let mut para = first_p.clone();
                para.remove("runs");
                let mut inline = first_p
                    .get("runs")
                    .and_then(|r| r.get(0))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                inline.remove("text");
                set.insert("text".into(), deck::rich_text_styled(&text, &inline, &para));
            }
            None => {
                set.insert(key.to_owned(), parse_value(key, raw)?);
            }
            Some((top, rest)) => {
                // Plain values are replaced whole, so start from the current one.
                let mut cur = set.get(top).cloned().or_else(|| el.get(top).cloned()).filter(Value::is_object).unwrap_or_else(|| json!({}));
                let mut target = &mut cur;
                let parts: Vec<&str> = rest.split('.').collect();
                for (i, p) in parts.iter().enumerate() {
                    if i == parts.len() - 1 {
                        target[*p] = parse_value(p, raw)?;
                    } else {
                        if !target.get(*p).is_some_and(Value::is_object) {
                            target[*p] = json!({});
                        }
                        target = &mut target[*p];
                    }
                }
                set.insert(top.to_owned(), cur);
            }
        }
    }
    if set.contains_key("text") || set.contains_key("cells") {
        let mut changed = el.clone();
        for (k, v) in &set {
            changed[k] = v.clone();
        }
        let before = slide_words(&content, &sid);
        check_slide_words(ctx, before, before - element_words(&el) + element_words(&changed))?;
    }
    let keys: Vec<String> = set.keys().cloned().collect();
    apply(ctx, &c, &id, vec![Op::UpdateElement { slide: sid.clone(), element: eid.clone(), set }], None, |_| format!("Changed {} on {eid}.", keys.join(", "))).await.map(|_| ())
}

#[allow(clippy::too_many_arguments)]
pub async fn replace(ctx: &Ctx, deck: &str, slide: &str, element: Option<&str>, find: &str, replace: &str, all: bool, field: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let content = c.content(&id, None).await?;
    let sid = ctx.slide_id(&content, slide)?;
    let eid = match element {
        Some(e) => Some(deck::str_field(ctx.element(&content, &sid, e)?, "id").unwrap_or_default().to_owned()),
        None => None,
    };
    let op = Op::ReplaceText {
        slide: sid.clone(),
        element: eid,
        field: field.map(str::to_owned),
        find: find.to_owned(),
        replace: replace.to_owned(),
        all,
    };
    apply(ctx, &c, &id, vec![op], None, |v| {
        let n = v.get("replacements").and_then(Value::as_u64);
        match n {
            Some(n) => format!("Replaced {n} occurrence{} on {sid}.", if n == 1 { "" } else { "s" }),
            None => format!("Replaced on {sid}."),
        }
    })
    .await
    .map(|_| ())
}

pub async fn delete_element(ctx: &Ctx, deck: &str, slide: &str, element: &str) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck).await?;
    let content = c.content(&id, None).await?;
    let sid = ctx.slide_id(&content, slide)?;
    let eid = deck::str_field(ctx.element(&content, &sid, element)?, "id").unwrap_or_default().to_owned();
    apply(ctx, &c, &id, vec![Op::DeleteElement { slide: sid.clone(), element: eid.clone() }], None, |_| format!("Deleted {eid} from {sid}.")).await.map(|_| ())
}

/// What `present theme` does with your saved themes besides setting one.
pub struct ThemeManage<'a> {
    pub save: Option<&'a str>,
    pub delete: Option<&'a str>,
    pub rename: Option<&'a str>,
    pub to: Option<&'a str>,
}

/// One of your saved themes, by id or (ignoring case) name.
fn saved_theme<'a>(themes: &'a [Value], key: &str) -> Option<&'a Value> {
    let key = key.trim();
    themes.iter().find(|t| t["id"].as_str() == Some(key)).or_else(|| themes.iter().find(|t| t["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(key))))
}

fn unknown_theme(n: &str, saved: &[Value]) -> Fail {
    let mut names: Vec<String> = deck::THEMES.iter().map(|t| t.0.to_owned()).collect();
    names.extend(saved.iter().filter_map(|t| t["name"].as_str().map(|n| format!("\"{n}\""))));
    Fail::new("unknown_theme", format!("`{n}` is not a built-in theme or one of yours."), format!("Use one of: {} (see present theme --list).", names.join(", ")))
}

fn theme_line(name: &str, t: &Value) -> String {
    let c = &t["colors"];
    let s = |v: &Value| v.as_str().unwrap_or("").to_owned();
    format!("{name:<8} {} / {}  background {} text {} accent {}", s(&t["fonts"]["heading"]), s(&t["fonts"]["body"]), s(&c["background"]), s(&c["text"]), s(&c["accent"]))
}

#[allow(clippy::too_many_arguments)]
pub async fn theme(ctx: &Ctx, deck: Option<&str>, name: Option<&str>, heading: Option<&str>, body: Option<&str>, colors: &[String], list: bool, manage: ThemeManage<'_>) -> R<()> {
    if let Some(key) = manage.delete.or(manage.rename) {
        let c = ctx.authed().await?;
        let saved = c.themes().await?;
        let t = saved_theme(&saved, key).ok_or_else(|| Fail::new("theme_not_found", format!("You have no theme `{key}`."), "See your themes with present theme --list."))?;
        let (tid, tname) = (t["id"].as_str().unwrap_or_default().to_owned(), t["name"].as_str().unwrap_or_default().to_owned());
        if manage.delete.is_some() {
            c.delete_theme(&tid).await?;
            ctx.out(&json!({ "deleted": tid, "name": tname }), || format!("Deleted your theme {tname}. Decks already using it keep their look."));
        } else {
            let v = c.update_theme(&tid, &json!({ "name": manage.to.unwrap_or_default() })).await?;
            let new = v["name"].as_str().unwrap_or_default().to_owned();
            ctx.out(&v, || format!("Renamed your theme {tname} to {new}."));
        }
        return Ok(());
    }
    if list || deck.is_none() {
        if manage.save.is_some() {
            return Err(Fail::new("invalid_input", "--save needs the deck whose theme to save.", "e.g. present theme dk7Hq2mP9xRt --save Brand"));
        }
        let builtin: Vec<Value> = deck::THEMES.iter().filter_map(|t| deck::theme(t.0)).collect();
        let saved = if ctx.session().await?.is_some() { ctx.authed().await?.themes().await? } else { Vec::new() };
        ctx.out(&json!({ "themes": builtin, "yours": saved }), || {
            let mut lines: Vec<String> = builtin.iter().map(|t| theme_line(t["name"].as_str().unwrap_or_default(), t)).collect();
            lines.push(String::new());
            if saved.is_empty() {
                lines.push("Your themes: none yet. Save a deck's theme with present theme <deck> --save <name>.".into());
            } else {
                lines.push("Your themes:".into());
                lines.extend(saved.iter().map(|t| theme_line(t["name"].as_str().unwrap_or_default(), t)));
            }
            lines.join("\n")
        });
        return Ok(());
    }
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck.unwrap_or_default()).await?;
    let changing = name.is_some() || heading.is_some() || body.is_some() || !colors.is_empty();
    if changing || manage.save.is_none() {
        let content = c.content(&id, None).await?;
        let mut theme = match name {
            Some(n) => match deck::theme(n) {
                Some(t) => t,
                None => {
                    let saved = c.themes().await?;
                    let t = saved_theme(&saved, n).ok_or_else(|| unknown_theme(n, &saved))?;
                    let tid = t["id"].as_str().unwrap_or_default().to_owned();
                    c.use_theme(&tid, &id).await?["theme"].clone()
                }
            },
            None => content.get("theme").cloned().unwrap_or_else(|| deck::theme("Paper").unwrap_or_default()),
        };
        if let Some(h) = heading {
            theme["fonts"]["heading"] = json!(h);
        }
        if let Some(b) = body {
            theme["fonts"]["body"] = json!(b);
        }
        for spec in colors {
            let (k, v) = spec.split_once('=').ok_or_else(|| Fail::new("invalid_input", format!("--color {spec} is not key=#hex."), "e.g. --color accent=#b4532a"))?;
            if !["background", "text", "accent", "accent2", "accent3", "muted"].contains(&k) {
                return Err(Fail::new("invalid_input", format!("`{k}` is not a theme colour."), "Use background, text, accent, accent2, accent3 or muted."));
            }
            theme["colors"][k] = json!(v);
        }
        let mut set = Map::new();
        set.insert("theme".into(), theme.clone());
        let name = theme["name"].as_str().unwrap_or_default().to_owned();
        apply(ctx, &c, &id, vec![Op::UpdateDeck { set }], None, |_| format!("Theme set to {name}.")).await?;
    }
    if let Some(save) = manage.save {
        let v = c.save_theme(&id, Some(save)).await?;
        let name = v["name"].as_str().unwrap_or_default().to_owned();
        ctx.out(&v, || format!("Saved the deck's theme to your themes as {name}. Use it in any deck you edit: present theme <deck> \"{name}\""));
    }
    Ok(())
}
