//! Export, presenting, following, watching and reports.

use crate::args::ExportFormat;
use crate::ctx::{Ctx, to_value};
use crate::fail::{Fail, R};
use crate::state::StoredPresentation;
use serde_json::{Value, json};
use silicon_present_client::{Client, Presence, Presentation, deck};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub async fn export(ctx: &Ctx, deck_ref: &str, format: ExportFormat, output: Option<&Path>, version: Option<u64>, slide: Option<&str>) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let slide_id = match slide {
        Some(s) => {
            let content = c.content(&id, version).await?;
            Some(ctx.slide_id(&content, s)?)
        }
        None => None,
    };
    let f = c.export(&id, format.as_str(), version, slide_id.as_deref()).await?;
    let path = match output {
        Some(p) if p.is_dir() => p.join(f.filename.clone().unwrap_or_else(|| default_name(&id, format, slide_id.is_some()))),
        Some(p) => p.to_path_buf(),
        None => PathBuf::from(f.filename.clone().unwrap_or_else(|| default_name(&id, format, slide_id.is_some()))),
    };
    std::fs::write(&path, &f.bytes).map_err(|e| Fail::io(&format!("write {}", path.display()), &e))?;
    let v = json!({ "deck": id, "format": format.as_str(), "path": path.display().to_string(), "bytes": f.bytes.len(), "contentType": f.content_type });
    ctx.out(&v, || format!("{}  ({} bytes, {})", path.display(), f.bytes.len(), f.content_type));
    Ok(())
}

fn default_name(id: &str, f: ExportFormat, one_slide: bool) -> String {
    let ext = match f {
        ExportFormat::Png | ExportFormat::Jpg if !one_slide => "zip",
        other => other.as_str(),
    };
    format!("{id}.{ext}")
}

/// The presentation id: given, from a follow link, or the last one started here.
fn presentation_id(ctx: &Ctx, given: Option<&str>) -> R<String> {
    if let Some(g) = given {
        let g = g.trim().trim_end_matches('/');
        return Ok(g.rsplit('/').next().unwrap_or(g).split(['?', '#']).next().unwrap_or(g).to_owned());
    }
    ctx.home
        .read()?
        .presentation
        .map(|p| p.id)
        .ok_or_else(|| Fail::new("no_presentation", "No presentation was started from here.", "Start one with `present start <deck>`, or pass --presentation <id>."))
}

fn show_state(p: &Presentation) -> String {
    let slide = p.slide.as_str().map_or_else(|| p.slide.to_string(), str::to_owned);
    let mut s = format!("Presenting {} on slide {slide}", p.id);
    if p.step > 0 {
        s.push_str(&format!(", step {}", p.step));
    }
    if let Some(n) = p.extra.get("slideNumber").and_then(Value::as_u64) {
        s.push_str(&format!(" (slide {n})"));
    }
    if p.ended_at.is_some() {
        s.push_str(" (ended)");
    }
    s
}

pub async fn start(ctx: &Ctx, deck_ref: &str, slide: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let slide_id = match slide {
        Some(s) => {
            let content = c.content(&id, None).await?;
            Some(ctx.slide_id(&content, s)?)
        }
        None => None,
    };
    let p = c.start_presentation(&id, slide_id.as_deref()).await?;
    let stored = StoredPresentation { id: p.id.clone(), deck: id.clone(), follow_url: p.follow_url.clone() };
    ctx.home.update(move |s| s.presentation = Some(stored))?;
    ctx.out(&to_value(&p), || {
        format!(
            "{}\nPresenting {id}. Follow along: {}\nMove with: present next, present prev, present goto <n>, present stop",
            p.id, p.follow_url
        )
    });
    Ok(())
}

/// Click steps on a slide: how many distinct click-triggered animation orders it has.
fn click_steps(slide: &Value) -> u64 {
    let mut orders: Vec<i64> = deck::elements(slide)
        .iter()
        .filter_map(|e| e.get("animation").filter(|a| a.get("trigger").and_then(Value::as_str) == Some("click")))
        .map(|a| a.get("order").and_then(Value::as_i64).unwrap_or(0))
        .collect();
    orders.sort_unstable();
    orders.dedup();
    orders.len() as u64
}

/// The slide value to send in the form the service uses (id, or number when it sends numbers).
fn slide_value(current: &Value, content: &Value, idx: usize) -> Value {
    let id = deck::slides(content).get(idx).and_then(|s| deck::str_field(s, "id")).unwrap_or_default();
    match current {
        Value::Number(_) => json!(idx + 1),
        _ => json!(id),
    }
}

fn current_index(p: &Presentation, content: &Value) -> usize {
    let slides = deck::slides(content);
    match &p.slide {
        Value::String(s) => slides.iter().position(|x| deck::str_field(x, "id") == Some(s)).unwrap_or(0),
        Value::Number(n) => (n.as_u64().unwrap_or(1).max(1) - 1) as usize,
        _ => 0,
    }
}

