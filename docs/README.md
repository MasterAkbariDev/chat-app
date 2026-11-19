# Chat — Architecture & Refactor Documentation

> These audits and plans document earlier stages of development. Consult the component READMEs and current code for present behavior.

This folder is the output of a full-application discovery, audit, and refactor-planning
pass over the two repositories:

| Repo | Path | Stack |
|------|------|-------|
| Backend | `../backend` | NestJS · MongoDB (Mongoose) · Socket.IO · JWT |
| Frontend | `../frontend` | Next.js · React · Tailwind CSS · Socket.IO |

Everything here is **evidence-based**: every feature, endpoint, and event is traced to a
file in one of the two repos. Where behaviour could not be confirmed from code it is
marked `UNKNOWN`. Where a decision needs the product owner it is marked
`REQUIRES PRODUCT DECISION`.

## Reading order

0. **[DECISIONS.md](./DECISIONS.md)** — the product owner's answers to the open questions (2026-09-02). These override the "forks" in the refactor specs.
0b. **[plans/](./plans/)** — phased delivery plans per project: [backend](./plans/BACKEND_PLAN.md), [frontend web](./plans/FRONTEND_PLAN.md), [Flutter app](./plans/FLUTTER_APP_PLAN.md), [admin panel](./plans/ADMIN_PANEL_PLAN.md), [config bot (deferred)](./plans/CONFIG_BOT_PLAN.md). Cross-project timeline in [plans/README.md](./plans/README.md).
1. **[PROJECT_BLUEPRINT.md](./PROJECT_BLUEPRINT.md)** — executive summary; start here.
2. **[FEATURE_INVENTORY.md](./FEATURE_INVENTORY.md)** — every discovered feature.
3. **[api/API_INVENTORY.md](./api/API_INVENTORY.md)** — every REST endpoint.
4. **[REALTIME_ARCHITECTURE.md](./REALTIME_ARCHITECTURE.md)** — every WebSocket event.
5. **[DATABASE_AUDIT.md](./DATABASE_AUDIT.md)** — collections, indexes, data-minimisation.
6. **[BACKEND_ARCHITECTURE.md](./BACKEND_ARCHITECTURE.md)** — module map + problems.
7. **[FRONTEND_ARCHITECTURE.md](./FRONTEND_ARCHITECTURE.md)** — route/component/state map + problems.
8. **[FEATURE_DEPENDENCY_MAP.md](./FEATURE_DEPENDENCY_MAP.md)**
9. **[performance/PERFORMANCE_AUDIT.md](./performance/PERFORMANCE_AUDIT.md)**
10. **[SECURITY_AUDIT.md](./SECURITY_AUDIT.md)**
11. **[ROUTES.md](./ROUTES.md)** — current + proposed routes/screens.
12. **[INFORMATION_ARCHITECTURE.md](./INFORMATION_ARCHITECTURE.md)**
13. **[DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)**
14. **[ARCHITECTURE_RULES.md](./ARCHITECTURE_RULES.md)**
15. **[REFACTOR_PLAN.md](./REFACTOR_PLAN.md)** — phased roadmap.
16. **[OPTIMIZATION_BACKLOG.md](./OPTIMIZATION_BACKLOG.md)**
17. **[THINGS_TO_REMOVE.md](./THINGS_TO_REMOVE.md)**
18. **[refactors/](./refactors/)** — one spec per feature.
19. **[flutter/FLUTTER_PLAN.md](./flutter/FLUTTER_PLAN.md)**
20. **[OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md)** — needs product/team answers.

## Status of this pass

- [x] Technology inventory
- [x] Feature discovery (REST, WS, DB, UI)
- [x] Route discovery
- [x] API discovery
- [x] WebSocket event discovery
- [x] Database architecture
- [x] Frontend / backend architecture maps
- [x] Feature dependency map
- [x] UX / performance / security audit
- [x] Feature inventory + per-feature refactor specs
- [x] Route / information architecture / design system
- [x] Phased refactor plan + optimization backlog
- [x] Flutter architecture + parity plan
- [x] Open questions
