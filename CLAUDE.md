@AGENTS.md

# Outings — agent notes

- Product spec: docs/PRODUCT_SPEC.md (condensed from the owner's CLAUDE_BUILD_BRIEF.md) is authoritative; docs/CONTRACTS.md defines module ownership and APIs for money/consent/deadline rules. README.md and docs/JUDGE_GUIDE.md describe the current state.
- Money is integer minor units only (lib/domain/money.ts). Never use floats for amounts.
- Settlement/eligibility rules live in lib/domain/policy.ts (pure, tested). AI never decides money.
- Never label FIXTURE payments/AI as real PayPal sandbox or real model output.
- Tests: `npm test` (needs local Postgres, see README). Typecheck: `npm run typecheck`.
