//! REST client for the licensing backend (`apps/server`).
//!
//! Wraps every endpoint the launcher needs. The JWT lives in `settings`
//! and is injected as a `Bearer` header on protected calls. All methods are
//! async and return `Result<T, ApiError>` — the UI surfaces `ApiError::Server`
//! messages verbatim (they're already human-readable codes).

use reqwest::{Client, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::env;

use crate::types::{CatalogGame, EntitlementsResponse, Plan, Subscription};

/// Fallback base URL used when neither settings nor `VITE_API_URL` apply.
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8787";

/// Resolves the backend base URL: user-set `settings.server_url` first,
/// then `VITE_API_URL` — baked at COMPILE time via `option_env!` (the
/// production build ships with `VITE_API_URL=https://api.<domain>` set in
/// the build shell), then a runtime env override for dev shells, then the
/// loopback default.
///
/// Debug/dev builds only — a user-supplied base URL is a trivial license
/// bypass (fake server that always answers `allowed: true`), so release
/// builds take the compile-time URL exclusively.
#[cfg(debug_assertions)]
pub fn resolve_base_url(server_url: Option<&str>) -> String {
    server_url
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| option_env!("VITE_API_URL").map(String::from))
        .or_else(|| env::var("VITE_API_URL").ok())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// Release builds: the prod endpoint is fixed at compile time. `env!`
/// fails the build if `VITE_API_URL` isn't set — a release binary without
/// a baked server URL would be useless anyway.
#[cfg(not(debug_assertions))]
pub fn resolve_base_url(_server_url: Option<&str>) -> String {
    env!("VITE_API_URL").trim_end_matches('/').to_string()
}

/// Errors the UI can surface directly.
#[derive(Debug)]
pub enum ApiError {
    /// Transport failure (DNS/connect/timeout) — retryable.
    Network(reqwest::Error),
    /// Server answered with an error envelope.
    Server {
        status: u16,
        code: String,
        /// `x-request-id` from the server — support ticket correlation.
        request_id: Option<String>,
        /// Optional local detail for logs (never a secret).
        detail: Option<String>,
    },
    Malformed,
}

impl std::fmt::Display for ApiError {
    /// `CODE[|req=<id>][|<detail>]` — first `|` segment is the machine
    /// code the UI localizes; `req=` is the support correlation id.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_client_string())
    }
}

impl std::error::Error for ApiError {}

impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        ApiError::Network(e)
    }
}

impl ApiError {
    /// Shorthand for constructing a Server error without a request id.
    pub fn server(status: u16, code: impl Into<String>) -> Self {
        ApiError::Server {
            status,
            code: code.into(),
            request_id: None,
            detail: None,
        }
    }

    /// Same but with internal detail appended to the display string.
    pub fn server_detailed(status: u16, code: impl Into<String>, detail: String) -> Self {
        ApiError::Server {
            status,
            code: code.into(),
            request_id: None,
            detail: Some(detail),
        }
    }

    /// Machine code for UI localization (`errorMessages.ts`).
    pub fn code(&self) -> &str {
        match self {
            ApiError::Network(_) => "NETWORK_ERROR",
            ApiError::Server { code, .. } => code.as_str(),
            ApiError::Malformed => "INTERNAL_ERROR",
        }
    }

    /// `CODE[|req=<id>][|<detail>]` — the frontend splits on `|`; first
    /// segment is the machine code, `req=` carries the support reference.
    pub fn to_client_string(&self) -> String {
        match self {
            ApiError::Server {
                code,
                request_id,
                detail,
                ..
            } => {
                let mut s = code.clone();
                if let Some(id) = request_id {
                    s.push_str(&format!("|req={id}"));
                }
                if let Some(d) = detail {
                    s.push_str(&format!("|{d}"));
                }
                s
            }
            _ => self.code().to_string(),
        }
    }

    fn transport_retryable(&self) -> bool {
        matches!(self, ApiError::Network(e) if e.is_connect() || e.is_timeout() || e.is_request())
    }
}

