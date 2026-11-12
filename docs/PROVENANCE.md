# Source provenance

## Original code

All source code here was written for Outings during the PayPal AI Hackathon 2026 (from 3 November 2026) and is released under the MIT License (see `LICENSE`).

The project owner directed it, with AI coding help from Claude Code:

- **A hosted cloud session:** Opus 5.5 as coordinator, plus Opus 5.5, Sonnet 5.5 and Fable 5.1 subagents.
- **Claude Code in the Claude desktop app** on the owner's machine, from 7 Nov 2026: an Opus 5.5 session with a Fable 5.1 subagent, and a separate UI/UX session that ran a Fable 5.1 design critique.
- **Fable 5.2 sessions** in Claude Code from 10 Nov 2026, named in the commits' co-author trailers.
- **Claude Design** for the UI mockups the consumer screens were built from.

No other AI coding tool was used; OpenAI Codex never was.

The full disclosure is in [HACKATHON_SUBMISSION.md](HACKATHON_SUBMISSION.md#ai-tool-disclosure).

The Next.js project skeleton was generated with `create-next-app@16.4.5` (MIT) and then rewritten.

## Reference material consulted but NOT copied

| Source | Commit / version | License status | How it was used |
|---|---|---|---|
| https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate | `5de114e` (3 Nov 2026) | **No LICENSE file** found at that commit | Read-only reference for how AG Studio is mounted and how its AI adapter interface is shaped. No files or code were copied. Our dashboard is an original implementation against the installed `ag-studio` / `ag-grid-*` type definitions. |
| PayPal REST OpenAPI specifications (github.com/paypal/paypal-rest-api-specifications) | fetched 4 Nov 2026 | Public API specification | Request/response shapes and error codes; see `docs/research/PAYPAL.md`. |
| AG Studio / AG Grid type definitions in `node_modules` | ag-studio 3.0.0, ag-grid 36.2.0 | Commercial (Studio) / MIT (Grid Community) | API usage; see `docs/research/AG_STUDIO.md`. |

## Third-party runtime dependencies

See `package.json` / `package-lock.json`. Notable licences: Next.js, React, Drizzle ORM, zod, lucide-react, AG Grid Community (MIT); `pg` (MIT); `@anthropic-ai/sdk` (MIT); Fraunces and Inter fonts via Fontsource (SIL OFL 1.1).

**AG Studio (`ag-studio`, `ag-studio-react`) and the AG Grid / AG Charts Enterprise packages it depends on are commercial software**, used under the sponsor's 45-day evaluation trial (the live demo runs in trial mode, with no licence key yet). This repository's MIT licence does not cover them, and no licence key is committed.

## Design assets

`docs/design/reference/D01–D05` are exploratory images created for the project owner (AI-generated design explorations). They are reference material, not product screenshots. The Claude Design mockup canvas is listed in `docs/design/DESIGN_SYSTEM.md`.
