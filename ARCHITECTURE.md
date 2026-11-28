# Architecture

- Rust owns all logic and data. Only Rust folds events.
- The UI shows the user's action at once and reconciles by id, with defined loading, empty, pending, error and disconnected states.
- Each session's work lives under `sessions/<id>/`. Anything outside it is recorded by exact path and removed on delete.
- Stay provider-neutral: all major AI providers and local models are first-class. Nothing outside one provider's own adapter may name or assume a specific provider.

## Theme

- Add no token without picking it from the old theme or getting the owner's OK.
- The UI/UX reference is the old app (tag `legacy-final`).

## Where code goes

- `crates/`: Rust. `app/main`, `app/ui`: the desktop. `mobile/`: the iPhone app. `relay/`: the relay.
- What both apps use (types, wire, view rules, words, samples): once in `app/shared`, which imports neither app. Views stay per app.
