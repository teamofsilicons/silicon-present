# Errors

Every failure says what happened, why, and what to do:

    error[text_not_found]: No passage "Helo" in e_ab12cd on slide 2. (HTTP 409)
      hint: The closest match is "Hello".

With `--json` it is one object on stderr: `{"error": {"code", "message", "hint", "status",
"request_id", "details"}}`. The exit status is 1 (2 for a mistyped command line).

Common codes:

- `not_signed_in`, `sign_in_ended`, `sign_in_required`: sign in again (`present docs sign-in`).
- `slt_already_used`, `slt_expired`, `slt_wrong_app`, `slt_unknown`: mint a fresh token with
  `silicon-accounts login --app present -q`.
- `deck_not_found`, `slide_not_found`, `element_not_found`: the id is wrong, or you can't see it.
  The message lists what exists.
- `forbidden` and role codes: your role doesn't allow it (viewers only view; commenters comment).
- `text_not_found`, `text_ambiguous`: `present replace` needs an exact passage; see the hint.
- `local_changes`, `not_a_pulled_folder`, `invalid_json`, `invalid_slide`: working in a folder.
- `connection_failed`, `request_timeout`: the service could not be reached; check `--api-url`.

Found a bug? `present report "steps, expected, actual" [--pr <link>]`. Quote the request id.
