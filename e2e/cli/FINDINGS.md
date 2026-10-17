# CLI end-to-end findings

From `e2e/cli/run.sh` against the real local Silicon Accounts stack (2026-10-17): 336 of 338 checks pass. Open items:

1. **Exporting one slide as an image returns a zip.** `GET /v1/decks/{id}/export?format=png&slide=<id>` answers a
   zip holding one `slide-01.png` instead of the PNG itself. `deck_json_for` in
   `crates/present-service/src/routes/files.rs` trims the deck to the slide but never passes `slide` to the converter,
   which only returns a single image when the request names one. Fix: send `"slide": q.slide` in the
   `converter.export` body. Repro: `present export <deck> --format png --slide 1 -o one.png; xxd -l 4 one.png` →
   `504b0304`.
2. **`present report` gets a 404.** The service has no `POST /v1/reports`. Decision: the service stores each report
   and mails it the way the other Silicon apps do (see the service's reports route once added).
3. **A panic seen once on an earlier service build.** Sharing with a Silicon dropped the connection, and the log
   showed `sqlx-postgres datetime.rs:60` "resulting value is out of range". Not seen in five runs since on newer
   builds; the suite now runs the service with `RUST_BACKTRACE=1`.

Operational notes:
- macOS kills a running process when its executable is rewritten, so a rebuild in the shared `target/` kills services
  running from it. The suite copies `present` and `present-service` into `.dev/cli/bin` and runs the copies.
- Stop lane processes by PID only; `pkill -f target/debug/present-service` matches every lane.
