//! The text view of a deck (`present read`): every slide with its number, id, layout, section and skipped state,
//! every element with id, kind, position, size and content, the speaker notes, and optionally the open comment
//! threads next to what they are on.

use std::fmt::Write;

use serde_json::Value;

use crate::richtext::rich_to_markdownish;

fn num(v: &Value) -> String {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else {
                let f = n.as_f64().unwrap_or(0.0);
                let r = (f * 100.0).round() / 100.0;
                format!("{r}")
            }
        }
        _ => "0".into(),
    }
}

fn indent(text: &str, pad: &str) -> String {
    text.lines().map(|l| format!("{pad}{l}")).collect::<Vec<_>>().join("\n")
}

fn element_text(e: &Value, pad: &str) -> String {
    let mut s = String::new();
    let kind = e["kind"].as_str().unwrap_or("");
    let _ = write!(s, "{pad}{} {}  x {} y {} w {} h {}", e["id"].as_str().unwrap_or(""), kind, num(&e["x"]), num(&e["y"]), num(&e["w"]), num(&e["h"]));
    if e["rotation"].as_f64().unwrap_or(0.0) != 0.0 {
        let _ = write!(s, "  rotation {}", num(&e["rotation"]));
    }
    if kind == "shape" {
        let _ = write!(s, "  shape {}", e["shape"].as_str().unwrap_or("rect"));
    }
    if let Some(p) = e["placeholder"].as_str() {
        let _ = write!(s, "  placeholder {p}");
    }
    if e["locked"].as_bool() == Some(true) {
        s.push_str("  locked");
    }
    if let Some(g) = e["group"].as_str() {
        let _ = write!(s, "  group {g}");
    }
    if let Some(l) = e["link"].as_str() {
        let _ = write!(s, "  link {l}");
    }
    if let Some(a) = e["animation"].as_object() {
        let _ = write!(
            s,
            "  animation {} on {} #{}",
            a.get("effect").and_then(Value::as_str).unwrap_or("?"),
            a.get("trigger").and_then(Value::as_str).unwrap_or("click"),
            a.get("order").map(num).unwrap_or_default()
        );
    }
    let inner = format!("{pad}    ");
    match kind {
        "text" | "shape" => {
            let t = rich_to_markdownish(&e["text"]);
            if !t.trim().is_empty() {
                let _ = write!(s, "\n{}", indent(&t, &inner));
            } else if kind == "text" {
                let _ = write!(s, "\n{inner}(empty)");
            }
        }
        "image" | "video" | "audio" => {
            let _ = write!(s, "\n{inner}src {}", e["src"].as_str().unwrap_or(""));
            if let Some(alt) = e["alt"].as_str().filter(|a| !a.is_empty()) {
                let _ = write!(s, "  alt \"{alt}\"");
            }
            if kind == "image" {
                let _ = write!(s, "  fit {}", e["fit"].as_str().unwrap_or("contain"));
            } else {
                for f in ["autoplay", "loop", "muted"] {
                    if e[f].as_bool() == Some(true) {
                        let _ = write!(s, "  {f}");
                    }
                }
            }
        }
        "table" => {
            let _ = write!(s, "  {}×{}{}", num(&e["rows"]), num(&e["cols"]), if e["headerRow"].as_bool() == Some(true) { "  header row" } else { "" });
            for row in e["cells"].as_array().into_iter().flatten() {
                let cells: Vec<String> = row
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| rich_to_markdownish(&c["text"]).replace('\n', " / "))
                    .collect();
                let _ = write!(s, "\n{inner}| {} |", cells.join(" | "));
            }
        }
        "chart" => {
            let c = &e["chart"];
            let _ = write!(s, "\n{inner}{} chart", c["type"].as_str().unwrap_or("bar"));
            if let Some(t) = c["title"].as_str() {
                let _ = write!(s, " \"{t}\"");
            }
            let labels: Vec<String> = c["labels"].as_array().into_iter().flatten().map(|l| l.as_str().map(String::from).unwrap_or_else(|| l.to_string())).collect();
            let _ = write!(s, "\n{inner}labels: {}", labels.join(", "));
            for series in c["series"].as_array().into_iter().flatten() {
                let values: Vec<String> = series["values"].as_array().into_iter().flatten().map(num).collect();
                let _ = write!(s, "\n{inner}{}: {}", series["name"].as_str().unwrap_or("series"), values.join(", "));
            }
        }
        "html" => {
            for f in ["html", "css", "js"] {
                let code = e[f].as_str().unwrap_or("");
                if !code.trim().is_empty() {
                    let _ = write!(s, "\n{inner}{f}:\n{}", indent(code, &format!("{inner}  ")));
                }
            }
        }
        _ => {}
    }
    s
}

