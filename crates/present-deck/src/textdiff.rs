//! The bounded, deterministic code-point LCS shared with the TypeScript model.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Equal,
    Delete,
    Insert,
}
pub(crate) fn diff(old: &str, new: &str) -> Vec<(Kind, String)> {
    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();
    let mut prefix = 0;
    while prefix < a.len().min(b.len()) && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len().min(b.len()) - prefix
        && a[a.len() - suffix - 1] == b[b.len() - suffix - 1]
    {
        suffix += 1;
    }
    let mut out = Vec::new();
    fn push(out: &mut Vec<(Kind, String)>, k: Kind, chars: impl IntoIterator<Item = char>) {
        let s: String = chars.into_iter().collect();
        if s.is_empty() {
            return;
        }
        if let Some((last, text)) = out.last_mut() {
            if *last == k {
                text.push_str(&s);
                return;
            }
        }
        out.push((k, s));
    }
    push(&mut out, Kind::Equal, a[..prefix].iter().copied());
    let a = &a[prefix..a.len() - suffix];
    let mid = &b[prefix..b.len() - suffix];
    let (n, m) = (a.len(), mid.len());
    if n > 2000 || m > 2000 {
        push(&mut out, Kind::Delete, a.iter().copied());
        push(&mut out, Kind::Insert, mid.iter().copied());
    } else {
        let mut dp = vec![vec![0u16; m + 1]; n + 1];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                dp[i][j] = if a[i] == mid[j] {
                    dp[i + 1][j + 1] + 1
                } else {
                    dp[i + 1][j].max(dp[i][j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && a[i] == mid[j] {
                push(&mut out, Kind::Equal, [a[i]]);
                i += 1;
                j += 1;
            } else if i < n && (j == m || dp[i + 1][j] >= dp[i][j + 1]) {
                push(&mut out, Kind::Delete, [a[i]]);
                i += 1;
            } else {
                push(&mut out, Kind::Insert, [mid[j]]);
                j += 1;
            }
        }
    }
    push(&mut out, Kind::Equal, b[b.len() - suffix..].iter().copied());
    out
}

/// Match original UTF-8 byte ranges using context-free Unicode lowercase code points.
pub(crate) fn matches(text: &str, find: &str, match_case: bool) -> Vec<(usize, usize)> {
    if find.is_empty() {
        return vec![];
    }
    if match_case {
        return text
            .match_indices(find)
            .map(|(at, s)| (at, at + s.len()))
            .collect();
    }
    let mut folded = String::new();
    let mut boundaries = std::collections::BTreeMap::new();
    for (byte, ch) in text.char_indices() {
        boundaries.insert(folded.len(), byte);
        folded.extend(ch.to_lowercase());
    }
    boundaries.insert(folded.len(), text.len());
    let needle: String = find.chars().flat_map(char::to_lowercase).collect();
    let mut from = 0;
    let mut out = Vec::new();
    while from <= folded.len() {
        let Some(relative) = folded[from..].find(&needle) else {
            break;
        };
        let start = from + relative;
        let end = start + needle.len();
        if let (Some(a), Some(b)) = (boundaries.get(&start), boundaries.get(&end)) {
            out.push((*a, *b));
            from = end;
        } else {
            from = start + folded[start..].chars().next().unwrap().len_utf8();
        }
    }
    out
}
