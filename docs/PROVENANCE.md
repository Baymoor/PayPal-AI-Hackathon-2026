# Source provenance

## Original code

All source code in this repository was written for Outings during the PayPal AI Hackathon 2026 (from 3 November 2026), by the project owner with AI coding assistance (Claude Code in a hosted cloud session: Opus 5.5 as coordinator plus Opus 5.5, Sonnet 5.5 and Fable 5.1 subagents). It is released under the MIT License (see `LICENSE`).

The Next.js project skeleton was generated with `create-next-app@16.4.5` (MIT) and then rewritten.

## Reference material consulted but NOT copied

| Source | Commit / version | License status | How it was used |
|---|---|---|---|
| https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate | `5de114e` (3 Nov 2026) | **No LICENSE file** found at that commit | Read-only reference for how AG Studio is mounted and how its AI adapter interface is shaped. No files or code were copied. Our dashboard is an original implementation against the installed `ag-studio` / `ag-grid-*` type definitions. |
| PayPal REST OpenAPI specifications (github.com/paypal/paypal-rest-api-specifications) | fetched 4 Nov 2026 | Public API specification | Request/response shapes and error codes; see `docs/research/PAYPAL.md`. |
| AG Studio / AG Grid type definitions in `node_modules` | ag-studio 3.0.0, ag-grid 36.2.0 | Commercial (Studio) / MIT (Grid Community) | API usage; see `docs/research/AG_STUDIO.md`. |

## Third-party runtime dependencies

See `package.json` / `package-lock.json`. Notable licences: Next.js, React, Drizzle ORM, zod, lucide-react, AG Grid Community (MIT); `pg` (MIT); `@anthropic-ai/sdk` (MIT); Fraunces and Inter fonts via Fontsource (SIL OFL 1.1). **AG Studio (`ag-studio`, `ag-studio-react`) and the AG Grid / AG Charts Enterprise packages it depends on are commercial software** used under the sponsor's 45-day evaluation trial; this repository's MIT licence does not cover them and no licence key is committed.

## Design assets

`docs/design/reference/D01–D05` are exploratory images created for the project owner (AI-generated design explorations). They are reference material, not product screenshots. The Claude Design mockup canvas is listed in `docs/design/DESIGN_SYSTEM.md`.
