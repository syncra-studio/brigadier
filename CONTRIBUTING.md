# Contributing

## Research and decisions

- Research comes first and is mandatory. Find facts and work out how to build things yourself; don't ask the user.
- Ask the user only about product and technical direction, and architecture that shapes them. Decide low-level code matters yourself.
- Research options and how rivals do it and why; take their simple way, add only where we beat them. Recommend one plainly.
- Never reverse engineer closed-source apps. Use only public docs and open-source code.

## Ponytail

- Use the ponytail skill for all work. Where it isn't installed, follow its core rules: the smallest complete change, reuse before writing, nothing nobody asked for.
- Write no tests, even where ponytail asks for one.

## Done

- No tests, ever, except `drills/drill.mjs` before a release or a provider CLI change. Done means the owner has seen it running.
- Show looks on screen before asking the owner to choose between them.

## Git

- No agent attribution anywhere: no co-author or generated-with lines. Commit only under the owner's git identity.

## No litter

- Never save to memory in this project unless the owner asks. If something is truly important, ask first.
- Leave no plans, research, reports or stray files. Only the .md files `scripts/limits` allows.

