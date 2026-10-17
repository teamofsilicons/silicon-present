//! Diff two decks (slides and elements added, removed, moved, changed, with field names) and say it in words.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

/// A slide by id and its 1-based number (in the newer deck, or the older one when removed).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideRef {
    pub id: String,
    pub number: usize,
    /// For moved slides: the number it had before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<usize>,
}

/// An element by id with its kind, and which fields changed (empty for added/removed).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementChange {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
}

/// What changed on one slide that exists in both decks (or the master).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideChange {
    pub id: String,
    pub number: usize,
    pub fields: Vec<String>,
    pub elements_added: Vec<ElementChange>,
    pub elements_removed: Vec<ElementChange>,
    pub elements_changed: Vec<ElementChange>,
    pub elements_reordered: bool,
}

/// Everything that differs between two decks.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDiff {
    pub deck_fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master: Option<SlideChange>,
    pub slides_added: Vec<SlideRef>,
    pub slides_removed: Vec<SlideRef>,
    pub slides_moved: Vec<SlideRef>,
    pub slides_changed: Vec<SlideChange>,
}

impl DeckDiff {
    /// True when the decks are the same.
    pub fn is_empty(&self) -> bool {
        self.deck_fields.is_empty()
            && self.master.is_none()
            && self.slides_added.is_empty()
            && self.slides_removed.is_empty()
            && self.slides_moved.is_empty()
            && self.slides_changed.is_empty()
    }

    /// Ids of every slide this diff touches (`master` included), for the live `touched` list.
    pub fn touched(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut push = |id: &str| {
            if !out.iter().any(|x| x == id) {
                out.push(id.to_string());
            }
        };
        if self.master.is_some() {
            push("master");
        }
        for s in &self.slides_added {
            push(&s.id);
        }
        for s in &self.slides_removed {
            push(&s.id);
        }
        for s in &self.slides_moved {
            push(&s.id);
        }
        for s in &self.slides_changed {
            push(&s.id);
        }
        out
    }
}

fn slides(deck: &Value) -> Vec<&Value> {
    deck["slides"].as_array().map(|a| a.iter().collect()).unwrap_or_default()
}

fn id_of(v: &Value) -> String {
    v["id"].as_str().unwrap_or_default().to_string()
}

/// The difference from deck `a` (older) to deck `b` (newer). Both are deck JSON.
pub fn diff(a: &Value, b: &Value) -> DeckDiff {
    let mut d = DeckDiff::default();
    for key in ["size", "theme"] {
        if a.get(key) != b.get(key) {
            d.deck_fields.push(key.to_string());
        }
    }
    let empty = serde_json::json!({ "elements": [] });
    let ma = a.get("master").unwrap_or(&empty);
    let mb = b.get("master").unwrap_or(&empty);
    if let Some(c) = slide_change("master", 0, ma, mb) {
        d.master = Some(c);
    }
    let sa = slides(a);
    let sb = slides(b);
    let index_a: HashMap<String, (usize, &Value)> = sa.iter().enumerate().map(|(i, s)| (id_of(s), (i + 1, *s))).collect();
    let index_b: HashMap<String, (usize, &Value)> = sb.iter().enumerate().map(|(i, s)| (id_of(s), (i + 1, *s))).collect();
    for (i, s) in sb.iter().enumerate() {
        let id = id_of(s);
        match index_a.get(&id) {
            None => d.slides_added.push(SlideRef { id, number: i + 1, from: None }),
            Some((_, old)) => {
                if let Some(c) = slide_change(&id, i + 1, old, s) {
                    d.slides_changed.push(c);
                }
            }
        }
    }
    for (i, s) in sa.iter().enumerate() {
        let id = id_of(s);
        if !index_b.contains_key(&id) {
            d.slides_removed.push(SlideRef { id, number: i + 1, from: None });
        }
    }
    let common_a: Vec<String> = sa.iter().map(|s| id_of(s)).filter(|id| index_b.contains_key(id)).collect();
    let common_b: Vec<String> = sb.iter().map(|s| id_of(s)).filter(|id| index_a.contains_key(id)).collect();
    if common_a != common_b {
        let keep = lcs(&common_a, &common_b);
        for id in &common_b {
            if !keep.contains(id) {
                d.slides_moved.push(SlideRef { id: id.clone(), number: index_b[id].0, from: Some(index_a[id].0) });
            }
        }
    }
    d
}

