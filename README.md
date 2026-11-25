<p align="center">
  <a href="https://brigadier.sh"><img src=".github/assets/icon.png" width="128" height="128" alt="Brigadier icon"></a>
</p>

<h1 align="center">Brigadier</h1>

<p align="center">A Mac app where your coding agents work as a team, under your own sign-ins.</p>

<p align="center">
  <a href="https://github.com/syncra-studio/brigadier/actions/workflows/ci.yml"><img src="https://github.com/syncra-studio/brigadier/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="https://brigadier.sh">Website</a> ·
  <a href="#install">Install</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

Brigadier runs the coding agents you already use, Claude Code, Codex and OpenCode, each one's own
command-line tool, unmodified and signed in by you, and shows their work as a chat. There is no
Brigadier account. You start a **session** for each task. A session can start **workers**: sessions of
their own that take a part of it. In a git project each worker, and each session unless you choose
otherwise, gets a **worktree**: a separate copy of the project's files on its own git branch, so they
don't overwrite each other.

> [!NOTE]
> Brigadier is in active development and has no stable release yet.

## Why Brigadier

- **A second agent checks.** Once you turn it on in Settings › Routing, with two agents set up, a
  worker that ends with commits is reviewed by a different one. It gets the findings and one turn to
  fix them: one review, never a loop.
- **Work goes on without the app.** Each session runs in a process of its own. Quitting or
  restarting the app, or a crash of it or its background service, leaves your agents working.
- **Keep going with the lid closed.** Turn it on once with your administrator password and agents
  keep working while the Mac is shut; on low battery the Mac sleeps again.
- **The right model for each job.** In Settings › Routing you list which agent, model and effort
  each kind of work gets, and see how much of each model's work was kept.
- **One plugin setup for every agent.** Add a skill or MCP server once; its keys are kept in one
  Keychain item.
- **Overnight.** Agree on a list and start the night, at Full access. In the morning a card says
  what was done, decided and left out, with a reviewer's proof where there is one.

## Features

- **Workers.** A session hands parts of its task to workers on any of your agents. You can read and
  message each one; its agent merges its branch with git.
- **Sessions talk.** Agents can message other sessions, whatever agent they run on, and search past
  sessions.
- **Permission levels.** Ask, Auto or Full access, per session. A project you haven't trusted runs
  at Ask.
- **Queue or steer.** A message sent while an agent works waits in a list you can edit and reorder,
  or goes into the turn now.
- **Fork and rewind.** Branch a chat from an earlier answer, even on another agent, or edit an
  earlier message and undo the agent's file changes since, where Brigadier has them recorded.
- **Switch agents.** Move a chat to another agent mid-way; it starts from a hand-off of the chat's
  own records.
- **Pull requests.** Read diffs and comment on them, open a pull request (which can commit and push
  for you), and review and merge GitHub pull requests, listed in one inbox.
- **Mockups.** Before a big UI change, have variants drawn as live pages, pin notes on them, and
  pick one to build.
- **Notes.** Markdown notes per project that you can mention in a chat.
- **History search.** ⌘K searches everything said in any session, archived ones too.
- **Accounts and usage.** Claude Code and Codex can each have several accounts; see what each one
  has left.
- **Built-in browser.** Agents read and use web pages in it.
- **Computer use.** Off until you turn it on. Agents can then use other Mac apps while your mouse and
  keyboard stay yours; Stop is in the menu bar.

## Install

Ready-made builds come with the next release. The earlier 0.1.0-alpha on the Releases page is an
older app. Until then, build it from source.

You need:

- a Mac with Apple silicon (Windows and Linux aren't supported yet);
- Apple's command line tools: `xcode-select --install`;
- [rustup](https://rustup.rs), [Node.js](https://nodejs.org) and [pnpm](https://pnpm.io), at the
  versions pinned in `rust-toolchain.toml`, `.node-version` and `package.json`;
- at least one agent from [the list below](#supported-agents); Brigadier's setup can install it;
- `gh`, GitHub's command-line tool, for pull requests and sending feedback.

```sh
git clone https://github.com/syncra-studio/brigadier.git
cd brigadier
pnpm install
pnpm start
```

`pnpm package` makes `out/Brigadier-darwin-arm64/Brigadier.app`, signed ad hoc. Computer use works
only in that build. Brigadier keeps its data in `~/Library/Application Support/Brigadier`; set
`BRIGADIER_DATA` to use another folder.

## Supported agents

| Agent | Models |
| --- | --- |
| [Claude Code](https://code.claude.com/docs) | Claude |
| [Codex](https://developers.openai.com/codex/cli) | OpenAI |
| [OpenCode](https://opencode.ai/docs) | The providers you give it a key for; local models through OpenCode |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md) first. `pnpm gallery`
shows the app's components, and `pnpm thread` the chat, both on made-up data.

## Community and support

- **Bugs and ideas:** [open an issue](https://github.com/syncra-studio/brigadier/issues/new/choose),
  or use Send Feedback in the app.
- **Security problems:** privately, as [SECURITY.md](SECURITY.md) says.
- **Conduct:** everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). Third-party code and icons are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
