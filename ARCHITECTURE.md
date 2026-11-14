# Architecture

- Rust owns all logic and data. Only Rust folds events.
- The UI shows the user's action at once and reconciles by id, with defined loading, empty, pending, error and disconnected states.
- Each session's work lives under `sessions/<id>/`. Anything outside it is recorded by exact path and removed on delete.
- Stay provider-neutral: all major AI providers and local models are first-class. Nothing outside one provider's own adapter may name or assume a specific provider.

## Theme

- Add no token without picking it from the old theme or getting the owner's OK.
- The UI/UX reference is the old app (`~/Development/brigadier-ai`, read-only).
