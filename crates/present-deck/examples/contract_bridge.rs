//! JSON-lines bridge for the cross-language conformance gate; never writes fixture files.
use std::io::{self, Read};
use base64::{Engine, engine::general_purpose::STANDARD};
use present_deck::*;
use serde_json::{Value, json};
fn main() {
    let mut source=String::new();io::stdin().read_to_string(&mut source).unwrap();
    let requests:Vec<Value>=serde_json::from_str(&source).unwrap();
    let result:Vec<Value>=requests.iter().map(|case| {
        let result:Result<yrs::Doc,DeckError>=(|| {
            if let Some(update)=case.get("decode") { return decode_doc(&STANDARD.decode(update.as_str().unwrap()).unwrap()); }
            if let Some(input)=case.get("input") { return json_to_doc(input); }
            let doc=json_to_doc(&case["start"])?;
            let before=encode_doc(&doc);
            let result=parse_ops(&case["ops"]).and_then(|ops|apply_ops(&doc,&ops));
            if let Err(e)=result { assert_eq!(encode_doc(&doc),before,"failed op mutated document: {}",case["name"]);return Err(e); }
            Ok(doc)
        })();
        match result {
            Ok(doc)=>json!({"json":doc_to_json(&doc),"update":STANDARD.encode(encode_doc(&doc))}),
            Err(e)=>{assert!(!e.message.is_empty()&&!e.hint.is_empty());json!({"error":e.code})}
        }
    }).collect();
    println!("{}",serde_json::to_string(&result).unwrap());
}
