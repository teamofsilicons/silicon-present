//! Emails Present sends itself: invites to addresses that have no Silicon Accounts account yet (Accounts doesn't
//! send app invites) and reports to the team. Through Postmark when `PRESENT_POSTMARK_TOKEN` is set, otherwise the
//! message is kept in `email_outbox` (state `not_configured`) and logged — that is what tests read. The key makes a
//! retried request queue each email once.

use serde_json::json;

use crate::state::AppState;

pub async fn queue_email(state: &AppState, key: &str, to: &str, subject: &str, body: &str) -> Result<(), sqlx::Error> {
    let configured = state.cfg.postmark_token.is_some();
    let inserted: Option<i64> = sqlx::query_scalar(
        "insert into email_outbox (idempotency_key, to_email, subject, body, state) values ($1, $2, $3, $4, $5)
         on conflict (idempotency_key) do nothing returning id",
    )
    .bind(key)
    .bind(to)
    .bind(subject)
    .bind(body)
    .bind(if configured { "pending" } else { "not_configured" })
    .fetch_optional(&state.pool)
    .await?;
    let Some(id) = inserted else { return Ok(()) };
    match &state.cfg.postmark_token {
        None => tracing::info!("email to {to} kept in email_outbox (no PRESENT_POSTMARK_TOKEN): {subject}"),
        Some(token) => {
            let st = state.clone();
            let (token, to, subject, body) = (token.clone(), to.to_string(), subject.to_string(), body.to_string());
            tokio::spawn(async move {
                let result = st
                    .http
                    .post("https://api.postmarkapp.com/email")
                    .header("X-Postmark-Server-Token", token)
                    .header("Accept", "application/json")
                    .json(&json!({ "From": st.cfg.mail_from, "To": to, "Subject": subject, "TextBody": body, "MessageStream": "outbound" }))
                    .send()
                    .await;
                let (state_name, error) = match result {
                    Ok(r) if r.status().is_success() => ("sent", None),
                    Ok(r) => ("failed", Some(format!("Postmark answered {}", r.status()))),
                    Err(e) => ("failed", Some(e.to_string())),
                };
                let _ = sqlx::query(
                    "update email_outbox set state = $2, last_error = $3, attempts = attempts + 1,
                       sent_at = case when $2 = 'sent' then now() else null end where id = $1",
                )
                .bind(id)
                .bind(state_name)
                .bind(error)
                .execute(&st.pool)
                .await;
            });
        }
    }
    Ok(())
}
