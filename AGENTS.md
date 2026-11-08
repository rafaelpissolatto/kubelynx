## Agent skills

### Issue tracker

Issues live in GitHub Issues (`rafaelpissolatto/kubelynx`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels, used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Team personas

When work is split across parallel agents, each one adopts a persona: a Lead (architecture, ADRs, plan docs, cross-cutting review) plus two Senior SREs with disjoint ownership (backend/telemetry vs. frontend/rendering). Seniors always work in a git worktree on a branch named `<type>/<issue#>-<slug>`, and they message each other and the lead (`swe-lead`) at start, on shared-file changes and when ready for review. The lead owns issue updates and reviews. See `docs/agents/personas.md`.
