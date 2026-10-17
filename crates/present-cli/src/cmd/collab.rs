//! Comments, sharing and versions.

use crate::args::{CommentArgs, CommentCmd, PublicArg, RoleArg};
use crate::ctx::{Ctx, to_value};
use crate::fail::{Fail, R};
use serde_json::{Value, json};
use silicon_present_client::{Anchor, PublicMode, ResourceKind, Role, Thread, deck};

fn nums(s: &str, n: usize, what: &str) -> R<Vec<f64>> {
    let v: Result<Vec<f64>, _> = s.split(',').map(|x| x.trim().parse::<f64>()).collect();
    match v {
        Ok(v) if v.len() == n => Ok(v),
        _ => Err(Fail::new(
            "invalid_input",
            format!("`{s}` is not {what}."),
            if n == 2 { "Give x,y in slide px, e.g. --point 960,540." } else { "Give x,y,w,h in slide px, e.g. --area 100,100,600,400." },
        )),
    }
}

fn anchor_label(t: &Thread) -> String {
    let a = &t.anchor;
    let kind = a.get("kind").and_then(Value::as_str).unwrap_or("deck");
    let snap = a.get("snapshot");
    let slide_n = snap.and_then(|s| s.get("slideNumber")).map(ToString::to_string);
    let label = snap.and_then(|s| s.get("label")).and_then(Value::as_str).unwrap_or_default();
    let slide = slide_n.or_else(|| a.get("slide").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default();
    match kind {
        "deck" => "the deck".into(),
        "slide" => format!("slide {slide}"),
        "point" => format!("slide {slide} at {},{}", a["x"], a["y"]),
        "area" => format!("slide {slide} area {},{} {}×{}", a["x"], a["y"], a["w"], a["h"]),
        "element" => format!("slide {slide} {} {label}", a.get("element").and_then(Value::as_str).unwrap_or_default()),
        "text" => format!("slide {slide} text \"{}\"", a.get("quote").and_then(Value::as_str).unwrap_or_default()),
        k => format!("{k} on slide {slide}"),
    }
}

pub async fn list(ctx: &Ctx, deck_ref: &str, resolved: bool, all: bool) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let state = if all { "all" } else if resolved { "resolved" } else { "open" };
    let threads = c.threads(&id, state).await?;
    ctx.out(&json!({ "deck": id, "threads": threads }), || {
        if threads.is_empty() {
            return format!("No {state} threads on {id}.");
        }
        let mut out = Vec::new();
        for t in &threads {
            out.push(format!("thread {} [{}] on {}", t.id, t.state, anchor_label(t)));
            for cm in &t.comments {
                let who = cm.author.as_ref().map(|a| a.label().to_owned()).unwrap_or_default();
                let body = if cm.deleted { "(deleted)".to_owned() } else { cm.body.clone() };
                let reactions = match &cm.reactions {
                    Value::Array(a) if !a.is_empty() => format!("  {}", a.iter().map(|r| r.get("emoji").and_then(Value::as_str).unwrap_or_default()).collect::<Vec<_>>().join(" ")),
                    Value::Object(o) if !o.is_empty() => format!("  {}", o.keys().cloned().collect::<Vec<_>>().join(" ")),
                    _ => String::new(),
                };
                out.push(format!("  {} {who}: {body}{reactions}", cm.id));
            }
        }
        out.join("\n")
    });
    Ok(())
}

