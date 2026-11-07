---
goal: Add a Beyla/Istio metrics-source selector to the topology toolbar, and make rate rendering Metric-aware
version: 1
date_created: 2026-11-07
last_updated: 2026-11-07
owner: rafaelpissolatto
status: 'Planned'
tags: [feature, istio, frontend, ui]
persona: Senior SRE — UI & Topology Rendering
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Implements GitHub issue #61 (parent #59). Depends on #60 / `plan/feature-istio-source-1.md` for the real `/api/sources` shape and the `Flow.rate`/`Flow.metric` contract (ADR 0002, `docs/adr/0002-istio-telemetry-source.md`) — build the selector component and `Metric`-aware formatting now against a mocked `/api/sources` response and a hand-written `Flow` fixture with `metric: "requests"`, then swap in the real backend once #60 merges.

## 1. Requirements & Constraints

- **REQ-001**: A new toolbar control lets the user pick a source, only offering options `/api/sources` actually returns, defaulting to its `default` field.
- **REQ-002**: Changing the source re-fetches `/api/topology` with `&source=<selected>`, the same way changing namespace/protocol does today in `App.tsx` — same refresh/pause and error-state behavior, no special-casing.
- **REQ-003**: Every place that currently reads `bytesPerSecond` reads `rate`/`metric` instead, and formats/labels per `metric`: `"bytes"` keeps today's byte-rate formatting (`web/src/lib/format.ts`); `"requests"` gets a requests/sec label (e.g. `"12 req/s"`).
- **REQ-004**: Edge thickness scaling (wherever it currently derives from `bytesPerSecond`) uses `rate` regardless of `metric` — don't try to make bytes and requests visually comparable in magnitude, just don't crash/NaN when the unit changes.
- **REQ-005**: No UI copy, legend, or tooltip calls a node "Service" for an Istio-sourced graph, matching the existing Beyla-sourced rule (`CONTEXT.md`).
- **GUD-001**: New component follows `web/src/components/ProtocolFilter.tsx`'s structure/styling conventions for toolbar controls.
- **VERIFY-001 (global instruction)**: Verified with Playwright (Chromium) against the real dev cluster before calling this done — golden path, both themes, and the empty/no-data state for a source with nothing to show.

## 2. Implementation Phases

### Phase 1 — Selector component (can start immediately, mocked backend)

- GOAL-001: `SourceSelector` renders and switching it calls back with the chosen source; wired against a mocked `/api/sources` response.

| Task | Description |
|------|-------------|
| TASK-001 | Create `web/src/components/SourceSelector.tsx` modeled on `ProtocolFilter.tsx`: renders the sources list, highlights the active one, calls an `onChange` prop on selection. |
| TASK-002 | Add a sources fetch to `web/src/lib/topology.ts` (mirroring the existing namespaces/protocols fetch), typed against the `/api/sources` shape from ADR 0002 / plan `feature-istio-source-1.md` REQ-006. |
| TASK-003 | Wire `SourceSelector` into `App.tsx`'s toolbar and state, alongside the existing namespace/protocol filter state, triggering a `/api/topology` re-fetch with `&source=` on change. |

### Phase 2 — `Metric`-aware rendering

- GOAL-002: Every rate display and edge-thickness calculation is `metric`-aware; nothing assumes bytes.

| Task | Description |
|------|-------------|
| TASK-004 | `web/src/lib/format.ts`: add a requests/sec formatter alongside the existing byte-rate one; add a small `formatRate(rate, metric)` dispatcher other call sites use instead of calling the byte formatter directly. |
| TASK-005 | Update `FlowsTable.tsx`, `FlowDetailPanel.tsx`, and the edge label/width logic (check `FloatingEdge.tsx` and wherever `bytesPerSecond` currently feeds thickness) to read `rate`/`metric` via `formatRate`. |
| TASK-006 | Grep the frontend for every remaining `bytesPerSecond` reference and confirm each is migrated — this field is being removed from the API, not kept alongside the new one. |

### Phase 3 — Verification

| Task | Description |
|------|-------------|
| TASK-007 | Against the dev cluster (once #60 is available): verify the selector lists real sources, switching re-renders the graph, HTTP/gRPC edges show request rate, TCP edges show byte rate, and the no-data empty state appears for a source with nothing to show — in both themes, via Playwright. |

## 3. Acceptance Criteria (from issue #61)

- [ ] Selector shows only sources `/api/sources` reports, defaults correctly.
- [ ] Switching source re-queries and re-renders, matching existing filter behavior.
- [ ] Request-rate vs. byte-rate labels are never swapped.
- [ ] Verified in a real browser, both themes, golden path + empty state.
