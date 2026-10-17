//! Against the real converter (renderer/), opt in with PRESENT_LIVE_CONVERTER_URL and PRESENT_LIVE_CONVERTER_SECRET
//! (service-tests lane: http://127.0.0.1:4362). Exports, renders and imports go through the signed asset URLs.

mod common;

use std::sync::Arc;

use common::*;
use serde_json::{Value, json};

#[tokio::test]
async fn exports_renders_and_imports_through_the_real_converter() {
    let (Ok(url), Ok(secret)) = (std::env::var("PRESENT_LIVE_CONVERTER_URL"), std::env::var("PRESENT_LIVE_CONVERTER_SECRET")) else {
        eprintln!("skipped: set PRESENT_LIVE_CONVERTER_URL and PRESENT_LIVE_CONVERTER_SECRET to run against the real converter");
        return;
    };
    let converter = present_service::converter::HttpConverter { http: reqwest::Client::new(), url, secret };
    let s = Stack::start_full(true, true, Some(Arc::new(converter))).await;
    let ada = s.person("c:ada");
    let id = s.deck(&ada, "Converter check").await;
    // A real PNG asset (1×1) on the slide, plus text, a chart, a table and an HTML element.
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==").unwrap();
    let r = s.http.post(format!("{}/v1/decks/{id}/assets", s.url)).bearer_auth(&ada.token).header("Content-Type", "image/png").header("X-Filename", "dot.png").body(png).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 201);
    let asset: Value = r.json().await.unwrap();
    let c = s.content(&id, &ada).await;
    let slide = first_slide(&c);
    let el = c["slides"][0]["elements"][0]["id"].as_str().unwrap().to_string();
    let (st, r) = s.edits(&id, &ada, json!([
        { "op": "update_element", "slide": slide, "element": el, "set": { "text": "Quarterly numbers" } },
        { "op": "add_element", "slide": slide, "element": { "kind": "image", "src": asset["ref"], "x": 100, "y": 700, "w": 200, "h": 200 } },
        { "op": "add_slide", "slide": { "id": "s_second", "notes": "Second slide notes", "elements": [
            { "kind": "chart", "x": 100, "y": 100, "w": 800, "h": 500, "chart": { "type": "column", "title": "Revenue", "labels": ["Q1", "Q2"], "series": [ { "name": "2026", "values": [3, 5] } ] } },
            { "kind": "table", "x": 1000, "y": 100, "w": 800, "h": 200, "cells": [["Plan", "Price"], ["Pro", "$9"]] },
            { "kind": "html", "x": 100, "y": 700, "w": 600, "h": 300, "html": "<div id=a>live</div>", "css": "#a{font-size:60px}", "js": "document.getElementById('a').textContent='ran'" } ] } }
    ])).await;
    assert_eq!(st, 200, "{r}");
    let get = |path: String| s.http.get(format!("{}{path}", s.url)).bearer_auth(&ada.token).send();
    let r = get(format!("/v1/decks/{id}/slides/{slide}/render?width=640")).await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "{}", r.text().await.unwrap_or_default());
    let img = r.bytes().await.unwrap();
    assert_eq!(&img[..4], &[0x89, b'P', b'N', b'G']);
    for (format, magic) in [("pdf", b"%PDF".to_vec()), ("pptx", b"PK".to_vec()), ("html", b"<".to_vec())] {
        let r = get(format!("/v1/decks/{id}/export?format={format}")).await.unwrap();
        let status = r.status().as_u16();
        let body = r.bytes().await.unwrap();
        assert_eq!(status, 200, "{format}: {}", String::from_utf8_lossy(&body[..body.len().min(400)]));
        let start = String::from_utf8_lossy(&body[..20.min(body.len())]).trim_start().as_bytes().to_vec();
        assert!(start.starts_with(&magic), "{format} starts with {:?}", &body[..8.min(body.len())]);
    }
    // Open the pptx we just made as a new deck.
    let pptx = get(format!("/v1/decks/{id}/export?format=pptx")).await.unwrap().bytes().await.unwrap();
    let r = s.http.post(format!("{}/v1/imports", s.url)).bearer_auth(&ada.token)
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        .header("X-Filename", "round%20trip.pptx").body(pptx.to_vec()).send().await.unwrap();
    let status = r.status().as_u16();
    let d: Value = r.json().await.unwrap();
    assert_eq!(status, 201, "{d}");
    let imported = s.content(d["id"].as_str().unwrap(), &ada).await;
    assert_eq!(imported["slides"].as_array().unwrap().len(), 2, "{imported}");
    let text = present_deck::to_text(&imported, None);
    assert!(text.contains("Quarterly numbers"), "{text}");
    assert!(text.contains("Second slide notes"), "{text}");
    s.stop().await;
}
