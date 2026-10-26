# Local UTF-16 boundary patch

Source: yrs 0.28.0, upstream commit 23b7f5693bbf9e7d26340c521ee8647f79bdfba2.
The MIT license is included in LICENSE. Cargo's registry source is otherwise preserved.

`ItemContent::splice` now splits a UTF-16 surrogate pair into two replacement characters,
matching Yjs clock lengths, and increments a thread-local boundary counter. The service
trial-applies each update on a clone and rejects an update that increments that counter,
before writing history or changing the live room. This prevents yrs and Yjs from silently
reading different content. Ordinary whole-character edits do not increment it.

Regression: `cargo test -p present-service --test retry_unicode`.
Remove this patch once an upstream release provides equivalent boundary validation.