pub async fn comment(ctx: &Ctx, a: &CommentArgs) -> R<()> {
    let c = ctx.authed().await?;
    if let Some(sub) = &a.sub {
        return match sub {
            CommentCmd::Edit { comment, body } => {
                let v = c.edit_comment(comment, body).await?;
                ctx.out(&v, || format!("Edited comment {comment}."));
                Ok(())
            }
            CommentCmd::Delete { comment } => {
                let v = c.delete_comment(comment).await?;
                ctx.out(&if v.is_null() { json!({ "deleted": comment }) } else { v }, || format!("Deleted comment {comment} (kept in the history)."));
                Ok(())
            }
        };
    }
    let deck_ref = a.deck.as_deref().unwrap_or_default();
    let body = a.body.clone().unwrap_or_default();
    let id = ctx.deck_id(&c, deck_ref).await?;
    let anchor = if a.deck_wide || a.slide.is_none() {
        if a.slide.is_none() && !a.deck_wide {
            return Err(Fail::new(
                "missing_anchor",
                "What is the comment on? Give --deck, or --slide N (with --point, --area, --element or --text).",
                "e.g. present comment <deck> --slide 2 \"Tighten this\"",
            ));
        }
        Anchor::Deck
    } else {
        let content = c.content(&id, None).await?;
        let sid = ctx.slide_id(&content, a.slide.as_deref().unwrap_or_default())?;
        let el = match &a.element {
            Some(e) => Some(ctx.element(&content, &sid, e)?.clone()),
            None => None,
        };
        let eid = el.as_ref().and_then(|e| deck::str_field(e, "id")).map(str::to_owned);
        let rel = |x: f64, y: f64| -> (Option<f64>, Option<f64>) {
            match &el {
                Some(e) => {
                    let (ex, ey, ew, eh) = (
                        e["x"].as_f64().unwrap_or(0.0),
                        e["y"].as_f64().unwrap_or(0.0),
                        e["w"].as_f64().unwrap_or(1.0).max(1.0),
                        e["h"].as_f64().unwrap_or(1.0).max(1.0),
                    );
                    (Some(((x - ex) / ew).clamp(0.0, 1.0)), Some(((y - ey) / eh).clamp(0.0, 1.0)))
                }
                None => (None, None),
            }
        };
        if let Some(p) = &a.point {
            let v = nums(p, 2, "a point x,y")?;
            let (ex, ey) = rel(v[0], v[1]);
            Anchor::Point { slide: sid, x: v[0], y: v[1], element: eid, ex, ey }
        } else if let Some(ar) = &a.area {
            let v = nums(ar, 4, "an area x,y,w,h")?;
            let (ex, ey) = rel(v[0], v[1]);
            let (ew, eh) = match &el {
                Some(e) => (
                    Some((v[2] / e["w"].as_f64().unwrap_or(1.0).max(1.0)).clamp(0.0, 1.0)),
                    Some((v[3] / e["h"].as_f64().unwrap_or(1.0).max(1.0)).clamp(0.0, 1.0)),
                ),
                None => (None, None),
            };
            Anchor::Area { slide: sid, x: v[0], y: v[1], w: v[2], h: v[3], element: eid, ex, ey, ew, eh }
        } else if let Some(q) = &a.text {
            let field = a.field.clone().unwrap_or_else(|| "text".into());
            let element = match (eid, field.as_str()) {
                (Some(e), _) => e,
                (None, "notes") => String::new(),
                (None, _) => {
                    return Err(Fail::new("missing_element", "A comment on text needs the element it is in (--element).", "Or use --field notes for the speaker notes."));
                }
            };
            Anchor::Text { slide: sid, element, field, quote: q.clone() }
        } else if let Some(e) = eid {
            Anchor::Element { slide: sid, element: e }
        } else {
            Anchor::Slide { slide: sid }
        }
    };
    let t = c.comment(&id, &anchor, &body).await?;
    let first = t.comments.first().map(|c| c.id.clone()).unwrap_or_default();
    let mut v = to_value(&t);
    v["deck"] = json!(id);
    ctx.out(&v, || format!("{}\nCommented on {} (thread {}, comment {first}).", t.id, anchor_label(&t), t.id));
    Ok(())
}

pub async fn reply(ctx: &Ctx, thread: &str, body: &str) -> R<()> {
    let c = ctx.authed().await?;
    let cm = c.reply(thread, body).await?;
    ctx.out(&to_value(&cm), || format!("{}\nReplied in thread {thread}.", cm.id));
    Ok(())
}

pub async fn react(ctx: &Ctx, comment: &str, emoji: &str, remove: bool) -> R<()> {
    let c = ctx.authed().await?;
    let v = c.react(comment, emoji, remove).await?;
    ctx.out(&if v.is_null() { json!({ "comment": comment, "emoji": emoji, "removed": remove }) } else { v }, || {
        if remove { format!("Removed {emoji} from {comment}.") } else { format!("Reacted {emoji} to {comment}.") }
    });
    Ok(())
}

pub async fn resolve(ctx: &Ctx, thread: &str, reopen: bool) -> R<()> {
    let c = ctx.authed().await?;
    let v = if reopen { c.reopen(thread).await? } else { c.resolve(thread).await? };
    ctx.out(&if v.is_null() { json!({ "thread": thread, "state": if reopen { "open" } else { "resolved" } }) } else { v }, || {
        if reopen { format!("Reopened thread {thread}.") } else { format!("Resolved thread {thread}.") }
    });
    Ok(())
}

pub fn role(r: RoleArg) -> Role {
    match r {
        RoleArg::Editor => Role::Editor,
        RoleArg::Commenter => Role::Commenter,
        RoleArg::Viewer => Role::Viewer,
    }
}

