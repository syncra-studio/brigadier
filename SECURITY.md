# Security policy

## Reporting a vulnerability

Please report privately, through GitHub:
[Report a vulnerability](https://github.com/syncra-studio/brigadier/security/advisories/new)
(the repository's **Security** tab › **Report a vulnerability**). Never use a public issue, pull
request or discussion.

Include:

- the commit or version, your macOS version and the agent CLIs' versions;
- the permission level the session ran at;
- exact steps to reproduce, and what an attacker gains;
- a proof of concept if you have one. It must stay within your own machine and accounts.

## What to expect

We aim to reply within a week. Please give us a reasonable time to ship a fix before you disclose
anything publicly. If you want credit, the advisory will name you.

## How Brigadier is trusted

Brigadier runs agents on your Mac with your own account's rights. It adds no sandbox of its own around
them: the permission levels (Ask, Auto, Full access) become each agent CLI's own permission settings,
with a few rules of Brigadier's on top, and the CLI enforces them. A git worktree keeps files apart; it
doesn't contain a process. The daemon tells the app from a session's agent by the process that calls
it, and gives an agent's connection only the commands meant for agents.

## Scope

In scope: anything that lets a session, a worker, a web page or another local process do more than
the session's permission level allows. For example:

- a session doing more than its level allows, or running above Ask in a folder you don't trust;
- a session's agent reaching the app's own commands on the daemon's socket, or acting as another
  session;
- a plugin's or MCP server's sign-in or key leaking into what Brigadier records, shows or sends
  elsewhere;
- a page in the built-in browser getting the app's IPC, or capabilities its site settings deny;
- computer use reading password fields, or acting on security prompts or on Brigadier itself;
- deleting a session or a project deleting anything Brigadier didn't create.

Out of scope:

- what a session at **Full access** can do: there, agents run with your account's full rights
  by design;
- a process of your own user account that drops its session's marker and leaves its process tree:
  it counts as the app, a known limit (`crates/daemon/src/caller.rs`);
- vulnerabilities in the provider CLIs themselves: report those to their vendors;
- a prompt injection that only makes an agent do what its permission level already allows.

## Supported versions

Brigadier has no stable release yet. Only the latest `main` is supported: check that a problem still
exists there before you report it.
