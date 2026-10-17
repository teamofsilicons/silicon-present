//! Helpers for deck JSON (`docs/architecture.md`, "Deck JSON"): ids, rich text, finding slides
//! and elements, and building new elements.
//!
//! Deck content stays a [`serde_json::Value`] so nothing a newer service adds is ever lost on
//! the way through `present pull` / `present push`.

use rand::Rng as _;
use serde_json::{Map, Value, json};

/// Slide size when the deck does not say.
pub const DEFAULT_SIZE: (f64, f64) = (1920.0, 1080.0);

/// Every element kind.
pub const ELEMENT_KINDS: [&str; 8] = [
    "text", "shape", "image", "video", "audio", "table", "chart", "html",
];

/// Every layout.
pub const LAYOUTS: [&str; 7] = [
    "title",
    "title-body",
    "two-columns",
    "section",
    "title-only",
    "image-caption",
    "blank",
];

/// Every shape.
pub const SHAPES: [&str; 20] = [
    "rect",
    "round-rect",
    "ellipse",
    "triangle",
    "right-triangle",
    "diamond",
    "pentagon",
    "hexagon",
    "octagon",
    "star",
    "arrow-right",
    "arrow-left",
    "arrow-up",
    "arrow-down",
    "chevron",
    "line",
    "callout",
    "heart",
    "cloud",
    "plus",
];

fn base36(n: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    (0..n)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

/// A new slide id: `s_` + 6 base36 characters.
pub fn new_slide_id() -> String {
    format!("s_{}", base36(6))
}

/// A new element id: `e_` + 6 base36 characters.
pub fn new_element_id() -> String {
    format!("e_{}", base36(6))
}

/// True for a 12-character base58 id (decks, folders, threads, comments, assets, presentations).
pub fn is_resource_id(s: &str) -> bool {
    s.len() == 12
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'))
}

/// Rich text from plain text: one paragraph per line, one run each.
pub fn rich_text(plain: &str) -> Value {
    let paragraphs: Vec<Value> = plain
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                json!({ "runs": [] })
            } else {
                json!({ "runs": [ { "text": line } ] })
            }
        })
        .collect();
    json!({ "paragraphs": paragraphs })
}

/// Rich text from plain text with the same inline attributes on every run and paragraph
/// attributes on every paragraph.
pub fn rich_text_styled(plain: &str, inline: &Map<String, Value>, paragraph: &Map<String, Value>) -> Value {
    let paragraphs: Vec<Value> = plain
        .split('\n')
        .map(|line| {
            let mut p = paragraph.clone();
            let runs = if line.is_empty() {
                vec![]
            } else {
                let mut run = inline.clone();
                run.insert("text".into(), Value::String(line.to_owned()));
                vec![Value::Object(run)]
            };
            p.insert("runs".into(), Value::Array(runs));
            Value::Object(p)
        })
        .collect();
    json!({ "paragraphs": paragraphs })
}