/// Thin authenticated HTTP client. The base URL is behind a shared
/// `RwLock` so `set_server_url` can retarget it live (e.g. when the
/// streamer points the launcher at a remote backend) without restarting.
#[derive(Clone)]
pub struct ApiClient {
    http: Client,
    base: std::sync::Arc<std::sync::RwLock<String>>,
}

/// The `user` object inside auth responses.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct AuthUser {
    pub id: i64,
    pub email: String,
    pub hwid: Option<String>,
    /// 'user' | 'admin' — drives the admin tab in the UI; the server never
    /// trusts it for authorization (DB-checked per request).
    #[serde(default)]
    pub role: Option<String>,
}

/// Response of `/api/auth/{register,login}`.
#[derive(Debug, serde::Deserialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: AuthUser,
    pub subscription: Subscription,
}

/// Response of `POST /api/license/verify` (extra server fields are ignored).
#[derive(Debug, serde::Deserialize)]
pub struct VerifyResponse {
    pub allowed: bool,
}

impl ApiClient {
    /// Creates a client bound to `base` (see [`resolve_base_url`]).
    pub fn new(base: String) -> Self {
        Self {
            http: Client::new(),
            base: std::sync::Arc::new(std::sync::RwLock::new(base)),
        }
    }

    /// Current backend base URL (for the settings UI).
    pub fn base(&self) -> String {
        self.base.read().map(|b| b.clone()).unwrap_or_default()
    }

    /// Retargets all subsequent requests to `base`.
    pub fn set_base(&self, base: String) {
        if let Ok(mut b) = self.base.write() {
            *b = base;
        }
    }

