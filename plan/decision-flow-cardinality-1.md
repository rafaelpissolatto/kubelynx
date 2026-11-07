---
goal: Decide and record (as an ADR) how KubeLynx bounds flow-metric cardinality on large clusters
version: 1
date_created: 2026-11-07
last_updated: 2026-11-07
owner: rafaelpissolatto
status: 'Planned'
tags: [decision, adr, cardinality, prometheus, backend]
persona: Senior SRE — Telemetry & Backend
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Implements GitHub issue #48 (parent #1; follow-up to #38). Issue #48 itself lays out five candidate options (ports-as-a-flag, inter-zone metrics, collector-side aggregation, namespace-scoped collection, a tunable port filter) with measured cardinality numbers from the dev cluster. This is a decision/ADR task, not a code-first task — the deliverable is `docs/adr/0003-flow-cardinality-profile.md` (next free ADR number; confirm `docs/adr/` hasn't gained 0003 from other work first) plus any follow-up issues the decision implies.

Note the overlap with the Istio work (#59/#60): once an Istio source exists, its own cardinality profile (`istio_requests_total`/`istio_tcp_*` are already low-cardinality by Istio's default labels — no raw port/ephemeral-port problem like Beyla's) should be mentioned in the ADR so the two don't get decided inconsistently later, but this plan's scope is Beyla's cardinality problem as #48 describes it — don't block on #60 landing.

## 1. Requirements & Constraints

- **REQ-001**: Produce an ADR answering #48's four open questions: default profile for small vs. large clusters; whether request-direction-only byte volume (today's stopgap) is acceptable or full fidelity (option 3, collector aggregation) is needed; where the chosen profile(s) live (dev manifests only, Helm chart values, user-facing docs); whether KubeLynx should warn when flow series exceed a budget.
- **REQ-002**: The ADR must choose from, or explicitly combine, #48's five options — don't introduce a sixth without first checking why none of the five fit.
- **REQ-003**: File follow-up implementation issue(s) for whichever option(s) the ADR picks, each sized like the existing backend-persona issues (concrete files/functions, acceptance criteria, testing convention per `GUD-001` below) — this plan's own job is the decision, not the implementation.
- **GUD-001**: Any resulting implementation issue keeps the project's seam-level testing convention (assert on `Graph`/response shape from canned Prometheus data, not PromQL internals).
- **CON-001**: Whatever's decided must keep KubeLynx's "pure consumer, no new RBAC/agents" posture — e.g. option 3 (collector aggregation) adds an OpenTelemetry Collector component to the *operator's* stack, not to KubeLynx itself; the ADR should be explicit about which side of that line each option sits on.

## 2. Implementation Phases

### Phase 1 — Decide

- GOAL-001: A recorded decision, not just a restated option list.

| Task | Description |
|------|-------------|
| TASK-001 | Re-run or sanity-check #48's dev-cluster cardinality measurements (`beyla_network_flow_bytes_total` series count with/without the port filter) against current `main`, since #39/#46/#51 and other changes since #48 was filed could have shifted the dev setup. |
| TASK-002 | Decide the default profile(s) for small vs. large clusters, and answer #48's other three open questions (REQ-001). |
| TASK-003 | Write `docs/adr/000N-flow-cardinality-profile.md` (short form, matching `0001-single-image-packaging.md`'s length/style — a decision and its rejected alternatives, not a design doc) recording the above, including the one-paragraph note on Istio's comparatively low default cardinality (CON note, not a commitment to implement anything for Istio here). |

### Phase 2 — Follow-through

- GOAL-002: The decision is actionable without re-deriving it.

| Task | Description |
|------|-------------|
| TASK-004 | File the follow-up implementation issue(s) the ADR implies (REQ-003), labeled `ready-for-agent` if fully specified or `needs-triage` if a spike is still needed first. |
| TASK-005 | `gh issue comment 48` linking the new ADR, then close #48 per the issue tracker convention (`gh issue close 48 --comment "..."`) once TASK-003/004 are done — #48's own acceptance criteria are "a decision recorded as an ADR" + "follow-up issues filed," both satisfied at that point. |

## 3. Acceptance Criteria (from issue #48)

- [ ] A decision recorded as an ADR in `docs/adr/`, covering default profile(s) and the flags/profiles to support.
- [ ] Follow-up implementation issues filed for the chosen option(s).
