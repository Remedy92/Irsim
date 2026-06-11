# AGENTS.md

**`CLAUDE.md` is the single source of truth for working in this repository** — commands,
architecture, physics-layer map, and gotchas all live there. Read it first.

This file exists so WARP (warp.dev) and other agents that look for `AGENTS.md` get pointed at
the same guidance. Do not duplicate content here; update `CLAUDE.md` instead.

Quick start (full detail in `CLAUDE.md`):

```bash
npm install
npm run dev          # Vite on 0.0.0.0:5173
npm run typecheck
npm test             # vitest run
npm run build        # typecheck then build — the release gate
```

There is no lint script; typecheck + tests are the verification baseline. CI runs
`npm ci && npm run typecheck && npm test && npm run build` (Node 22) — match it before
concluding a change is ready.