    /// Performs a JSON request; maps non-2xx to [`ApiError::Server`].
    /// Idempotent GETs retry transport failures twice (500 ms, 1500 ms).
    async fn req<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<T, ApiError> {
        const RETRY_DELAYS: [u64; 2] = [500, 1500];
        let attempts = if method == reqwest::Method::GET {
            RETRY_DELAYS.len() + 1
        } else {
            1
        };
        let mut last_err: Option<ApiError> = None;
        for attempt in 0..attempts {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAYS[attempt - 1]))
                    .await;
            }
            match self
                .req_once::<T>(method.clone(), path, token, body.clone())
                .await
            {
                Err(e) if e.transport_retryable() => last_err = Some(e),
                other => return other,
            }
        }
        Err(last_err.unwrap_or(ApiError::Malformed))
    }

    /// Single attempt of [`req`]; extracts the error envelope's `error`
    /// code and the `x-request-id` header for support correlation.
    async fn req_once<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<T, ApiError> {
        let mut r = self
            .http
            .request(method, format!("{}{}", self.base(), path));
        if let Some(t) = token {
            r = r.bearer_auth(t);
        }
        if let Some(b) = body {
            r = r.json(&b);
        }
        let res = r.send().await?;
        let status = res.status();
        if !status.is_success() {
            let request_id = res
                .headers()
                .get("x-request-id")
                .and_then(|v| v.to_str().ok())
                .map(String::from);
            let code = res
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| "UNKNOWN".to_string());
            return Err(ApiError::Server {
                status: status.as_u16(),
                code,
                request_id,
                detail: None,
            });
        }
        res.json::<T>().await.map_err(|_| ApiError::Malformed)
    }

    /// `POST /api/auth/register`.
    pub async fn register(
        &self,
        email: &str,
        password: &str,
        hwid: &str,
    ) -> Result<AuthResponse, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/auth/register",
            None,
            Some(json!({"email": email, "password": password, "hwid": hwid})),
        )
        .await
    }

    /// `POST /api/auth/login`.
    pub async fn login(
        &self,
        email: &str,
        password: &str,
        hwid: &str,
    ) -> Result<AuthResponse, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/auth/login",
            None,
            Some(json!({"email": email, "password": password, "hwid": hwid})),
        )
        .await
    }

    /// `POST /api/auth/logout` — invalidates the token server-side.
    pub async fn logout(&self, token: &str) -> Result<Value, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/auth/logout",
            Some(token),
            Some(json!({})),
        )
        .await
    }

    /// `GET /api/billing/subscription`.
    pub async fn subscription(&self, token: &str) -> Result<Subscription, ApiError> {
        let v: Value = self
            .req(
                reqwest::Method::GET,
                "/api/billing/subscription",
                Some(token),
                None,
            )
            .await?;
        serde_json::from_value(v["subscription"].clone()).map_err(|_| ApiError::Malformed)
    }

    /// `POST /api/billing/checkout` — creates a pending payment for
    /// `plan_code` and returns the provider's hosted checkout URL (501
    /// PROVIDER_NOT_CONFIGURED until YOOKASSA_* is set on the server).
    pub async fn checkout(&self, token: &str, plan_code: &str) -> Result<Value, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/billing/checkout",
            Some(token),
            Some(json!({"plan_code": plan_code})),
        )
        .await
    }

    /// `GET /api/billing/providers` — which payment rails the server has
    /// configured (yookassa / tribute + plan→product-link map).
    pub async fn billing_providers(&self, token: &str) -> Result<Value, ApiError> {
        self.req(
            reqwest::Method::GET,
            "/api/billing/providers",
            Some(token),
            None,
        )
        .await
    }

    /// `POST /api/tg/link-code` — one-shot Telegram bind code +
    /// deep-link URL for the bind-bot.
    pub async fn tg_link_code(
        &self,
        token: &str,
        plan_code: Option<&str>,
    ) -> Result<Value, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/tg/link-code",
            Some(token),
            Some(json!({"plan_code": plan_code})),
        )
        .await
    }

    /// `GET /api/tg/status` — the caller's Telegram binding.
    pub async fn tg_status(&self, token: &str) -> Result<Value, ApiError> {
        self.req(reqwest::Method::GET, "/api/tg/status", Some(token), None)
            .await
    }

    /// `POST /api/tg/unbind` — detaches the caller's Telegram account.
    pub async fn tg_unbind(&self, token: &str) -> Result<Value, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/tg/unbind",
            Some(token),
            Some(json!({})),
        )
        .await
    }

    /// `POST /api/tiktok/bind` — starts TikTok account binding, returns
    /// the one-shot bio code.
    pub async fn tiktok_bind(&self, token: &str, username: &str) -> Result<Value, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/tiktok/bind",
            Some(token),
            Some(json!({"username": username})),
        )
        .await
    }

    /// `POST /api/tiktok/verify` — checks the profile bio for the code.
    pub async fn tiktok_verify(&self, token: &str) -> Result<Value, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/tiktok/verify",
            Some(token),
            Some(json!({})),
        )
        .await
    }

    /// `GET /api/tiktok/bind` — the caller's TikTok binding status.
    pub async fn tiktok_bind_status(&self, token: &str) -> Result<Value, ApiError> {
        self.req(reqwest::Method::GET, "/api/tiktok/bind", Some(token), None)
            .await
    }

    /// `POST /api/tiktok/unbind` — detaches the caller's TikTok account.
    pub async fn tiktok_unbind(&self, token: &str) -> Result<Value, ApiError> {
        self.req(
            reqwest::Method::POST,
            "/api/tiktok/unbind",
            Some(token),
            Some(json!({})),
        )
        .await
    }

    /// `POST /api/billing/mock-pay` — TEST endpoint, grants a plan period.
    pub async fn mock_pay(&self, token: &str, plan_code: &str) -> Result<Subscription, ApiError> {
        let v: Value = self
            .req(
                reqwest::Method::POST,
                "/api/billing/mock-pay",
                Some(token),
                Some(json!({"plan_code": plan_code})),
            )
            .await?;
        serde_json::from_value(v["subscription"].clone()).map_err(|_| ApiError::Malformed)
    }

    /// `POST /api/billing/mock-expire` — TEST endpoint, forces expiry.
    pub async fn mock_expire(&self, token: &str) -> Result<Subscription, ApiError> {
        let v: Value = self
            .req(
                reqwest::Method::POST,
                "/api/billing/mock-expire",
                Some(token),
                Some(json!({})),
            )
            .await?;
        serde_json::from_value(v["subscription"].clone()).map_err(|_| ApiError::Malformed)
    }

    /// `POST /api/license/verify` — pre-launch gate. `game_slug` lets the
    /// server allow `is_free` titles for Free-tier accounts (§8.3).
    pub async fn verify_license(
        &self,
        token: &str,
        hwid: &str,
        game_slug: Option<&str>,
    ) -> Result<bool, ApiError> {
        match self
            .req::<VerifyResponse>(
                reqwest::Method::POST,
                "/api/license/verify",
                Some(token),
                Some(json!({"hwid": hwid, "game_slug": game_slug})),
            )
            .await
        {
            Ok(v) => Ok(v.allowed),
            Err(e) => Err(e),
        }
    }

    /// `GET /api/plans` — public tariff catalog for the pricing table.
    pub async fn plans(&self) -> Result<Vec<Plan>, ApiError> {
        let v: Value = self
            .req(reqwest::Method::GET, "/api/plans", None, None)
            .await?;
        serde_json::from_value(v["plans"].clone()).map_err(|_| ApiError::Malformed)
    }

    /// `GET /api/account/entitlements` — effective plan + limits + usage.
    pub async fn entitlements(&self, token: &str) -> Result<EntitlementsResponse, ApiError> {
        self.req(
            reqwest::Method::GET,
            "/api/account/entitlements",
            Some(token),
            None,
        )
        .await
    }

    /// `POST /api/usage/report` — ships a coins delta for the earn limit;
    /// `nonce` makes retries idempotent. Returns the month total.
    pub async fn report_usage(
        &self,
        token: &str,
        month: &str,
        coins_delta: i64,
        nonce: &str,
    ) -> Result<i64, ApiError> {
        let v: Value = self
            .req(
                reqwest::Method::POST,
                "/api/usage/report",
                Some(token),
                Some(json!({
                    "month": month,
                    "coins_delta": coins_delta,
                    "nonce": nonce,
                })),
            )
            .await?;
        v.get("coins")
            .and_then(|c| c.as_i64())
            .ok_or(ApiError::Malformed)
    }

    /// `GET /api/games` — catalog.
    pub async fn games(&self, token: &str) -> Result<Vec<CatalogGame>, ApiError> {
        let v: Value = self
            .req(reqwest::Method::GET, "/api/games", Some(token), None)
            .await?;
        serde_json::from_value(v["games"].clone()).map_err(|_| ApiError::Malformed)
    }

    /// Downloads a game zip to `dest`, streaming chunks while computing the
    /// SHA-256 of what actually arrived. Returns the hex digest — the caller
    /// compares it against the catalog `sha256` before extracting (spec §6.1).
    pub async fn download_game_zip(
        &self,
        token: &str,
        slug: &str,
        dest: &std::path::Path,
    ) -> Result<String, ApiError> {
        use sha2::{Digest, Sha256};
        let mut res = self
            .http
            .get(format!("{}/api/games/{}/download", self.base(), slug))
            .bearer_auth(token)
            .send()
            .await?;
        if res.status() == StatusCode::FORBIDDEN {
            return Err(ApiError::server(403, "SUBSCRIPTION_REQUIRED"));
        }
        if !res.status().is_success() {
            return Err(ApiError::server(res.status().as_u16(), "DOWNLOAD_FAILED"));
        }
        let mut out = std::fs::File::create(dest)
            .map_err(|e| ApiError::server_detailed(500, "DOWNLOAD_FAILED", e.to_string()))?;
        let mut hasher = Sha256::new();
        use std::io::Write;
        while let Some(chunk) = res.chunk().await? {
            out.write_all(&chunk)
                .map_err(|e| ApiError::server_detailed(500, "DOWNLOAD_FAILED", e.to_string()))?;
            hasher.update(&chunk);
        }
        Ok(hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }

    /// `GET /api/mc/plugins` — the Paper-plugin catalog (§9.4).
    pub async fn mc_plugins(&self, token: &str) -> Result<Vec<crate::types::McPlugin>, ApiError> {
        let v: Value = self
            .req(reqwest::Method::GET, "/api/mc/plugins", Some(token), None)
            .await?;
        serde_json::from_value(v["plugins"].clone()).map_err(|_| ApiError::Malformed)
    }

    /// Downloads a plugin jar to `dest`, streaming with a running SHA-256 —
    /// the caller compares against the catalog `sha256`. Server errors
    /// (`PLAN_LIMIT:mc_premium_plugins`, 404s) keep their real code.
    pub async fn download_mc_plugin(
        &self,
        token: &str,
        slug: &str,
        dest: &std::path::Path,
    ) -> Result<String, ApiError> {
        use sha2::{Digest, Sha256};
        let res = self
            .http
            .get(format!("{}/api/mc/plugins/{}/download", self.base(), slug))
            .bearer_auth(token)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let code = res
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| "DOWNLOAD_FAILED".to_string());
            return Err(ApiError::server(status, code));
        }
        let mut out = std::fs::File::create(dest)
            .map_err(|e| ApiError::server_detailed(500, "DOWNLOAD_FAILED", e.to_string()))?;
        let mut hasher = Sha256::new();
        use std::io::Write;
        let mut res = res;
        while let Some(chunk) = res.chunk().await? {
            out.write_all(&chunk)
                .map_err(|e| ApiError::server_detailed(500, "DOWNLOAD_FAILED", e.to_string()))?;
            hasher.update(&chunk);
        }
        Ok(hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }

    // ---------------------------------------------------------------
    // Admin API (server enforces users.role='admin'; we just send the JWT)
    // ---------------------------------------------------------------

    /// Generic `/api/admin/*` JSON call — returns the raw response value.
    pub async fn admin_json(
        &self,
        method: reqwest::Method,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> Result<Value, ApiError> {
        self.req::<Value>(method, path, Some(token), body).await
    }

    /// `POST /api/admin/games/:slug/builds?version=&changelog=` — streams the
    /// zip file in 256 KiB chunks so large builds never sit in memory whole;
    /// `progress(sent, total)` fires per chunk for the UI progress bar.
    pub async fn admin_upload_build(
        &self,
        token: &str,
        slug: &str,
        version: &str,
        changelog: &str,
        path: &std::path::Path,
        progress: impl Fn(u64, u64) + Send + Sync + 'static,
    ) -> Result<Value, ApiError> {
        use futures_util::stream;
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::Arc;
        use tokio::io::AsyncReadExt;

        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| ApiError::server_detailed(400, "FILE_OPEN_FAILED", e.to_string()))?;
        let total = file
            .metadata()
            .await
            .map_err(|e| ApiError::server_detailed(400, "FILE_STAT_FAILED", e.to_string()))?
            .len();

        let sent = Arc::new(AtomicU64::new(0));
        let progress = Arc::new(progress);
        let sent_c = sent.clone();
        let progress_c = progress.clone();
        let body_stream = stream::try_unfold(file, move |mut f| {
            let sent_c = sent_c.clone();
            let progress_c = progress_c.clone();
            async move {
                let mut buf = vec![0u8; 256 * 1024];
                let n = f.read(&mut buf).await?;
                if n == 0 {
                    return Ok(None);
                }
                buf.truncate(n);
                let done = sent_c.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
                progress_c(done, total);
                Ok::<_, std::io::Error>(Some((bytes::Bytes::from(buf), f)))
            }
        });

        let url = format!(
            "{}/api/admin/games/{}/builds?version={}&changelog={}",
            self.base(),
            slug,
            urlencode(version),
            urlencode(changelog),
        );
        let res = self
            .http
            .post(url)
            .bearer_auth(token)
            .header("content-type", "application/octet-stream")
            .body(reqwest::Body::wrap_stream(body_stream))
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let code = res
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| "UNKNOWN".to_string());
            return Err(ApiError::server(status.as_u16(), code));
        }
        res.json::<Value>().await.map_err(|_| ApiError::Malformed)
    }
}

/// Percent-encodes a query param value (unreserved ASCII chars pass through).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
