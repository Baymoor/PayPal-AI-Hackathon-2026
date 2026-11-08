# Deployment

The hosted demo runs on **one DigitalOcean server in New York** (US East, between US and EU visitors). Docker Compose runs four containers ([`deploy/vps/`](../deploy/vps)):

| Container | What it does |
|---|---|
| `db` | Postgres 16. Not reachable from the internet. |
| `web` | The Next.js app. Applies database migrations when it starts. |
| `worker` | `npm run worker`: settles due deadlines every 5 s, with every browser closed. No external scheduler is needed. |
| `caddy` | HTTPS with an automatic Let's Encrypt certificate, in front of `web`. |

**Cost:** about $24/month for a Basic droplet (4 GB RAM, 2 vCPU), billed by the hour. It must stay up through **15 Dec 2026**; destroy it afterwards. Claude API usage is the only other cost, capped by a Console spend limit (step 5). PayPal is sandbox only.

Secrets live in one root-only file on the server, `/etc/outings/app.env`. They are never committed, never sent in chat, and never baked into the image.

## 1. SSH key (on your computer)

Check for an existing key:

```bash
ls ~/.ssh/id_ed25519.pub
```

If there is none, create one:

```bash
ssh-keygen -t ed25519 -C outings-server
```

Copy the **public** key (`.pub`) to the clipboard. On Windows (PowerShell):

```powershell
Get-Content $HOME\.ssh\id_ed25519.pub | Set-Clipboard
```

On macOS:

```bash
pbcopy < ~/.ssh/id_ed25519.pub
```

## 2. Create the droplet

In [cloud.digitalocean.com](https://cloud.digitalocean.com), click **Create → Droplets**:

- **Region:** New York (NYC3 or NYC1)
- **Image:** OS → Ubuntu → **24.04 (LTS) x64**
- **Size:** Basic → Regular → **$24/mo: 4 GB / 2 CPUs / 80 GB SSD / 4 TB transfer**
- **Authentication:** SSH Key → **New SSH Key** → paste the public key → give it a name
- Optional and free: tick **Add improved metrics monitoring and alerting**
- **Hostname:** `outings-demo`

Click **Create Droplet** and copy its **IPv4 address**.

## 3. Choose the address

- **No domain:** nothing to do. The setup uses `<ip-with-dashes>.sslip.io` (for example `203-0-113-9.sslip.io`), a free name that resolves to the server's IP.
- **A domain on Cloudflare:** go to **DNS → Records → Add record**: Type `A`, Name `outings`, IPv4 = the droplet IP, Proxy status **DNS only** (grey cloud).
  - Keep it grey. Cloudflare's proxy can inject its own scripts, which the app's strict Content-Security-Policy blocks. It would also replace visitor IP addresses with Cloudflare's, which the rate limits rely on.

## 4. Set up the server

```bash
ssh root@<droplet-ip>
```

On the server:

```bash
git clone https://github.com/Baymoor/PayPal-AI-Hackathon-2026.git /opt/outings && bash /opt/outings/deploy/vps/setup-server.sh
```

With a domain, add it at the end of that command: `bash /opt/outings/deploy/vps/setup-server.sh outings.example.com`.

The script takes about 3 minutes and is safe to run again. It:

- installs Docker
- turns on the firewall, allowing only SSH, HTTP and HTTPS
- switches SSH to key-only logins
- enables automatic security updates
- adds 2 GB of swap
- installs a daily database backup
- creates `/etc/outings/app.env` with freshly generated database, session and merchant passwords

## 5. Add your keys

```bash
nano /etc/outings/app.env
```

Fill in these lines. Values go without quotes. Save with Ctrl+O, Enter, Ctrl+X.

| Line | Where to find it |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox) → **Apps & Credentials** (Sandbox) → your app |
| `PAYPAL_MERCHANT_ID` | developer.paypal.com → **Testing Tools → Sandbox Accounts** → your Business account → Account ID |
| `OUTINGS_ANTHROPIC_API_KEY` | A key from a Claude Console workspace with a spend limit (below) |
| `AG_STUDIO_LICENSE_KEY` | Leave empty (AG Studio trial mode) unless AG Grid supplies a key for judging |

