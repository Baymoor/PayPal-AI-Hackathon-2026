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