async fn target(ctx: &Ctx, c: &silicon_present_client::Client, t: &str, folder: bool) -> R<(ResourceKind, String)> {
    if folder {
        Ok((ResourceKind::Folder, t.to_owned()))
    } else {
        Ok((ResourceKind::Deck, ctx.deck_id(c, t).await?))
    }
}

pub async fn share(ctx: &Ctx, t: &str, to: &str, r: RoleArg, folder: bool) -> R<()> {
    let c = ctx.authed().await?;
    let (kind, id) = target(ctx, &c, t, folder).await?;
    let m = c.share(kind, &id, to, role(r)).await?;
    ctx.out(&to_value(&m), || {
        let pending = m.account.is_none() && m.email.is_some();
        format!(
            "Shared {id} with {to} as {}.{}",
            if m.role.is_empty() { role(r).as_str() } else { &m.role },
            if pending { " They are not on Silicon Accounts yet, so they get an invite to join." } else { "" }
        )
    });
    Ok(())
}

pub async fn access(ctx: &Ctx, t: &str, folder: bool) -> R<()> {
    let c = ctx.authed().await?;
    let (kind, id) = target(ctx, &c, t, folder).await?;
    let a = c.access(kind, &id).await?;
    ctx.out(&to_value(&a), || {
        let mut out = vec![];
        if let Some(o) = &a.owner {
            out.push(format!("owner      {}", o.label()));
        }
        for m in &a.members {
            let who = m.account.as_ref().map(|a| a.label().to_owned()).or_else(|| m.email.clone()).unwrap_or_default();
            let via = m
                .extra
                .get("via")
                .filter(|v| !v.is_null())
                .map(|v| format!("  (via folder {})", v.get("name").and_then(Value::as_str).or_else(|| v.as_str()).unwrap_or_default()))
                .unwrap_or_default();
            out.push(format!("{:<10} {who}{}{via}", m.role, if m.account.is_none() { "  (invited)" } else { "" }));
        }
        if let Some(p) = &a.public {
            out.push(format!("public     {p}"));
        }
        out.join("\n")
    });
    Ok(())
}

pub async fn unshare(ctx: &Ctx, t: &str, member: &str, folder: bool) -> R<()> {
    let c = ctx.authed().await?;
    let (kind, id) = target(ctx, &c, t, folder).await?;
    // Accept c:id / si:id / email and turn it into the member key the service uses.
    let key = if member.contains(':') && (member.starts_with("c:") || member.starts_with("si:")) || member.contains('@') {
        let a = c.access(kind, &id).await?;
        a.members
            .iter()
            .find(|m| m.account.as_ref().is_some_and(|x| x.id == member || x.uuid == member) || m.email.as_deref() == Some(member))
            .and_then(silicon_present_client::Member::key)
            .ok_or_else(|| Fail::new("not_a_member", format!("{member} has no direct access to {id}."), format!("See who does with: present access {id}")))?
    } else {
        member.to_owned()
    };
    let v = c.unshare(kind, &id, &key).await?;
    ctx.out(&if v.is_null() { json!({ "removed": member }) } else { v }, || format!("Removed {member} from {id}."));
    Ok(())
}

pub async fn public(ctx: &Ctx, deck_ref: &str, mode: PublicArg) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let m = match mode {
        PublicArg::Off => PublicMode::Off,
        PublicArg::View => PublicMode::View,
        PublicArg::Comment => PublicMode::Comment,
        PublicArg::Edit => PublicMode::Edit,
    };
    let v = c.set_public(&id, m).await?;
    ctx.out(&if v.is_null() { json!({ "deck": id, "public": m.as_str() }) } else { v }, || match m {
        PublicMode::Off => format!("{id} is private again; its link stopped working."),
        _ => format!("Anyone with the link can now {} {id}.", m.as_str()),
    });
    Ok(())
}

pub async fn versions(ctx: &Ctx, deck_ref: &str) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let raw = c.versions_raw(&id).await?;
    let list = c.versions(&id).await?;
    if ctx.json {
        ctx.print_json(&if raw.is_array() { json!({ "versions": raw }) } else { raw });
        return Ok(());
    }
    if list.is_empty() {
        println!("No versions yet.");
    }
    for v in &list {
        let when = v.ended_at.clone().or_else(|| v.started_at.clone()).unwrap_or_default();
        let name = v.name.as_deref().map(|n| format!("  \"{n}\"")).unwrap_or_default();
        println!("v{:<5} {when}  {}{name}", v.version, v.summary);
    }
    if let Some(events) = raw.get("events").and_then(Value::as_array).filter(|e| !e.is_empty()) {
        println!("\nEvents:");
        for e in events {
            let who = e.pointer("/actor/id").and_then(Value::as_str).unwrap_or("someone");
            let kind = e.get("kind").and_then(Value::as_str).unwrap_or_default();
            let at = e.get("createdAt").and_then(Value::as_str).unwrap_or_default();
            let data = e.get("data").filter(|d| d.as_object().is_some_and(|o| !o.is_empty())).map(|d| format!(" {d}")).unwrap_or_default();
            println!("  {at}  {who} {kind}{data}");
        }
    }
    Ok(())
}