**Claude spend limit.** Anyone can use the public demo, so the key must have a hard cap:

1. [platform.claude.com/settings/workspaces](https://platform.claude.com/settings/workspaces) → **Create workspace** (for example "Outings demo").
2. Select it → **Spend limits** → set a monthly limit (for example $20) and an alert.
3. **Settings → API keys → Create key**, choosing that workspace. The default workspace cannot have a spend limit.

When the limit is reached, Claude calls fail and the app says so plainly; it never labels fallback output as Claude:

- the brief shows "could not be read automatically"
- the venue shortlist falls back to the rule-based ranking, labelled Fixture
- plan drafting and the dashboard question report that the AI could not answer, and change nothing

The per-visitor rate limits (`lib/rate-limit.ts`) still apply underneath.

## 6. Deploy

```bash
bash /opt/outings/deploy/vps/deploy.sh
```

The first build takes about 5 minutes. The script waits until `https://<site>/api/health` answers. Then load the demo merchant, venues and demo outings:

```bash
curl -fsS -X POST https://<site>/api/demo/reset
```

Check the modes. Expect `"db":"ok"`, `"paymentMode":"PAYPAL_SANDBOX"`, `"aiMode":"ANTHROPIC"`, `"sessionSecretIsEphemeral":false`:

```bash
curl -fsS https://<site>/api/health
```

After any change to `/etc/outings/app.env`, run `deploy.sh` again to apply it.

## 7. PayPal webhook

1. developer.paypal.com → **Apps & Credentials** (Sandbox) → your app → **Sandbox Webhooks → Add Webhook**.
2. URL: `https://<site>/api/webhooks/paypal`. Events: all **Checkout order**, **Payment authorization** and **Payment capture** events. Save.
3. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID=` in `/etc/outings/app.env`, then run `deploy.sh`. `/api/health` now shows `"webhookVerification":true`.

Unverified webhooks are rejected. A verified webhook only makes the app re-read the payment from PayPal.

## 8. Prove a deadline settles with every browser closed

From any computer, with no browser open:

```bash
curl -fsS -X POST https://<site>/api/demo/scenario -H 'content-type: application/json' -d '{"kind":"holdout","deadlineSeconds":60}'
```

Copy the `outingId` from the response. About 70 seconds later:

```bash
curl -fsS "https://<site>/api/demo/scenario?outingId=<outingId>"
```

Expect `"status":"CANCELLED"` and `"cleanup":"COMPLETE"`, with every hold voided by the worker. The `capture-failure` scenario also runs on its own: captures, a declined capture, refunds and voids.

For the happy path, create a `settle-soon` scenario on `/demo` and commit as Noor. Then close the browser before the deadline and check it with the same `curl`; it should be `CONFIRMED`.

## Running it until 15 Dec

All commands run on the server as root. `c` is short for the Compose command:

```bash
cd /opt/outings && alias c='docker compose -f deploy/vps/compose.yaml --env-file /etc/outings/app.env'
```

| Task | Command |
|---|---|
| Deploy the latest `main` | `bash deploy/vps/deploy.sh` |
| Roll back to a commit or tag | `bash deploy/vps/deploy.sh <commit>` |
| Container status | `c ps` |
| Logs | `c logs -f --tail=100 web worker` |
| Restart the app | `c restart web worker` |
| Backups | `ls /var/backups/outings` (daily, kept 14 days) |

- **Restoring a backup** into the running database: `gunzip -c /var/backups/outings/outings-<date>.sql.gz | docker exec -i outings-db-1 psql -U outings -d outings`.
  - The dumps are plain SQL without `DROP` statements, so restore into an empty database: stop `web` and `worker`, then recreate the `db` volume first.
- **Reboots:** containers restart on their own.
- **After 15 Dec 2026:** DigitalOcean → the droplet → **Destroy**. Billing stops then.

## Reference

### Client IP behind proxies (`TRUSTED_PROXY_HOPS`)

The in-memory rate limiter keys each bucket on client IP + route. `TRUSTED_PROXY_HOPS` is the number of reverse proxies in front of the app that append to `X-Forwarded-For`; a proxy that overwrites the header counts as one.

On the VPS it is `1`: Caddy discards any `X-Forwarded-For` a client sends and sets the real client address.

| Value | Client IP used for rate limits |
|---|---|
| `0` (default) | None. No forwarding header is trusted, so every caller shares one bucket per route. Right for local development. |
| `N > 0` | The N-th `X-Forwarded-For` entry from the right: the address the outermost trusted proxy saw. If the header has fewer entries, `X-Real-IP`, then a shared `unknown` key. |

Too high a value lets clients pick their own key with a forged header. Too low keys on a proxy address, so users share buckets. The value must be a whole number from 0 to 10; anything else fails at startup. With Cloudflare's proxy turned on (orange cloud) it would be `2`, and Caddy would need Cloudflare's address ranges as `trusted_proxies`.

### Security headers and HSTS

`next.config.ts` and `proxy.ts` set the headers listed in [SECURITY_AND_LIMITATIONS.md](SECURITY_AND_LIMITATIONS.md#http-security-headers).

`Strict-Transport-Security` (2 years, `includeSubDomains`) is sent only when `NODE_ENV=production` **and** `APP_BASE_URL` starts with `https://`. It is evaluated at build time (`next.config.ts`) and at runtime (`proxy.ts`), so the Docker image, which is built without `APP_BASE_URL`, still sends it. Because browsers cache it for the host and its subdomains, only enable it on a host that stays on HTTPS.

### Payee (`merchants.paypal_merchant_id`)

The PayPal payee is the outing merchant's `merchants.paypal_merchant_id`, then the deployment-wide `PAYPAL_MERCHANT_ID`. Without either, the field is left out and PayPal pays the account that owns the REST app credentials.

The same value is checked against the payee on the returned authorization; a mismatch is never admitted and the hold is voided. The demo reset (`POST /api/demo/reset`, `npm run db:seed`) copies `PAYPAL_MERCHANT_ID` into the demo merchant when it is set. Use the sandbox Business account's **merchant ID**, not its email: if PayPal reports the payee by merchant ID, an email causes a mismatch and the hold is voided.

### Running due work elsewhere

Settlement needs something that runs due work while every browser is closed. A browser countdown is display only; it never triggers settlement. Two options:

- **A long-running worker:** `npm run worker` (what the VPS does). It is safe to run more than one: jobs and payment operations are claimed with `FOR UPDATE SKIP LOCKED` and are idempotent.
- **An external scheduler:** on platforms without background processes, call `POST /api/cron/tick` every minute with `Authorization: Bearer $CRON_SECRET`. Without `CRON_SECRET` that endpoint is off in production.

[`render.yaml`](../render.yaml) is an alternative, paid Render setup: a Starter web service, a worker and Basic Postgres. Render's free plan has no workers and no pre-deploy step, and its free Postgres expires after 30 days.

### Docker without Compose

```bash
docker build -t outings .
```

```bash
docker run --env-file .env.production -p 3000:3000 outings
```

```bash
docker run --env-file .env.production outings npm run worker
```

The image includes devDependencies because `db:migrate` and `worker` run through `tsx`.

## Safety

- Sandbox only: the PayPal base URL is hard-coded to `api-m.sandbox.paypal.com`.
- The hosted demo runs in judge mode (`DEMO_FIXTURES_ENABLED=true`). Anyone in an outing can act as anyone else in it, the merchant dashboard has a one-click demo sign-in, and anyone can reset the demo outings. Never put real personal data or live credentials on it.
- Never enable live credentials or paid add-ons without the owner's explicit decision.
