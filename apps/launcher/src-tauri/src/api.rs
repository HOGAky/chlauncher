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
use thiserror::Error;

use crate::types::{CatalogGame, Subscription};

/// Fallback base URL used when neither settings nor `VITE_API_URL` apply.
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8787";

/// Resolves the backend base URL: user-set `settings.server_url` first,
/// then the `VITE_API_URL` env override, then the loopback default.
pub fn resolve_base_url(server_url: Option<&str>) -> String {
    server_url
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .or_else(|| env::var("VITE_API_URL").ok())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// Errors the UI can surface directly.
#[derive(Debug, Error)]
pub enum ApiError {
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    /// `(status, server error code)` — e.g. `SUBSCRIPTION_REQUIRED`.
    #[error("{1}")]
    Server(u16, String),
    #[error("malformed response")]
    Malformed,
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
    async fn req<T: DeserializeOwned>(
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
            let code = res
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| "UNKNOWN".to_string());
            return Err(ApiError::Server(status.as_u16(), code));
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

    /// `POST /api/billing/mock-pay` — TEST endpoint, grants 30 days.
    pub async fn mock_pay(&self, token: &str) -> Result<Subscription, ApiError> {
        let v: Value = self
            .req(
                reqwest::Method::POST,
                "/api/billing/mock-pay",
                Some(token),
                Some(json!({})),
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

    /// `POST /api/license/verify` — pre-launch gate.
    pub async fn verify_license(&self, token: &str, hwid: &str) -> Result<bool, ApiError> {
        match self
            .req::<VerifyResponse>(
                reqwest::Method::POST,
                "/api/license/verify",
                Some(token),
                Some(json!({"hwid": hwid})),
            )
            .await
        {
            Ok(v) => Ok(v.allowed),
            Err(e) => Err(e),
        }
    }

    /// `GET /api/games` — catalog.
    pub async fn games(&self, token: &str) -> Result<Vec<CatalogGame>, ApiError> {
        let v: Value = self
            .req(reqwest::Method::GET, "/api/games", Some(token), None)
            .await?;
        serde_json::from_value(v["games"].clone()).map_err(|_| ApiError::Malformed)
    }

    /// Downloads a game zip to `dest`. The caller must have checked the
    /// subscription server-side (the endpoint enforces it anyway).
    pub async fn download_game_zip(
        &self,
        token: &str,
        slug: &str,
        dest: &std::path::Path,
    ) -> Result<(), ApiError> {
        let res = self
            .http
            .get(format!("{}/api/games/{}/download", self.base(), slug))
            .bearer_auth(token)
            .send()
            .await?;
        if res.status() == StatusCode::FORBIDDEN {
            return Err(ApiError::Server(403, "SUBSCRIPTION_REQUIRED".into()));
        }
        if !res.status().is_success() {
            return Err(ApiError::Server(
                res.status().as_u16(),
                "DOWNLOAD_FAILED".into(),
            ));
        }
        let bytes = res.bytes().await?;
        std::fs::write(dest, &bytes).map_err(|e| {
            ApiError::Server(500, format!("WRITE_FAILED: {e}"))
        })?;
        Ok(())
    }
}
