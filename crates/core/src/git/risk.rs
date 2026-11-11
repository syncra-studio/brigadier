//! Review's brief [D1188, D1213]: files a reviewer looks at first, flagged by path, git status and
//! the per-file +/− counts Review already has, so no new parser; and the session's last test or
//! build run as the fold kept it. Facts only: Rust sends what it saw, the UI writes the words
//! [D65, D71, D74].

use crate::fold::runs::Run;
use serde_json::{Value, json};
use std::path::Path;

/// Lock files, the UI's old icon table and the common rest.
const LOCKS: &[&str] = &[
    "cargo.lock",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "go.sum",
    "gemfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "uv.lock",
    "composer.lock",
    "package.resolved",
    "flake.lock",
    "npm-shrinkwrap.json",
];
const MANIFESTS: &[&str] = &[
    "package.json",
    "cargo.toml",
    "go.mod",
    "pyproject.toml",
    "pipfile",
    "setup.py",
    "setup.cfg",
    "gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "package.swift",
    "deno.json",
    "mix.exs",
    "pubspec.yaml",
];
const BUILD: &[&str] = &[
    "makefile",
    "dockerfile",
    "build.rs",
    "cmakelists.txt",
    "justfile",
    "taskfile.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "jenkinsfile",
    ".gitlab-ci.yml",
    ".travis.yml",
    "azure-pipelines.yml",
    "bitbucket-pipelines.yml",
];
/// Config whose name starts so: `vite.config.ts`, `tsconfig.base.json`.
const BUILD_PREFIXES: &[&str] = &[
    "tsconfig",
    "vite.config.",
    "webpack.config.",
    "rollup.config.",
    "babel.config.",
    "next.config.",
    "jest.config.",
    "vitest.config.",
    "requirements",
];
/// CI folders, by the CI's own convention for where its config lives.
const CI_DIRS: &[&str] = &[".github/workflows/", ".circleci/", ".buildkite/", ".cargo/"];

fn is_test(path: &str, name: &str) -> bool {
    let dirs = ["test/", "tests/", "__tests__/", "spec/", "e2e/"];
    dirs.iter()
        .any(|d| path.starts_with(d) || path.contains(&format!("/{d}")))
        || [".test.", ".spec.", "_test.", "_spec."]
            .iter()
            .any(|m| name.contains(m))
        || name.starts_with("test_")
        || (name.ends_with("tests.swift")
            || name.ends_with("test.java")
            || name.ends_with("test.kt"))
}

/// The one flag a file gets, or none: `{kind, removed}`, its kind one of `test` (deleted, or
/// lines removed), `lock`, `manifest`, `build` (CI and build config) or `migration`.
pub fn flag(file: &Value) -> Option<Value> {
    let path = file["path"].as_str()?;
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let removed = file["deletions"].as_u64().unwrap_or(0);
    let deleted = file["status"] == "deleted";
    let kind = if is_test(&lower, name) {
        (deleted || removed > 0).then_some("test")?
    } else if LOCKS.contains(&name) {
        "lock"
    } else if MANIFESTS.contains(&name) || name.ends_with(".csproj") {
        "manifest"
    } else if BUILD.contains(&name)
        || BUILD_PREFIXES.iter().any(|p| name.starts_with(p))
        || CI_DIRS
            .iter()
            .any(|d| lower.starts_with(d) || lower.contains(&format!("/{d}")))
    {
        "build"
    } else if ["migrations/", "migrate/", "alembic/versions/"]
        .iter()
        .any(|d| lower.starts_with(d) || lower.contains(&format!("/{d}")))
    {
        "migration"
    } else {
        return None;
    };
    Some(json!({"kind": kind, "removed": removed, "deleted": deleted}))
}

/// Adds the brief to a review: each file's flag, flagged files first in the list, and the last
/// run with `changed`: whether an edit to this checkout began after the run ended, the run's own
/// fact, so every scope, Review's and Source's, says the same [D1243]. Nothing proves the files
/// didn't change, so the other answer is unknown, never "no" [D1192].
/// `root`: the checkout; `cwd`: the session's folder, which a step's relative path starts from.
pub fn brief(review: &mut Value, run: Option<&Run>, root: &Path, cwd: &Path) {
    let mut files: Vec<Value> = review["files"].as_array().cloned().unwrap_or_default();
    for file in &mut files {
        file["flag"] = flag(file).into();
    }
    files.sort_by_key(|f| f["flag"].is_null());
    let changed = run.is_some_and(|run| (run.after.iter()).any(|p| cwd.join(p).starts_with(root)));
    review["run"] = run.map_or(
        Value::Null,
        |run| json!({"command": run.command, "exit": run.exit, "at": run.at, "changed": changed}),
    );
    review["files"] = files.into();
}
