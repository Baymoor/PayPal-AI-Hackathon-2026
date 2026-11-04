# Deployment and scheduling

Outings needs four things in production-like hosting (the hackathon demo must stay up, free to use, through **15 Dec 2026**):

1. **Web app** — `npm ci && npm run build`, `npm start`. Runs migrations with `npm run db:migrate` before start.
2. **Postgres 16** — `DATABASE_URL`.
3. **Something that runs due work while every browser is closed** — choose one:
   - a long-running worker process: `npm run worker` (polls every 5 s; safe to run more than one — jobs and payment operations are claimed with `FOR UPDATE SKIP LOCKED` and idempotent), **or**
   - an external scheduler calling `POST /api/cron/tick` (or `GET`) every minute with `Authorization: Bearer $CRON_SECRET` (e.g. Render Cron Job running `curl`, GitHub Actions `schedule`, Vercel Cron).
   A browser countdown is display only; it never triggers settlement.
4. **HTTPS `APP_BASE_URL`** — used to build PayPal `return_url` / `cancel_url` and invitation links.

Optional: a PayPal sandbox **webhook** pointing at `https://<host>/api/webhooks/paypal` with `PAYPAL_WEBHOOK_ID` set (unverified webhooks are rejected; webhooks only trigger re-reading provider state).

## Client IP behind proxies (`TRUSTED_PROXY_HOPS`)

The in-memory rate limiter keys each bucket on client IP + route. Set `TRUSTED_PROXY_HOPS` to the number of reverse proxies in front of the app that **append** to `X-Forwarded-For` (a proxy that overwrites the header with the peer address also counts as one):

| Value | Client IP used for rate limits |
|---|---|
| `0` (default) | None. No forwarding header is trusted (neither `X-Forwarded-For` nor `X-Real-IP`), so every caller shares one bucket per route. Right for local development and for a server that is reached directly; on a hosted deployment it means the limits apply to all users together. |
| `N > 0` | The N-th `X-Forwarded-For` entry counted from the right, i.e. the address the outermost trusted proxy saw. Entries further left come from the client and are ignored. If the header is missing or has fewer than N entries: `X-Real-IP`, then the shared `unknown` key. |

Typical values: `1` behind a single platform load balancer (Render, Fly.io, Heroku-style routers, one nginx/Caddy); `2` with a CDN in front of that load balancer. Too high a value lets clients choose their own key by sending a forged `X-Forwarded-For`; too low a value keys on a proxy address, so users share buckets. To check: send `curl -H 'X-Forwarded-For: 203.0.113.9' https://<host>/...` and look at the header your app receives (platform request logs or a temporary log line). It should read `203.0.113.9, <your IP>[, <proxy IPs>]`, and N is the number of entries from `<your IP>` to the end. The value must be a whole number from 0 to 10; anything else fails at startup.

## Security headers and HSTS

`next.config.ts` and `proxy.ts` set the headers listed in [SECURITY_AND_LIMITATIONS.md](SECURITY_AND_LIMITATIONS.md#http-security-headers). `Strict-Transport-Security` (2 years, `includeSubDomains`) is sent only when `NODE_ENV=production` **and** `APP_BASE_URL` starts with `https://`, so set `APP_BASE_URL` to the public https URL. Because it covers subdomains and browsers cache it, only enable it on a host that will stay https. If TLS is terminated by a platform that already adds HSTS, the duplicate is harmless.

## Payee (`merchants.paypal_merchant_id`)

PayPal orders name a payee only if one is configured. The payee is the outing merchant's `merchants.paypal_merchant_id`, then the deployment-wide `PAYPAL_MERCHANT_ID`. If neither is set, the field is left out and PayPal pays the account that owns the REST app credentials. The same value is checked against the payee on the returned authorization: a mismatch is never admitted and the hold is voided. `npm run db:seed` / `demo:reset` copy `PAYPAL_MERCHANT_ID` into the demo merchant when it is set, and otherwise keep the value already in the column. Use the sandbox business account's **merchant ID**. An email is sent as `payee.email_address` and accepted by the order, but if PayPal reports the payee on the authorization by merchant ID, the check sees a mismatch and voids the hold.

## Render blueprint

`render.yaml` defines a Postgres database, the web service and a background worker. Review plan sizes/costs before applying; Render's hackathon credits are credits, not cash. Secrets marked `sync: false` are entered in the dashboard and never committed.

## Proving the deadline works with every browser closed

1. Create an outing with a deadline a few minutes away (the minimum window is 1 minute).
2. Close all browser tabs.
3. Watch the worker logs (or `SELECT status, cleanup FROM outings`) — the outing settles or cancels at the deadline and the payment operations run.

## Safety

- Sandbox only: the PayPal base URL is hard-coded to `api-m.sandbox.paypal.com`.
- Never enable live credentials, auto-reload or paid tiers without the owner's explicit decision.
- AG Studio licence key: configuration only; follow AG Grid's trial/distribution terms.

## Docker

```bash
docker build -t outings .
```

```bash
docker run --env-file .env.production -p 3000:3000 outings
```

```bash
docker run --env-file .env.production outings npm run worker
```

`tsx` (used by `db:migrate` and `worker`) is a devDependency and is included because the image installs all dependencies.
