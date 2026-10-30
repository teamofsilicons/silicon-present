//! Custom themes: saving a deck's theme to your account, using it in another deck (uploaded fonts copied along),
//! editors adding a shared deck's theme, and who can't.

mod common;

use common::*;
use serde_json::{Value, json};

const FONT: &[u8] = b"wOF2-not-really-a-font-but-bytes-are-bytes";

async fn upload_font(s: &Stack, deck: &str, who: &Person) -> String {
    let r = s.http.post(format!("{}/v1/decks/{deck}/assets", s.url)).bearer_auth(&who.token).header("Content-Type", "font/woff2").header("X-Filename", "brand.woff2").body(FONT.to_vec()).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 201);
    r.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string()
}

fn brand_theme(asset: &str) -> Value {
    json!({
        "name": "Ivory",
        "fonts": { "heading": "Brand", "body": "Inter" },
        "colors": { "background": "#101820", "text": "#f2f2f2", "accent": "#fee715", "accent2": "#e5484d", "accent3": "#12a594", "muted": "#888888" },
        "customFonts": [{ "family": "Brand", "src": format!("asset:{asset}") }]
    })
}

async fn set_theme(s: &Stack, deck: &str, who: &Person, theme: Value) {
    let (st, v) = s.edits(deck, who, json!([{ "op": "update_deck", "set": { "theme": theme } }])).await;
    assert_eq!(st, 200, "{v}");
}

fn code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap_or("")
}

#[tokio::test]
async fn save_a_deck_theme_and_use_it_in_another_deck() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let first = s.deck(&ada, "Launch").await;
    let asset = upload_font(&s, &first, &ada).await;
    set_theme(&s, &first, &ada, brand_theme(&asset)).await;

    // The deck's theme name is a built-in's, so it needs a name of its own.
    let (st, v) = s.post("/v1/themes", &ada, json!({ "deck": first })).await;
    assert_eq!((st, code(&v)), (400, "theme_name_builtin"));
    let (st, saved) = s.post("/v1/themes", &ada, json!({ "deck": first, "name": "  Brand  " })).await;
    assert_eq!(st, 201, "{saved}");
    assert_eq!(saved["name"], "Brand");
    assert_eq!(saved["colors"]["accent"], "#fee715");
    assert_eq!(saved["fonts"]["heading"], "Brand");
    let src = saved["customFonts"][0]["src"].as_str().unwrap();
    assert!(src.starts_with("theme-font:"), "{src}");
    let tid = saved["id"].as_str().unwrap().to_string();

    // Names are unique per account, ignoring case.
    let (st, v) = s.post("/v1/themes", &ada, json!({ "deck": first, "name": "brand" })).await;
    assert_eq!((st, code(&v)), (409, "theme_name_taken"));

    let (st, list) = s.get("/v1/themes", Some(&ada)).await;
    assert_eq!(st, 200);
    assert_eq!(list["themes"].as_array().unwrap().len(), 1);

    // Using it in another deck copies the font into that deck and returns a theme ready to set.
    let second = s.deck(&ada, "Follow-up").await;
    let (st, used) = s.post(&format!("/v1/themes/{tid}/use"), &ada, json!({ "deck": second })).await;
    assert_eq!(st, 200, "{used}");
    let theme = used["theme"].clone();
    assert_eq!(theme["name"], "Brand");
    let new_src = theme["customFonts"][0]["src"].as_str().unwrap().to_string();
    let new_asset = new_src.strip_prefix("asset:").unwrap().to_string();
    assert_ne!(new_asset, asset);
    let owner_deck: String = sqlx::query_scalar("select deck from assets where id = $1").bind(&new_asset).fetch_one(&s.pool).await.unwrap();
    assert_eq!(owner_deck, second);
    let r = s.http.get(format!("{}/v1/assets/{new_asset}", s.url)).bearer_auth(&ada.token).send().await.unwrap();
    assert_eq!(r.bytes().await.unwrap().as_ref(), FONT);
    set_theme(&s, &second, &ada, theme).await;
    assert_eq!(s.content(&second, &ada).await["theme"]["colors"]["accent"], "#fee715");

    // Using it again reuses the copy already in the deck.
    let (_, again) = s.post(&format!("/v1/themes/{tid}/use"), &ada, json!({ "deck": second })).await;
    assert_eq!(again["theme"]["customFonts"][0]["src"].as_str().unwrap(), new_src);

    // Rename and recolour; delete.
    let (st, v) = s.req("PATCH", &format!("/v1/themes/{tid}"), Some(&ada), Some(json!({ "name": "Brand 2", "colors": { "accent": "#00ff00" } }))).await;
    assert_eq!(st, 200, "{v}");
    assert_eq!((v["name"].as_str().unwrap(), v["colors"]["accent"].as_str().unwrap(), v["colors"]["text"].as_str().unwrap()), ("Brand 2", "#00ff00", "#f2f2f2"));
    let (st, v) = s.req("PATCH", &format!("/v1/themes/{tid}"), Some(&ada), Some(json!({ "colors": { "sparkle": "#fff" } }))).await;
    assert_eq!((st, code(&v)), (400, "invalid_theme"));
    let (st, _) = s.req("DELETE", &format!("/v1/themes/{tid}"), Some(&ada), None).await;
    assert_eq!(st, 204);
    let (st, v) = s.get(&format!("/v1/themes/{tid}"), Some(&ada)).await;
    assert_eq!((st, code(&v)), (404, "theme_not_found"));
    s.stop().await;
}

