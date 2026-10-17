//! Deck, folder, thread, comment, presentation, asset and transfer ids: 12 random base58 characters.

use rand::Rng;

const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn new_id() -> String {
    let mut rng = rand::rng();
    (0..12).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
}

/// True when `s` looks like one of our ids (cheap check before touching the database).
pub fn looks_like_id(s: &str) -> bool {
    s.len() == 12 && s.bytes().all(|b| ALPHABET.contains(&b))
}
