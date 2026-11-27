//! The agent's own processes, which no turn left running: its CLI's server and MCP servers.

use brigadier_frames::procs;
use std::collections::BTreeSet;
use std::path::Path;

/// The CLI's server, when the agent is Brigadier's helper that holds it: the helper starts nothing
/// else. With it what it handed the helper's own pipes to, as a launcher does to the CLI it runs;
/// a tool or an MCP server gets its own.
pub(super) fn server(all: &[procs::Proc], child: i32) -> BTreeSet<i32> {
    let argv = procs::args(child).map(|a| a.0).unwrap_or_default();
    let helper = matches!(&argv[..], [exe, word, ..] if exe.contains(['/', '\\']) && procs::program_name(exe) == "brigadier" && word == "helper");
    let mut found = BTreeSet::new();
    for p in all.iter().filter(|p| helper && p.ppid == child) {
        found.insert(p.pid);
        let below = procs::descendants(all, p.pid).into_iter().map(|p| p.pid);
        match procs::stdio(p.pid) {
            Some(pipes) => found.extend(below.filter(|&b| procs::stdio(b) == Some(pipes))),
            // Unprovable here: the helper starts nothing else, so all below its child is the CLI's.
            None if !procs::STDIO_KNOWN => found.extend(below),
            None => {}
        }
    }
    found
}

/// The command lines, a program then its args, the session's agent may start an MCP server with: its
/// config's, the library's and Brigadier's own.
pub(super) fn mcp_lines(dir: &Path, fold: &super::Fold, backend: &str) -> Vec<Vec<String>> {
    let spec = std::fs::read(dir.join("session.json")).ok();
    let Some(mut spec) = spec.and_then(|b| serde_json::from_slice::<crate::Spec>(&b).ok()) else {
        return vec![];
    };
    spec.dir = dir.into();
    // On the account it runs on now, whose home holds its config.
    let spec = crate::account::as_run(&spec, fold, backend, None);
    let mut servers = crate::adapters::get(backend).map_or(vec![], |a| a.launched_servers(&spec));
    servers.extend(crate::library::on_for(
        &crate::data_of(&spec),
        spec.project.as_deref(),
    ));
    let line = |s: &serde_json::Value| {
        let args = s["args"].as_array().into_iter().flatten();
        let args = args.filter_map(|a| a.as_str().map(String::from));
        Some(
            std::iter::once(s["command"].as_str()?.to_string())
                .chain(args)
                .collect(),
        )
    };
    let mut all: Vec<Vec<String>> = servers.iter().filter_map(line).collect();
    all.push(vec!["brigadier".into(), "mcp-server".into()]);
    all
}

/// Whether `argv` runs `line`, a program then its args, a program named by its path only there and
/// a bare one wherever its PATH found it: as it is, or through the interpreter its script names.
/// npx retitles itself `npm exec <its args from the package on>`, zeroing the rest.
pub(super) fn runs(argv: &[String], line: &[String]) -> bool {
    let Some((program, args)) = line.split_first() else {
        return false;
    };
    let base = |a: &str| procs::program_name(a).to_string();
    let same = |a: &str| match program.contains('/') {
        true => a == program,
        false => base(a) == *program,
    };
    let at = (argv.len().checked_sub(args.len())).filter(|n| (1..=3).contains(n));
    let direct = at.is_some_and(|n| argv[n..] == *args && same(&argv[n - 1]));
    // Its options go, `-p <package>`'s value too (npm's `bin/npx-cli.js`).
    let at = (args.iter().enumerate())
        .find(|&(i, a)| {
            !a.starts_with('-') && (i == 0 || !["-p", "--package"].contains(&&*args[i - 1]))
        })
        .map_or(args.len(), |(i, _)| i);
    let title = std::iter::once("npm exec").chain(args[at..].iter().map(String::as_str));
    direct || (base(program) == "npx" && argv[..] == [title.collect::<Vec<_>>().join(" ")])
}
