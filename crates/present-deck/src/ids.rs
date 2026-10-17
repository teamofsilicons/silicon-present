//! Slide and element ids: `s_` / `e_` + 6 base36 characters.

use rand::Rng;

const BASE36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

fn suffix() -> String {
    let mut rng = rand::rng();
    (0..6).map(|_| BASE36[rng.random_range(0..36)] as char).collect()
}

/// A new slide id, like `s_f3k9a2`.
pub fn slide_id() -> String {
    format!("s_{}", suffix())
}

/// A new element id, like `e_7q2m0z`.
pub fn element_id() -> String {
    format!("e_{}", suffix())
}