fn anchor_label(t: &Value) -> String {
    let a = &t["anchor"];
    let on_el = |prefix: &str| match a["element"].as_str() {
        Some(e) => format!("{prefix} on {e}"),
        None => prefix.to_string(),
    };
    match a["kind"].as_str().unwrap_or("deck") {
        "deck" => "on the deck".into(),
        "slide" => "on the slide".into(),
        "point" => on_el(&format!("at ({}, {})", num(&a["x"]), num(&a["y"]))),
        "area" => on_el(&format!("on area ({}, {}) {}×{}", num(&a["x"]), num(&a["y"]), num(&a["w"]), num(&a["h"]))),
        "element" => format!("on {}", a["element"].as_str().unwrap_or("?")),
        "text" => format!(
            "on \"{}\" in {}{}",
            a["quote"].as_str().unwrap_or(""),
            a["element"].as_str().unwrap_or("?"),
            match a["field"].as_str() {
                Some(f) if f != "text" => format!(" {f}"),
                _ => String::new(),
            }
        ),
        other => format!("on {other}"),
    }
}

fn thread_text(t: &Value, pad: &str, show_snapshot: bool) -> String {
    let mut s = String::new();
    // Continuation lines line up under the first, whatever marker the first line starts with.
    let cont: String = pad.chars().map(|c| if c.is_whitespace() { c } else { ' ' }).collect();
    let mut label = anchor_label(t);
    if show_snapshot && let Some(l) = t["snapshot"]["label"].as_str() {
        label = format!("{label} (was: {l})");
    }
    let state = t["state"].as_str().unwrap_or("open");
    let _ = write!(s, "{pad}[{} {label}, {state}]", t["id"].as_str().unwrap_or(""));
    for (i, c) in t["comments"].as_array().into_iter().flatten().enumerate() {
        if c["deleted"].as_bool() == Some(true) || c["deletedAt"].is_string() {
            continue;
        }
        let who = c["author"]["id"].as_str().unwrap_or("someone");
        let body = c["body"].as_str().unwrap_or("").replace('\n', " ");
        let id = c["id"].as_str().unwrap_or("");
        if i == 0 {
            let _ = write!(s, " {who}: {body}  ({id})");
        } else {
            let _ = write!(s, "\n{cont}  ↳ {who}: {body}  ({id})");
        }
    }
    s
}