/// The plain text of a rich text value (paragraphs joined by newlines). A plain string is
/// returned as it is.
pub fn plain_text(rich: &Value) -> String {
    match rich {
        Value::String(s) => s.clone(),
        Value::Object(o) => o
            .get("paragraphs")
            .and_then(Value::as_array)
            .map(|ps| {
                ps.iter()
                    .map(|p| {
                        p.get("runs")
                            .and_then(Value::as_array)
                            .map(|runs| {
                                runs.iter()
                                    .filter_map(|r| r.get("text").and_then(Value::as_str))
                                    .collect::<String>()
                            })
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// The slides of a deck.
pub fn slides(deck: &Value) -> &[Value] {
    deck.get("slides")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The elements of a slide (back to front).
pub fn elements(slide: &Value) -> &[Value] {
    slide
        .get("elements")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The deck's slide size.
pub fn size(deck: &Value) -> (f64, f64) {
    let s = deck.get("size");
    let w = s.and_then(|s| s.get("width")).and_then(Value::as_f64);
    let h = s.and_then(|s| s.get("height")).and_then(Value::as_f64);
    (w.unwrap_or(DEFAULT_SIZE.0), h.unwrap_or(DEFAULT_SIZE.1))
}

/// A string field of a JSON object.
pub fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Finds a slide by 1-based number, by id, or `master`. Returns its index (`None` for master)
/// and id.
pub fn find_slide(deck: &Value, selector: &str) -> Option<(Option<usize>, String)> {
    let sel = selector.trim();
    if sel == "master" {
        return Some((None, "master".into()));
    }
    let list = slides(deck);
    if let Ok(n) = sel.parse::<usize>() {
        return (n >= 1 && n <= list.len())
            .then(|| (Some(n - 1), str_field(&list[n - 1], "id").unwrap_or_default().to_owned()));
    }
    list.iter()
        .position(|s| str_field(s, "id") == Some(sel))
        .map(|i| (Some(i), sel.to_owned()))
}

/// The slide JSON for an id (or `master`, as `{ "id": "master", "elements": [...] }`).
pub fn slide_by_id<'a>(deck: &'a Value, id: &str) -> Option<&'a Value> {
    if id == "master" {
        return deck.get("master");
    }
    slides(deck).iter().find(|s| str_field(s, "id") == Some(id))
}

/// Finds an element on a slide by id, by 1-based z position (1 = back), or by `kind:n`
/// (`text:2` = the second text element from the back).
pub fn find_element<'a>(slide: &'a Value, selector: &str) -> Option<&'a Value> {
    let list = elements(slide);
    let sel = selector.trim();
    if let Ok(n) = sel.parse::<usize>() {
        return (n >= 1).then(|| list.get(n - 1)).flatten();
    }
    if let Some((kind, n)) = sel.split_once(':')
        && let Ok(n) = n.parse::<usize>()
    {
        return list
            .iter()
            .filter(|e| str_field(e, "kind") == Some(kind))
            .nth(n.checked_sub(1)?);
    }
    list.iter().find(|e| str_field(e, "id") == Some(sel))
}

/// A one-line description of a slide for listings: `3  s_abc123  title  "Q4 review"`.
pub fn slide_title(slide: &Value) -> String {
    elements(slide)
        .iter()
        .filter(|e| matches!(str_field(e, "kind"), Some("text" | "shape")))
        .map(|e| plain_text(e.get("text").unwrap_or(&Value::Null)))
        .find(|t| !t.trim().is_empty())
        .map(|t| t.lines().next().unwrap_or_default().chars().take(60).collect())
        .unwrap_or_default()
}

/// Geometry of a new element.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    /// Left, slide px.
    pub x: f64,
    /// Top, slide px.
    pub y: f64,
    /// Width, slide px.
    pub w: f64,
    /// Height, slide px.
    pub h: f64,
}

impl Frame {
    /// The frame as `x`, `y`, `w`, `h` fields.
    pub fn fields(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("x".into(), json!(self.x));
        m.insert("y".into(), json!(self.y));
        m.insert("w".into(), json!(self.w));
        m.insert("h".into(), json!(self.h));
        m
    }
}

/// A new element of `kind` with an id, the frame and the given fields.
pub fn element(kind: &str, frame: Frame, fields: Map<String, Value>) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(new_element_id()));
    m.insert("kind".into(), Value::String(kind.to_owned()));
    m.extend(frame.fields());
    m.insert("rotation".into(), json!(0));
    m.extend(fields);
    Value::Object(m)
}

/// An empty table's cells.
pub fn table_cells(rows: usize, cols: usize, data: &[Vec<String>]) -> Value {
    let cells: Vec<Value> = (0..rows)
        .map(|r| {
            Value::Array(
                (0..cols)
                    .map(|c| {
                        let text = data.get(r).and_then(|row| row.get(c)).map_or("", String::as_str);
                        json!({ "text": rich_text(text), "fill": null })
                    })
                    .collect(),
            )
        })
        .collect();
    Value::Array(cells)
}

/// The built-in themes, the same as the web editor's (`packages/deck/src/themes.ts`).
pub const THEMES: [(&str, &str, &str, [&str; 6]); 7] = [
    ("Paper", "Inter", "Inter", ["#ffffff", "#1b1b1f", "#2f5bea", "#e5484d", "#12a594", "#6f6f78"]),
    ("Ivory", "Fraunces", "Inter", ["#f8f5ee", "#211d17", "#b4532a", "#3b6e8f", "#7a8b3a", "#7d7468"]),
    ("Ink", "Space Grotesk", "Inter", ["#111214", "#f2f2f0", "#8ab4ff", "#ffb86b", "#7ee0b8", "#9a9ca3"]),
    ("Slate", "IBM Plex Sans", "IBM Plex Sans", ["#eef1f5", "#18202b", "#3a5a80", "#d08a2e", "#5f8f6e", "#66717f"]),
    ("Forest", "DM Serif Display", "DM Sans", ["#f3f5f0", "#1c2a22", "#2f6b4f", "#c2733d", "#8a9a3b", "#6b776f"]),
    ("Coral", "Manrope", "Manrope", ["#fff8f5", "#2a1d1a", "#e2614b", "#2d7f8f", "#f2a93b", "#8a7570"]),
    ("Mono", "JetBrains Mono", "Inter", ["#fafafa", "#111111", "#111111", "#7a7a7a", "#c0c0c0", "#7a7a7a"]),
];

/// A built-in theme by name (any case), as deck JSON.
pub fn theme(name: &str) -> Option<Value> {
    THEMES
        .iter()
        .find(|t| t.0.eq_ignore_ascii_case(name.trim()))
        .map(|(name, heading, body, c)| {
            json!({
                "name": name,
                "fonts": { "heading": heading, "body": body },
                "colors": { "background": c[0], "text": c[1], "accent": c[2], "accent2": c[3], "accent3": c[4], "muted": c[5] },
                "customFonts": []
            })
        })
}

/// What to put in a new slide's placeholders.
#[derive(Clone, Debug, Default)]
pub struct LayoutContent {
    /// Title text.
    pub title: Option<String>,
    /// Subtitle text (`title`, `section`).
    pub subtitle: Option<String>,
    /// Body text, one bullet per line (`title-body`; the left column of `two-columns`).
    pub body: Option<String>,
    /// Right column (`two-columns`).
    pub right: Option<String>,
    /// Caption (`image-caption`).
    pub caption: Option<String>,
    /// Image src (`image-caption`).
    pub image: Option<String>,
}

/// The placeholder elements of a new slide with this layout, the same as the web editor's
/// (`packages/deck/src/layouts.ts`). Unknown layouts are blank.
pub fn layout_elements(layout: &str, size: (f64, f64), accent: &str, c: &LayoutContent) -> Vec<Value> {
    let (sx, sy) = (size.0 / 1920.0, size.1 / 1080.0);
    let frame = |x: f64, y: f64, w: f64, h: f64| Frame {
        x: (x * sx).round(),
        y: (y * sy).round(),
        w: (w * sx).round(),
        h: (h * sy).round(),
    };
    let rich_p = |text: &Option<String>, para: Value| -> Value {
        let para = para.as_object().cloned().unwrap_or_default();
        match text {
            None => {
                let mut p = para.clone();
                p.insert("runs".into(), json!([]));
                json!({ "paragraphs": [Value::Object(p)] })
            }
            Some(t) => rich_text_styled(t, &Map::new(), &para),
        }
    };
    let text_box = |f: Frame, text: Value, valign: &str| {
        let mut m = Map::new();
        m.insert("text".into(), text);
        m.insert("style".into(), json!({ "verticalAlign": valign }));
        element("text", f, m)
    };
    let title_top = || frame(140.0, 80.0, 1640.0, 170.0);
    match layout {
        "title" => vec![
            text_box(frame(140.0, 300.0, 1640.0, 280.0), rich_p(&c.title, json!({"heading": 1})), "bottom"),
            text_box(frame(140.0, 610.0, 1640.0, 160.0), rich_p(&c.subtitle, json!({})), "top"),
        ],
        "title-body" => vec![
            text_box(title_top(), rich_p(&c.title, json!({"heading": 2})), "bottom"),
            text_box(frame(140.0, 290.0, 1640.0, 700.0), rich_p(&c.body, json!({"list": "bullet"})), "top"),
        ],
        "two-columns" => vec![
            text_box(title_top(), rich_p(&c.title, json!({"heading": 2})), "bottom"),
            text_box(frame(140.0, 290.0, 790.0, 700.0), rich_p(&c.body, json!({"list": "bullet"})), "top"),
            text_box(frame(990.0, 290.0, 790.0, 700.0), rich_p(&c.right, json!({"list": "bullet"})), "top"),
        ],
        "section" => {
            let mut bar = Map::new();
            bar.insert("shape".into(), json!("rect"));
            bar.insert("style".into(), json!({ "fill": accent }));
            bar.insert("text".into(), json!({ "paragraphs": [] }));
            vec![
                element("shape", frame(140.0, 400.0, 120.0, 10.0), bar),
                text_box(frame(140.0, 440.0, 1640.0, 220.0), rich_p(&c.title, json!({"heading": 1})), "top"),
                text_box(frame(140.0, 670.0, 1640.0, 120.0), rich_p(&c.subtitle, json!({})), "top"),
            ]
        }
        "title-only" => vec![text_box(title_top(), rich_p(&c.title, json!({"heading": 2})), "bottom")],
        "image-caption" => {
            let mut img = Map::new();
            img.insert("src".into(), json!(c.image.clone().unwrap_or_default()));
            img.insert("alt".into(), json!(""));
            img.insert("fit".into(), json!("contain"));
            vec![
                element("image", frame(140.0, 80.0, 1640.0, 780.0), img),
                text_box(frame(140.0, 890.0, 1640.0, 110.0), rich_p(&c.caption, json!({"align": "center"})), "top"),
            ]
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_the_documented_shape() {
        let s = new_slide_id();
        assert!(s.starts_with("s_") && s.len() == 8);
        let e = new_element_id();
        assert!(e.starts_with("e_") && e.len() == 8);
        assert!(is_resource_id("dk7Hq2mP9xRt"));
        assert!(!is_resource_id("s_abc123"));
    }

    #[test]
    fn rich_text_round_trips_plain_text() {
        let r = rich_text("Hello\n\nworld");
        assert_eq!(plain_text(&r), "Hello\n\nworld");
        assert_eq!(r["paragraphs"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn slides_and_elements_are_found_by_number_id_or_kind() {
        let deck = json!({"slides": [
            {"id": "s_aaaaaa", "elements": [{"id": "e_1", "kind": "shape"}, {"id": "e_2", "kind": "text", "text": rich_text("Hi")}]},
            {"id": "s_bbbbbb", "elements": []}
        ], "master": {"elements": []}});
        assert_eq!(find_slide(&deck, "2"), Some((Some(1), "s_bbbbbb".into())));
        assert_eq!(find_slide(&deck, "s_aaaaaa"), Some((Some(0), "s_aaaaaa".into())));
        assert_eq!(find_slide(&deck, "3"), None);
        assert_eq!(find_slide(&deck, "master"), Some((None, "master".into())));
        let s = &slides(&deck)[0];
        assert_eq!(find_element(s, "text:1").unwrap()["id"], "e_2");
        assert_eq!(find_element(s, "1").unwrap()["id"], "e_1");
        assert_eq!(find_element(s, "e_2").unwrap()["kind"], "text");
        assert_eq!(slide_title(s), "Hi");
    }
}
