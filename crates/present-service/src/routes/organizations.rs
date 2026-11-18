//! Group keys come only from Organizations' live, app-specific view of the exact signed-in account.
use super::sharing;
use crate::{
    access::Need,
    auth::Caller,
    error::{ApiError, ApiResult},
    extract::JsonBody,
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, Method},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::sync::OnceCell;
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
pub struct Target {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    name: String,
    org_id: String,
}
impl Target {
    fn key(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Context {
    account_uuid: Uuid,
    organizations: Vec<Value>,
    groups: Vec<String>,
    share_targets: Vec<Target>,
}

struct Authority {
    caller: Caller,
    context: OnceCell<Context>,
}
tokio::task_local! { static AUTHORITY: Arc<Authority>; }

pub async fn scope<T>(caller: Option<Caller>, f: impl Future<Output = T>) -> T {
    match caller {
        Some(caller) => {
            AUTHORITY
                .scope(
                    Arc::new(Authority {
                        caller,
                        context: OnceCell::new(),
                    }),
                    f,
                )
                .await
        }
        None => f.await,
    }
}

fn unavailable() -> ApiError {
    ApiError::unavailable(
        "organizations_unavailable",
        "Silicon Organizations could not verify organization access.",
        "Retry shortly.",
    )
}
async fn request(
    st: &AppState,
    c: &Caller,
    method: Method,
    path: &[&str],
    body: Option<&Value>,
    key: Option<&str>,
) -> ApiResult<Value> {
    let mut url = st.cfg.organizations_url.clone();
    url.path_segments_mut()
        .map_err(|_| unavailable())?
        .extend(["v1", "integrations", &st.cfg.app_id])
        .extend(path);
    let mut req = st
        .http
        .request(method, url)
        .timeout(Duration::from_secs(12))
        .bearer_auth(c.token.expose());
    if let Some(b) = body {
        req = req.json(b);
    }
    if let Some(k) = key {
        req = req.header("idempotency-key", k);
    }
    let mut resp = req.send().await.map_err(|_| unavailable())?;
    let status = resp.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if !status.is_success() {
        if status.is_client_error() {
            return Err(ApiError::new(
                status,
                v["error"]["code"]
                    .as_str()
                    .unwrap_or("organization_access_denied"),
                v["error"]["message"]
                    .as_str()
                    .unwrap_or("Organizations declined the request."),
                "Check the selected work account and its permissions.",
            ));
        }
        return Err(unavailable());
    }
    Ok(v)
}
async fn context(st: &AppState, c: &Caller) -> ApiResult<Context> {
    let authority = AUTHORITY.try_with(Arc::clone).map_err(|_| unavailable())?;
    if authority.caller.uuid != c.uuid {
        return Err(unavailable());
    }
    let ctx = authority
        .context
        .get_or_try_init(|| async {
            let ctx: Context =
                serde_json::from_value(request(st, c, Method::GET, &["me"], None, None).await?)
                    .map_err(|_| unavailable())?;
            if ctx.account_uuid != c.uuid
                || ctx.groups.iter().any(|k| {
                    k.len() > 200 || !(k.starts_with("team:") || k.starts_with("organization:"))
                })
            {
                return Err(unavailable());
            }
            Ok(ctx)
        })
        .await?;
    Ok(ctx.clone())
}

pub async fn check_work(st: &AppState, c: &Caller) -> ApiResult<()> {
    if c.handle.as_deref().is_some_and(|h| h.contains('.'))
        && context(st, c).await?.organizations.is_empty()
    {
        return Err(ApiError::forbidden(
            "organization_access_denied",
            "This work account cannot use Present.",
            "Ask an organization admin to check Present access.",
        ));
    }
    Ok(())
}
pub async fn groups(st: &AppState, uuid: Uuid) -> ApiResult<Vec<String>> {
    let Some(caller) = AUTHORITY
        .try_with(|a| a.caller.clone())
        .ok()
        .filter(|c| c.uuid == uuid)
    else {
        return Ok(vec![]);
    };
    if !sqlx::query_scalar::<_, bool>("select exists(select 1 from group_access)")
        .fetch_one(&st.pool)
        .await?
    {
        return Ok(vec![]);
    }
    Ok(context(st, &caller).await?.groups)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/organizations", get(list))
        .route("/v1/organizations/{org}", get(detail))
        .route(
            "/v1/organizations/{org}/actions",
            axum::routing::post(action),
        )
        .route(
            "/v1/decks/{id}/groups",
            get(deck_groups).put(set_deck_group),
        )
        .route(
            "/v1/folders/{id}/groups",
            get(folder_groups).put(set_folder_group),
        )
}
async fn list(State(st): State<AppState>, c: Caller) -> ApiResult<Json<Context>> {
    Ok(Json(context(&st, &c).await?))
}
async fn detail(
    State(st): State<AppState>,
    c: Caller,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        request(&st, &c, Method::GET, &["orgs", &id], None, None).await?,
    ))
}
async fn action(
    State(st): State<AppState>,
    c: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    JsonBody(b): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 200)
        .ok_or_else(|| {
            ApiError::bad_request(
                "idempotency_key_required",
                "Organization changes need an Idempotency-Key.",
                "Use one UUID for this operation and its retries.",
            )
        })?;
    Ok(Json(
        request(
            &st,
            &c,
            Method::POST,
            &["orgs", &id, "actions"],
            Some(&b),
            Some(key),
        )
        .await?,
    ))
}
#[derive(Deserialize)]
struct Grant {
    principal: String,
    role: Option<String>,
}
async fn resource_groups(
    st: &AppState,
    c: &Caller,
    kind: &str,
    id: &str,
) -> ApiResult<Json<Value>> {
    let res = sharing::load(st, kind, id, c.uuid, Need::View).await?;
    let ancestors = crate::store::folder_chain(st, res.parent.as_deref()).await?;
    let ids: Vec<_> = ancestors.iter().map(|f| f.id.clone()).collect();
    let rows:Vec<(String,String,String,String,String)>=sqlx::query_as("select resource_kind,resource_id,principal,name,role from group_access where
        (resource_kind=$1 and resource_id=$2) or (resource_kind='folder' and resource_id=any($3)) order by name,principal")
        .bind(kind).bind(id).bind(ids).fetch_all(&st.pool).await?;
    Ok(Json(
        json!({"groups":rows.into_iter().map(|(k,r,principal,name,role)| json!({"principal":principal,"name":name,"role":role,"inherited":k!=kind || r!=id})).collect::<Vec<_>>()}),
    ))
}
async fn set_group(
    st: &AppState,
    c: &Caller,
    kind: &str,
    id: &str,
    b: Grant,
) -> ApiResult<Json<Value>> {
    sharing::load(st, kind, id, c.uuid, Need::Edit).await?;
    if let Some(ref role) = b.role {
        if crate::access::Role::parse(role).is_none() {
            return Err(ApiError::bad_request(
                "invalid_role",
                "Choose viewer, commenter or editor.",
                "Set role to null to remove access.",
            ));
        }
        let target = context(st, c)
            .await?
            .share_targets
            .into_iter()
            .find(|t| t.key() == b.principal)
            .ok_or_else(|| {
                ApiError::forbidden(
                    "invalid_share_target",
                    "This group is unavailable to the current account.",
                    "Select a current organization or team.",
                )
            })?;
        sqlx::query("insert into group_access(resource_kind,resource_id,principal,name,role) values($1,$2,$3,$4,$5)
            on conflict(resource_kind,resource_id,principal) do update set name=excluded.name,role=excluded.role")
            .bind(kind).bind(id).bind(&b.principal).bind(target.name).bind(role).execute(&st.pool).await?;
    } else {
        sqlx::query(
            "delete from group_access where resource_kind=$1 and resource_id=$2 and principal=$3",
        )
        .bind(kind)
        .bind(id)
        .bind(&b.principal)
        .execute(&st.pool)
        .await?;
    }
    resource_groups(st, c, kind, id).await
}
macro_rules! handlers {
    ($get:ident,$set:ident,$kind:literal) => {
        async fn $get(
            State(st): State<AppState>,
            c: Caller,
            Path(id): Path<String>,
        ) -> ApiResult<Json<Value>> {
            resource_groups(&st, &c, $kind, &id).await
        }
        async fn $set(
            State(st): State<AppState>,
            c: Caller,
            Path(id): Path<String>,
            JsonBody(b): JsonBody<Grant>,
        ) -> ApiResult<Json<Value>> {
            set_group(&st, &c, $kind, &id, b).await
        }
    };
}
handlers!(deck_groups, set_deck_group, "deck");
handlers!(folder_groups, set_folder_group, "folder");
