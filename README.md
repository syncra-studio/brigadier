# Brigadier

Brigadier is a Mac app that runs AI coding agents, one session per task, and shows their work as a
chat. It is under active development and has no stable release yet: you build it from source.

It runs the coding CLIs you already use, unmodified and under your own sign-ins: Claude Code, Codex
and OpenCode, which also brings API keys and local models (Ollama, LM Studio, vLLM). There is no
Brigadier account.

- **Sessions.** Each works in a git worktree of its own, or in your folder. Work goes on when the
  app closes.
- **Workers.** A session can hand parts of its task to other sessions and get a review from another
  agent.
- **Permission levels.** Ask, Auto or Full access, picked per session. A folder you don't trust runs
  at Ask.
- **Review and land.** Files, diffs, commits and pull requests (through `gh`) beside the chat.
- **Tools for agents.** A built-in browser, computer use in the background, and shared plugins.

## What it needs

- A Mac with Apple silicon. Windows and Linux aren't supported yet.
- At least one of Claude Code, Codex and OpenCode. Brigadier's setup can install them.
- `git`, and `gh` for pull requests and sending feedback.

## Build from source

You need Apple's command line tools (`xcode-select --install`), [rustup](https://rustup.rs),
[Node.js](https://nodejs.org) and [pnpm](https://pnpm.io); the versions are pinned in
`rust-toolchain.toml`, `.node-version` and `package.json`.

```sh
pnpm install
pnpm start
```

`pnpm package` builds `out/Brigadier-darwin-arm64/Brigadier.app`, signed ad hoc; computer use
works only in that build. `pnpm gallery` opens the components and `pnpm thread` the thread view on
fake data.

Brigadier keeps its data in `~/Library/Application Support/Brigadier`; set `BRIGADIER_DATA` to use
another folder.

## Report a problem

- A bug or an idea: [open an issue](https://github.com/syncra-studio/brigadier/issues/new/choose), or
  use Send feedback in the app.
- A security problem: privately, as [SECURITY.md](SECURITY.md) says. Never in a public issue.
- Someone's conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules for changes. Third-party code and icons are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