#[tokio::test]
async fn editors_can_add_a_shared_decks_theme_and_others_cannot() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let ed = s.person("c:ed");
    let cam = s.person("c:cam");
    let deck = s.deck(&ada, "Shared").await;
    let asset = upload_font(&s, &deck, &ada).await;
    set_theme(&s, &deck, &ada, brand_theme(&asset)).await;
    s.share("decks", &deck, &ada, "c:ed", "editor").await;
    s.share("decks", &deck, &ada, "c:cam", "commenter").await;

    // A commenter can't take the theme.
    let (st, v) = s.post("/v1/themes", &cam, json!({ "deck": deck, "name": "Theirs" })).await;
    assert_eq!((st, code(&v)), (403, "edit_not_allowed"));

    // An editor gets their own copy, fonts included; it outlives the deck's theme changing.
    let (st, mine) = s.post("/v1/themes", &ed, json!({ "deck": deck, "name": "Ada's brand" })).await;
    assert_eq!(st, 201, "{mine}");
    let tid = mine["id"].as_str().unwrap().to_string();
    set_theme(&s, &deck, &ada, json!({ "name": "Paper", "fonts": { "heading": "Inter", "body": "Inter" }, "colors": {}, "customFonts": [] })).await;
    let ed_deck = s.deck(&ed, "Ed's own").await;
    let (st, used) = s.post(&format!("/v1/themes/{tid}/use"), &ed, json!({ "deck": ed_deck })).await;
    assert_eq!(st, 200, "{used}");
    assert_eq!(used["theme"]["colors"]["accent"], "#fee715");
    assert!(used["theme"]["customFonts"][0]["src"].as_str().unwrap().starts_with("asset:"));

    // Ada's list doesn't show Ed's theme, and nobody else can read, use, change or delete it.
    let (_, list) = s.get("/v1/themes", Some(&ada)).await;
    assert!(list["themes"].as_array().unwrap().is_empty());
    let (st, v) = s.get(&format!("/v1/themes/{tid}"), Some(&ada)).await;
    assert_eq!((st, code(&v)), (404, "theme_not_found"));
    let (st, _) = s.post(&format!("/v1/themes/{tid}/use"), &ada, json!({ "deck": deck })).await;
    assert_eq!(st, 404);
    assert_eq!(s.req("PATCH", &format!("/v1/themes/{tid}"), Some(&ada), Some(json!({ "name": "Mine now" }))).await.0, 404);
    assert_eq!(s.req("DELETE", &format!("/v1/themes/{tid}"), Some(&ada), None).await.0, 404);

    // Using your theme needs editor access to the target deck.
    let (st, v) = s.post(&format!("/v1/themes/{tid}/use"), &ed, json!({ "deck": deck })).await;
    assert_eq!(st, 200, "{v}");
    s.share("decks", &deck, &ada, "c:ed", "commenter").await;
    let (st, v) = s.post(&format!("/v1/themes/{tid}/use"), &ed, json!({ "deck": deck })).await;
    assert_eq!((st, code(&v)), (403, "edit_not_allowed"));
    // Signed out: nothing.
    assert_eq!(s.get("/v1/themes", None).await.0, 401);
    s.stop().await;
}

#[tokio::test]
async fn themes_from_json_take_only_web_fonts() {
    let s = Stack::start().await;
    let ada = s.person("c:ada");
    let base = json!({ "fonts": { "heading": "Fraunces", "body": "Inter" }, "colors": { "accent": "#b4532a" } });
    let (st, v) = s.post("/v1/themes", &ada, json!({ "name": "Warm", "theme": base })).await;
    assert_eq!(st, 201, "{v}");
    assert_eq!(v["colors"]["background"], "#ffffff", "missing colours come from the default");
    let mut with_asset = base.clone();
    with_asset["customFonts"] = json!([{ "family": "X", "src": "asset:AAAAAAAAAAAA" }]);
    let (st, v) = s.post("/v1/themes", &ada, json!({ "name": "Other", "theme": with_asset })).await;
    assert_eq!((st, code(&v)), (400, "invalid_custom_font"));
    let (st, v) = s.post("/v1/themes", &ada, json!({ "name": "Both", "theme": base, "deck": "AAAAAAAAAAAA" })).await;
    assert_eq!((st, code(&v)), (400, "theme_source_required"));
    let (st, v) = s.post("/v1/themes", &ada, json!({ "name": "mono", "theme": base })).await;
    assert_eq!((st, code(&v)), (400, "theme_name_builtin"));
    s.stop().await;
}
