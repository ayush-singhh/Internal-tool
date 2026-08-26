<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Carrier Management Hub

Before writing code in this repo, read:

- `PRD.md` — what we are building and the business rules
- `Architecture.md` — stack, data model and the decisions behind them
- `AI Rules.md` — **binding conventions**: dependency policy, data-integrity rules,
  security requirements, server/client boundary
- `Plan.md` — phase status; update it in the same change that completes a phase
