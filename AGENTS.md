# Agent instructions

## Research and decisions

- Research comes first and is mandatory. Find facts and work out how to build things yourself; don't ask the user.
- Ask the user only about product and technical direction, and architecture that shapes them. Decide low-level code matters yourself.
- Research every option before presenting it. Recommend one, in plain language, with its real trade-offs.
- A disassembler may be used on installed desktop apps, for learning only. Commit none of their code, assets or findings.

## Ponytail

- Use the ponytail skill for all work. Where it isn't installed, follow its core rules: the smallest complete change, reuse before writing, nothing nobody asked for.
- Write no tests, even where ponytail asks for one. This rule overrides it.

## Done

- No tests, ever. Done means the owner has seen it running.
- Show looks on screen before asking the owner to choose between them.

## Git

- No agent attribution anywhere: no co-author or generated-with lines. Commit only under the owner's git identity.

## No litter

- Never save to memory in this project unless the owner asks. If something is truly important, ask first.
- Leave no plans, research, reports or stray files. Only the .md files `scripts/limits` allows.

## Architecture

- Rust owns all logic and data. Only Rust folds events.
- The UI shows the user's action at once and reconciles by id, with defined loading, empty, pending, error and disconnected states.
- Each session's work lives under `sessions/<id>/`. Anything outside it is recorded by exact path and removed on delete.
- Stay provider-neutral: all major AI providers and local models are first-class. Nothing outside one provider's own adapter may name or assume a specific provider.

## Theme

- Add no token without picking it from the old theme or getting the owner's OK.
- The UI/UX reference is the old app (`~/Development/brigadier-ai`, read-only).
