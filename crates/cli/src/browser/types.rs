//! The browser store's existing wire shapes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadState {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownload {
    pub id: i64,
    pub url: String,
    /// Where it was saved.
    pub path: String,
    /// When it started, in ms since the Unix epoch.
    pub at_ms: i64,
    pub state: DownloadState,
}