pub async fn name_version(ctx: &Ctx, deck_ref: &str, version: u64, name: &str) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let v = c.name_version(&id, version, name).await?;
    ctx.out(&if v.is_null() { json!({ "deck": id, "version": version, "name": name }) } else { v }, || format!("Named version {version} of {id} \"{name}\"."));
    Ok(())
}

pub async fn compare(ctx: &Ctx, deck_ref: &str, from: u64, to: u64) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let v = c.compare(&id, from, to).await?;
    if ctx.json {
        ctx.print_json(&v);
        return Ok(());
    }
    println!("{} → {}: {}", v["from"], v["to"], v.get("summary").and_then(Value::as_str).unwrap_or("no changes"));
    let d = v.get("diff").cloned().unwrap_or_default();
    let refs = |key: &str| -> Vec<String> {
        d.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|s| format!("{} ({})", s["number"], s["id"].as_str().unwrap_or_default())).collect())
            .unwrap_or_default()
    };
    for (key, label) in [("slidesAdded", "added"), ("slidesRemoved", "removed"), ("slidesMoved", "moved")] {
        let r = refs(key);
        if !r.is_empty() {
            println!("  slides {label}: {}", r.join(", "));
        }
    }
    if let Some(f) = d.get("deckFields").and_then(Value::as_array).filter(|f| !f.is_empty()) {
        println!("  deck: {}", f.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "));
    }
    let authors = v.get("authors").cloned().unwrap_or_default();
    let mut changed: Vec<Value> = d.get("slidesChanged").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(m) = d.get("master").filter(|m| !m.is_null()) {
        changed.insert(0, m.clone());
    }
    for s in &changed {
        let sid = s["id"].as_str().unwrap_or_default();
        let by: Vec<&str> = authors.get(sid).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.get("id").and_then(Value::as_str)).collect()).unwrap_or_default();
        let fields: Vec<&str> = s.get("fields").and_then(Value::as_array).map(|f| f.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        println!(
            "  slide {} ({sid}){}{}",
            s["number"],
            if fields.is_empty() { String::new() } else { format!(" {}", fields.join(", ")) },
            if by.is_empty() { String::new() } else { format!("  by {}", by.join(", ")) }
        );
        for (key, label) in [("elementsAdded", "+"), ("elementsRemoved", "-"), ("elementsChanged", "~")] {
            for e in s.get(key).and_then(Value::as_array).into_iter().flatten() {
                let f: Vec<&str> = e.get("fields").and_then(Value::as_array).map(|f| f.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                println!("    {label} {} {}{}", e["kind"].as_str().unwrap_or_default(), e["id"].as_str().unwrap_or_default(), if f.is_empty() { String::new() } else { format!(" ({})", f.join(", ")) });
            }
        }
        if s.get("elementsReordered").and_then(Value::as_bool).unwrap_or(false) {
            println!("    elements reordered");
        }
    }
    Ok(())
}

pub async fn restore(ctx: &Ctx, deck_ref: &str, version: u64, slide: Option<&str>, element: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    // A slide number means the slide at that version.
    let sid = match slide {
        Some(s) if s.parse::<usize>().is_ok() => {
            let old = c.content(&id, Some(version)).await?;
            Some(ctx.slide_id(&old, s)?)
        }
        Some(s) => Some(s.to_owned()),
        None => None,
    };
    let v = c.restore(&id, version, sid.as_deref(), element).await?;
    ctx.out(&v, || {
        let what = match (&sid, element) {
            (Some(s), Some(e)) => format!("element {e} of slide {s}"),
            (Some(s), None) => format!("slide {s}"),
            _ => "the deck".into(),
        };
        format!(
            "Restored {what} as it was at version {version}; that is a new version{}. Nothing was lost.",
            v.get("version").map(|n| format!(" ({n})")).unwrap_or_default()
        )
    });
    Ok(())
}

pub async fn undo_account(ctx: &Ctx, deck_ref: &str, account: &str, since: u64) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let v = c.undo_account(&id, account, since).await?;
    ctx.out(&v, || format!("Undid everything {account} changed in {id} after version {since}; that is a new version."));
    Ok(())
}
