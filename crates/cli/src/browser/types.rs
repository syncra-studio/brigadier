//! The browser store's existing wire shapes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryFilter {
    All,
    /// Pages in tabs opened from something an agent gave: a link in its reply, a preview.
    Agent,
    /// Everything else: pages the user opened, and imported history.
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVisit {
    pub id: i64,
    pub url: String,
    /// Empty when the page had none.
    pub title: String,
    /// When, in ms since the Unix epoch.
    pub at_ms: i64,
    pub agent: bool,
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SitePermission {
    /// The page's request shows the system's own question (the default).
    Ask,
    Allow,
    Block,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSite {
    /// `scheme://host[:port]`.
    pub origin: String,
    pub camera: SitePermission,
    pub microphone: SitePermission,
    pub location: SitePermission,
    /// When it last asked, in ms since the Unix epoch.
    pub asked_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    /// When it finished, in Unix milliseconds.
    pub at_ms: i64,
    /// The names of the profiles it copied from.
    pub profiles: Vec<String>,
    /// Cookies now in Brigadier's browser.
    pub imported: u32,
    /// Cookies left out: expired, kept per site, unreadable or refused by the browser.
    pub skipped: u32,
    /// Up to 20 of the domains whose cookies were unreadable or refused.
    pub skipped_domains: Vec<String>,
    /// How many such domains there were in all.
    pub skipped_domain_count: u32,
    /// Pages of history added.
    pub history: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedVisit {
    pub url: String,
    pub title: String,
    pub at_ms: i64,
}
