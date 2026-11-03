@AGENTS.md

# Outings — agent notes

- Product spec: docs/CLAUDE_BUILD_BRIEF.md is authoritative for money/consent/deadline rules. docs/HANDOFF_TO_CODEX.md is the live status.
- Money is integer minor units only (lib/domain/money.ts). Never use floats for amounts.
- Settlement/eligibility rules live in lib/domain/policy.ts (pure, tested). AI never decides money.
- Never label FIXTURE payments/AI as real PayPal sandbox or real model output.
- Tests: `npm test` (needs local Postgres, see README). Typecheck: `npm run typecheck`.