pub async fn step(ctx: &Ctx, presentation: Option<&str>, dir: i32) -> R<()> {
    let c = ctx.authed().await?;
    let pid = presentation_id(ctx, presentation)?;
    let p = c.presentation(&pid).await?;
    let deck_id = p.deck_id().or_else(|| ctx.home.read().ok()?.presentation.map(|s| s.deck)).ok_or_else(|| {
        Fail::new("unexpected_response", format!("Presentation {pid} did not say which deck it shows."), "Use present goto <n> instead.")
    })?;
    let content = c.content(&deck_id, None).await?;
    let slides = deck::slides(&content);
    let idx = current_index(&p, &content).min(slides.len().saturating_sub(1));
    let shown: Vec<usize> = (0..slides.len()).filter(|i| !slides[*i].get("skipped").and_then(Value::as_bool).unwrap_or(false)).collect();
    let steps_here = slides.get(idx).map_or(0, click_steps);
    let (to_idx, to_step) = if dir > 0 {
        if p.step < steps_here {
            (idx, p.step + 1)
        } else {
            match shown.iter().find(|i| **i > idx) {
                Some(i) => (*i, 0),
                None => {
                    ctx.out(&json!({ "presentation": pid, "end": true, "state": p }), || "That was the last slide.".into());
                    return Ok(());
                }
            }
        }
    } else if p.step > 0 {
        (idx, p.step - 1)
    } else {
        match shown.iter().rev().find(|i| **i < idx) {
            Some(i) => (*i, click_steps(&slides[*i])),
            None => {
                ctx.out(&json!({ "presentation": pid, "start": true, "state": p }), || "Already on the first slide.".into());
                return Ok(());
            }
        }
    };
    let np = c.move_presentation(&pid, &slide_value(&p.slide, &content, to_idx), to_step).await?;
    ctx.out(&to_value(&np), || format!("{} (slide {} of {})", show_state(&np), to_idx + 1, slides.len()));
    Ok(())
}

pub async fn goto(ctx: &Ctx, presentation: Option<&str>, slide: &str) -> R<()> {
    let c = ctx.authed().await?;
    let pid = presentation_id(ctx, presentation)?;
    let p = c.presentation(&pid).await?;
    let deck_id = p.deck_id().or_else(|| ctx.home.read().ok()?.presentation.map(|s| s.deck)).unwrap_or_default();
    let content = c.content(&deck_id, None).await?;
    let (idx, _) = deck::find_slide(&content, slide).ok_or_else(|| ctx.slide_id(&content, slide).err().unwrap_or_else(|| Fail::new("slide_not_found", "", "")))?;
    let idx = idx.unwrap_or(0);
    let np = c.move_presentation(&pid, &slide_value(&p.slide, &content, idx), 0).await?;
    ctx.out(&to_value(&np), || show_state(&np));
    Ok(())
}

pub async fn stop(ctx: &Ctx, presentation: Option<&str>) -> R<()> {
    let c = ctx.authed().await?;
    let pid = presentation_id(ctx, presentation)?;
    let v = c.stop_presentation(&pid).await?;
    let p2 = pid.clone();
    ctx.home.update(move |s| {
        if s.presentation.as_ref().is_some_and(|x| x.id == p2) {
            s.presentation = None;
        }
    })?;
    ctx.out(&if v.is_null() { json!({ "presentation": pid, "ended": true }) } else { v }, || format!("Stopped presenting {pid}."));
    Ok(())
}

pub async fn status(ctx: &Ctx, presentation: Option<&str>) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let pid = presentation_id(ctx, presentation)?;
    let p = c.presentation(&pid).await?;
    ctx.out(&to_value(&p), || format!("{}\nFollow: {}", show_state(&p), p.follow_url));
    Ok(())
}

fn deadline(secs: Option<u64>) -> Option<Instant> {
    secs.map(|s| Instant::now() + Duration::from_secs(s))
}

async fn next_or_timeout(stream: &mut silicon_present_client::sse::EventStream, until: Option<Instant>) -> R<Option<Option<silicon_present_client::sse::Event>>> {
    match until {
        None => Ok(Some(stream.next().await?)),
        Some(t) => {
            let left = t.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, stream.next()).await {
                Ok(r) => Ok(Some(r?)),
                Err(_) => Ok(None),
            }
        }
    }
}

pub async fn follow(ctx: &Ctx, presentation: &str, count: Option<u64>, secs: Option<u64>) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let pid = presentation_id(ctx, Some(presentation))?;
    let until = deadline(secs);
    let mut seen = 0u64;
    let mut stream = c.follow_presentation(&pid).await?;
    loop {
        let Some(ev) = next_or_timeout(&mut stream, until).await? else { return Ok(()) };
        let Some(ev) = ev else {
            // The proxy ends streams after a while; reconnect unless the presentation ended.
            let p = c.presentation(&pid).await?;
            if p.ended_at.is_some() {
                return Ok(());
            }
            stream = c.follow_presentation(&pid).await?;
            continue;
        };
        if ev.event == "ping" {
            continue;
        }
        let data = ev.json();
        if ctx.json {
            println!("{}", json!({ "event": ev.event, "data": data }));
        } else if ev.event == "ended" {
            println!("The presentation ended.");
        } else {
            let p: Presentation = serde_json::from_value(data.clone()).unwrap_or_default();
            println!("{}", if p.id.is_empty() { data.to_string() } else { show_state(&p) });
        }
        if ev.event == "ended" {
            return Ok(());
        }
        seen += 1;
        if count.is_some_and(|n| seen >= n) {
            return Ok(());
        }
    }
}

