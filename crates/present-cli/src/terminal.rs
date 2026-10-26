//! Keep remote text from being interpreted as terminal commands or invisible direction changes.
pub fn safe(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if (c.is_control() && c != '\n' && c != '\t')
            || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            out.extend(c.escape_unicode());
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::safe;
    #[test]
    fn terminal_commands_are_printed_as_text() {
        assert_eq!(safe("\x1b]52;c;secret\x07\rOK\u{009b}2J"), "\\u{1b}]52;c;secret\\u{7}\\u{d}OK\\u{9b}2J");
        assert_eq!(safe("你好 😀\n\tDone"), "你好 😀\n\tDone");
    }
}