fn slide_change(id: &str, number: usize, a: &Value, b: &Value) -> Option<SlideChange> {
    let mut fields = Vec::new();
    let keys: HashSet<&String> = a.as_object().into_iter().flatten().chain(b.as_object().into_iter().flatten()).map(|(k, _)| k).collect();
    let mut keys: Vec<&String> = keys.into_iter().filter(|k| k.as_str() != "elements" && k.as_str() != "id").collect();
    keys.sort();
    for k in keys {
        if a.get(k) != b.get(k) {
            fields.push(k.clone());
        }
    }
    let ea: Vec<&Value> = a["elements"].as_array().map(|x| x.iter().collect()).unwrap_or_default();
    let eb: Vec<&Value> = b["elements"].as_array().map(|x| x.iter().collect()).unwrap_or_default();
    let ia: HashMap<String, &Value> = ea.iter().map(|e| (id_of(e), *e)).collect();
    let ib: HashMap<String, &Value> = eb.iter().map(|e| (id_of(e), *e)).collect();
    let kind = |e: &Value| e["kind"].as_str().unwrap_or_default().to_string();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for e in &eb {
        let eid = id_of(e);
        match ia.get(&eid) {
            None => added.push(ElementChange { id: eid, kind: kind(e), fields: vec![] }),
            Some(old) => {
                let keys: HashSet<&String> =
                    old.as_object().into_iter().flatten().chain(e.as_object().into_iter().flatten()).map(|(k, _)| k).collect();
                let mut keys: Vec<&String> = keys.into_iter().collect();
                keys.sort();
                let f: Vec<String> = keys.into_iter().filter(|k| old.get(*k) != e.get(*k)).cloned().collect();
                if !f.is_empty() {
                    changed.push(ElementChange { id: eid, kind: kind(e), fields: f });
                }
            }
        }
    }
    let removed: Vec<ElementChange> =
        ea.iter().filter(|e| !ib.contains_key(&id_of(e))).map(|e| ElementChange { id: id_of(e), kind: kind(e), fields: vec![] }).collect();
    let ca: Vec<String> = ea.iter().map(|e| id_of(e)).filter(|i| ib.contains_key(i)).collect();
    let cb: Vec<String> = eb.iter().map(|e| id_of(e)).filter(|i| ia.contains_key(i)).collect();
    let reordered = ca != cb;
    if fields.is_empty() && added.is_empty() && removed.is_empty() && changed.is_empty() && !reordered {
        return None;
    }
    Some(SlideChange {
        id: id.to_string(),
        number,
        fields,
        elements_added: added,
        elements_removed: removed,
        elements_changed: changed,
        elements_reordered: reordered,
    })
}

fn lcs(a: &[String], b: &[String]) -> HashSet<String> {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] { dp[i + 1][j + 1] + 1 } else { dp[i + 1][j].max(dp[i][j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = HashSet::new();
    while i < n && j < m {
        if a[i] == b[j] {
            out.insert(a[i].clone());
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

fn join(parts: &[String]) -> String {
    match parts.len() {
        0 => String::new(),
        1 => parts[0].clone(),
        n => format!("{} and {}", parts[..n - 1].join(", "), parts[n - 1]),
    }
}

fn numbers(nums: &[usize]) -> String {
    join(&nums.iter().map(|n| n.to_string()).collect::<Vec<_>>())
}

/// The diff in words, e.g. "changed slide 4", "added 2 slides and changed the theme", "rebuilt slide 4".
pub fn summarize(d: &DeckDiff) -> String {
    let mut parts: Vec<String> = Vec::new();
    match d.slides_added.len() {
        0 => {}
        1 => parts.push(format!("added slide {}", d.slides_added[0].number)),
        n => parts.push(format!("added {n} slides")),
    }
    match d.slides_removed.len() {
        0 => {}
        1 => parts.push(format!("removed slide {}", d.slides_removed[0].number)),
        n => parts.push(format!("removed {n} slides")),
    }
    let (rebuilt, changed): (Vec<&SlideChange>, Vec<&SlideChange>) = d
        .slides_changed
        .iter()
        .partition(|c| c.elements_added.len() >= 2 && c.elements_removed.len() >= 2 && c.elements_changed.is_empty());
    match rebuilt.len() {
        0 => {}
        1 => parts.push(format!("rebuilt slide {}", rebuilt[0].number)),
        n if n <= 3 => parts.push(format!("rebuilt slides {}", numbers(&rebuilt.iter().map(|c| c.number).collect::<Vec<_>>()))),
        n => parts.push(format!("rebuilt {n} slides")),
    }
    match changed.len() {
        0 => {}
        1 => parts.push(format!("changed slide {}", changed[0].number)),
        n if n <= 3 => parts.push(format!("changed slides {}", numbers(&changed.iter().map(|c| c.number).collect::<Vec<_>>()))),
        n => parts.push(format!("changed {n} slides")),
    }
    match d.slides_moved.len() {
        0 => {}
        1 => parts.push(format!("moved slide {} to {}", d.slides_moved[0].from.unwrap_or(0), d.slides_moved[0].number)),
        _ => parts.push("reordered slides".to_string()),
    }
    if d.master.is_some() {
        parts.push("changed the master".to_string());
    }
    if d.deck_fields.iter().any(|f| f == "theme") {
        parts.push("changed the theme".to_string());
    }
    if d.deck_fields.iter().any(|f| f == "size") {
        parts.push("changed the slide size".to_string());
    }
    if parts.is_empty() {
        return "made no visible changes".to_string();
    }
    join(&parts)
}