/// Removes the big Yjs payloads from an event unless asked to keep them.
fn trim_event(mut data: Value, raw: bool) -> Value {
    if !raw && let Some(o) = data.as_object_mut() {
        for k in ["update", "sv"] {
            if let Some(Value::String(s)) = o.get(k) {
                let n = s.len();
                o.insert(format!("{k}Bytes"), json!(n * 3 / 4));
                o.remove(k);
            }
        }
    }
    data
}

fn describe_event(event: &str, d: &Value) -> String {
    let who = d.get("author").or_else(|| d.get("account")).and_then(|a| a.get("id")).and_then(Value::as_str).unwrap_or("someone");
    match event {
        "sync" => format!("connected at version {}", d.get("version").map(ToString::to_string).unwrap_or_default()),
        "update" => {
            let touched = d.get("touched").and_then(Value::as_array).map(|t| t.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            format!(
                "v{} {who}: {}{}",
                d.get("version").map(ToString::to_string).unwrap_or_default(),
                d.get("summary").and_then(Value::as_str).unwrap_or("changed the deck"),
                if touched.is_empty() { String::new() } else { format!(" ({touched})") }
            )
        }
        "presence" => format!("{who} is on slide {}", d.get("slide").map(|s| s.as_str().map_or_else(|| s.to_string(), str::to_owned)).unwrap_or_default()),
        "presence_left" => format!("session {} left", d.get("session").and_then(Value::as_str).unwrap_or_default()),
        "comments" => {
            let t = d.get("thread").unwrap_or(d);
            let last = t.get("comments").and_then(Value::as_array).and_then(|c| c.last());
            let by = last.and_then(|c| c.get("author")).and_then(|a| a.get("id")).and_then(Value::as_str).unwrap_or_default();
            let body = last.and_then(|c| c.get("body")).and_then(Value::as_str).unwrap_or_default();
            format!("thread {} [{}] {by}: {body}", t.get("id").and_then(Value::as_str).unwrap_or_default(), t.get("state").and_then(Value::as_str).unwrap_or_default())
        }
        "deck" => format!("deck changed: {d}"),
        "ping" => "ping".into(),
        other => format!("{other}: {d}"),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn watch(ctx: &Ctx, deck_ref: &str, here: Option<&str>, raw: bool, pings: bool, count: Option<u64>, until_event: Option<&str>, secs: Option<u64>) -> R<()> {
    let c = ctx.maybe_authed().await?;
    let id = ctx.deck_id(&c, deck_ref).await?;
    let until = deadline(secs);
    // Showing yourself in the deck: a heartbeat every 15 s while watching (presence lasts 30 s).
    let heartbeat = match here {
        Some(sel) => {
            let content = c.content(&id, None).await?;
            let sid = ctx.slide_id(&content, sel)?;
            let session = format!("cli-{}-{}", std::process::id(), silicon_present_client::accounts::now());
            let presence = Presence { session, slide: Some(sid), selection: vec![], cursor: None };
            c.presence(&id, &presence).await?;
            Some(spawn_heartbeat(c.clone(), id.clone(), presence))
        }
        None => None,
    };
    let mut seen = 0u64;
    let mut stream = c.live(&id, None).await?;
    let result: R<()> = async {
        loop {
            let Some(ev) = next_or_timeout(&mut stream, until).await? else { return Ok(()) };
            let Some(ev) = ev else {
                stream = c.live(&id, None).await?;
                continue;
            };
            if ev.event == "ping" && !pings {
                continue;
            }
            let data = trim_event(ev.json(), raw);
            if ctx.json {
                println!("{}", json!({ "event": ev.event, "deck": id, "data": data }));
            } else {
                println!("{}", describe_event(&ev.event, &data));
            }
            if ev.event == "ping" {
                continue;
            }
            seen += 1;
            if until_event.is_some_and(|u| u == ev.event) || count.is_some_and(|n| seen >= n) {
                return Ok(());
            }
        }
    }
    .await;
    if let Some(h) = heartbeat {
        h.abort();
    }
    result
}

fn spawn_heartbeat(c: Client, id: String, presence: Presence) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let _ = c.presence(&id, &presence).await;
        }
    })
}

pub async fn report(ctx: &Ctx, message: &str, pr: Option<&str>) -> R<()> {
    if message.trim().is_empty() {
        return Err(Fail::new("empty_report", "The report message is empty.", "Say what you did, what you expected and what happened."));
    }
    let c = ctx.maybe_authed().await?;
    let context = json!({
        "cli_version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "api_url": ctx.api_url,
    });
    let v = c.report(message, pr, context).await?;
    ctx.out(&v, || {
        format!(
            "Report sent{}. Thank you.",
            v.get("id").and_then(Value::as_str).map(|i| format!(" ({i})")).unwrap_or_default()
        )
    });
    Ok(())
}