/// The deck as readable text. `threads` are comment threads as the service returns them; only open ones are shown,
/// each next to the slide it is on (threads on deleted slides are listed at the end with what they were on).
pub fn to_text(deck: &Value, threads: Option<&[Value]>) -> String {
    let mut s = String::new();
    let slides = deck["slides"].as_array().cloned().unwrap_or_default();
    let title = deck["title"].as_str().unwrap_or("Untitled deck");
    let _ = writeln!(s, "{title}");
    let mut meta = Vec::new();
    if let Some(id) = deck["id"].as_str() {
        meta.push(format!("deck {id}"));
    }
    if deck["version"].is_number() {
        meta.push(format!("version {}", num(&deck["version"])));
    }
    meta.push(format!("{} slide{}", slides.len(), if slides.len() == 1 { "" } else { "s" }));
    meta.push(format!("{}×{}", num(&deck["size"]["width"]), num(&deck["size"]["height"])));
    if let Some(t) = deck["theme"]["name"].as_str() {
        meta.push(format!("theme {t}"));
    }
    let _ = writeln!(s, "{}", meta.join(" · "));
    let open: Vec<&Value> = threads.unwrap_or(&[]).iter().filter(|t| t["state"].as_str().unwrap_or("open") == "open").collect();
    let on_slide = |id: &str| -> Vec<&Value> {
        open.iter().copied().filter(|t| t["anchor"]["slide"].as_str() == Some(id) && t["anchor"]["kind"].as_str() != Some("deck")).collect()
    };
    let deck_threads: Vec<&Value> = open.iter().copied().filter(|t| t["anchor"]["kind"].as_str().unwrap_or("deck") == "deck").collect();
    if !deck_threads.is_empty() {
        let _ = writeln!(s, "\nComments on the deck:");
        for t in deck_threads {
            let _ = writeln!(s, "{}", thread_text(t, "  ", false));
        }
    }
    let master = deck["master"]["elements"].as_array().cloned().unwrap_or_default();
    if !master.is_empty() {
        let _ = writeln!(s, "\n── Master (drawn under every slide that doesn't hide it)");
        for e in &master {
            let _ = writeln!(s, "{}", element_text(e, "  "));
        }
    }
    for (i, slide) in slides.iter().enumerate() {
        let id = slide["id"].as_str().unwrap_or("");
        let mut head = format!("\n── Slide {} · {} · layout {}", i + 1, id, slide["layout"].as_str().unwrap_or("blank"));
        if let Some(sec) = slide["section"].as_str() {
            head.push_str(&format!(" · section \"{sec}\""));
        }
        if slide["skipped"].as_bool() == Some(true) {
            head.push_str(" · skipped");
        }
        if slide["hideMaster"].as_bool() == Some(true) {
            head.push_str(" · hides master");
        }
        if let Some(bg) = slide["background"].as_object() {
            if let Some(c) = bg.get("color").and_then(Value::as_str) {
                head.push_str(&format!(" · background {c}"));
            } else if let Some(img) = bg.get("image").and_then(Value::as_str) {
                head.push_str(&format!(" · background {img}"));
            }
        }
        if let Some(tr) = slide["transition"].as_object() {
            head.push_str(&format!(" · transition {}", tr.get("type").and_then(Value::as_str).unwrap_or("?")));
        }
        let _ = writeln!(s, "{head}");
        let elements = slide["elements"].as_array().cloned().unwrap_or_default();
        if elements.is_empty() {
            let _ = writeln!(s, "  (no elements)");
        }
        let ts = on_slide(id);
        let on_element = |eid: &str| -> Vec<&Value> {
            ts.iter().copied().filter(|t| t["anchor"]["element"].as_str() == Some(eid) && t["anchor"]["field"].as_str() != Some("notes")).collect()
        };
        // Comments sit right under the element they are on.
        for e in &elements {
            let _ = writeln!(s, "{}", element_text(e, "  "));
            for t in on_element(e["id"].as_str().unwrap_or("")) {
                let _ = writeln!(s, "{}", thread_text(t, "      comment ", false));
            }
        }
        let notes = slide["notes"].as_str().unwrap_or("");
        if !notes.trim().is_empty() {
            let _ = writeln!(s, "  notes:\n{}", indent(notes.trim_end(), "    "));
        }
        let rest: Vec<&Value> = ts
            .iter()
            .copied()
            .filter(|t| match t["anchor"]["element"].as_str() {
                Some(eid) => t["anchor"]["field"].as_str() == Some("notes") || !elements.iter().any(|x| x["id"].as_str() == Some(eid)),
                None => true,
            })
            .collect();
        if !rest.is_empty() {
            let _ = writeln!(s, "  comments:");
            for t in rest {
                let gone = t["anchor"]["element"].as_str().is_some_and(|e| !elements.iter().any(|x| x["id"].as_str() == Some(e)));
                let _ = writeln!(s, "{}", thread_text(t, "    ", gone));
            }
        }
    }
    let ids: Vec<&str> = slides.iter().filter_map(|x| x["id"].as_str()).collect();
    let orphans: Vec<&Value> = open
        .iter()
        .copied()
        .filter(|t| t["anchor"]["slide"].as_str().is_some_and(|sid| sid != "master" && !ids.contains(&sid)))
        .collect();
    if !orphans.is_empty() {
        let _ = writeln!(s, "\n── Comments on deleted slides");
        for t in orphans {
            let _ = writeln!(s, "{}", thread_text(t, "  ", true));
        }
    }
    s
}
