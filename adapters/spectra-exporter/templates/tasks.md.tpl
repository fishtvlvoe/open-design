## Wave 1 — API Endpoints

Implements the endpoints listed in design.md → **API Contracts** and the
**Connection Map** rows whose status is `missing`.

{{api_tasks}}

## Wave 2 — UI Wiring

Realizes the **UI Component Bindings** in design.md by wiring each component
listed in the **Connection Map** to its endpoint, following
**Decision: Use existing framework routing**.

{{ui_tasks}}

## Wave 3 — Verification

- [ ] 3.1 Run typecheck across all affected packages `[Tool: Copilot]`
- [ ] 3.2 Run existing test suite and confirm no regressions `[Tool: Copilot]`
