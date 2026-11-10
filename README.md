# RealPay

**Pay for the work that is done, not the work that is promised.**

RealPay funds a project milestone by milestone with PayPal. When the
homeowner funds a milestone, the money is authorized but not sent. The
contractor uploads proof of the finished work. An AI inspector checks that
proof against the milestone's checklist, and only then does PayPal capture
and pay out. Anything the AI is unsure about goes to a person, never
straight to the contractor.

[![Payments via PayPal (sandbox)](https://img.shields.io/badge/payments-PayPal%20sandbox-003087)](https://developer.paypal.com/tools/sandbox/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> Built for the PayPal AI Hackathon. RealPay is an independent project and
> is not affiliated with, endorsed by or sponsored by PayPal. It runs
> against the **PayPal sandbox only**: the server refuses to start with
> live credentials.

## Why

A contractor took €3,000 upfront for a renovation, started demolition and
never came back. Paying everything upfront protects the contractor. Paying
everything at the end protects the client. Neither works.

Banks solved this long ago for construction loans: the money is released
in stages, each one after an inspector signs off the work. RealPay brings
that discipline to a €3,000 bathroom, with an AI inspector and a PayPal
authorization on the money.

## How the money moves

Each milestone is one PayPal order with `intent: AUTHORIZE`, split into
two parts.

```text
 Homeowner                     PayPal (authorization)            Payees
 ─────────                     ──────────────────────            ──────
 Funds milestone  ──────────▶  upfront + held authorized
 (PayPal wallet or card)            │
                                    ├── upfront captured now ──▶ Supplier
                                    │   (materials, so work can start)
                                    │
 Contractor uploads proof           │
        │                           │
        ▼                           │
 Prechecks ─▶ AI inspector ─▶ Release policy
                                    │
                         release ───┼── held captured ─────────▶ Contractor
                                    │   minus 5% retention
                                    │
                         30 days ───┴── retention ─────────────▶ Contractor
                         (or refunded to the homeowner on a problem)

 Cancel before release  ─────▶  held part voided, never charged
                                (the upfront already paid stays with the supplier)
```

- **Upfront part** goes straight to the supplier, so the contractor never
  holds the homeowner's materials money.
- **Held part** stays authorized ("authorised · not yet charged") until
  the work is proven. A PayPal authorization lasts 29 days. If it was paid
  with a PayPal wallet, the homeowner can renew it once, from day 4.
- **Retention** (5% for 30 days in the renovation template) is a snagging
  retention: it is paid out at the end of that period, or refunded if a
  problem is reported.
- **The schedule follows the money.** Releasing a milestone early or late
  moves the dates of every milestone after it.
- **Idempotent by design.** Every PayPal call carries a deterministic
  `PayPal-Request-Id` and every payout a deterministic `sender_batch_id`,
  so a retry can never pay twice.

## How a proof is judged

Proof goes through three layers, cheapest first.

1. **Prechecks** (free, deterministic). Hard flags reject the proof
   outright: wrong file type, a duplicate of an earlier proof (SHA-256),
   instructions hidden in the note, or GPS far from the site. Soft flags
   force human review: edited with software, taken outside the milestone
   window, no capture date, no location. A document (PDF certificate,
   invoice) always carries a soft flag: the AI reads it, the homeowner
   signs it off.
2. **AI inspector.** A vision model scores the photo or document against
   the milestone checklist and returns a strict JSON verdict
   (`met`, `confidence`, per-item findings), validated with zod. Providers
   are tried in order (Gemini, then OpenRouter, both on free tiers). Two
   caps protect the shared quota: a daily cap for the whole server
   (`AI_DAILY_CAP`) and one per project (`AI_CALLS_PER_PROJECT_PER_DAY`,
   10 by default). If a cap is reached or every provider is down, the proof
   goes to a person.
3. **Release policy.** A pure, fully tested function decides: release
   only when the checklist is met, confidence is at least the template's
   minimum (0.8), no flag was raised, no dispute is open, and the amount is
   under the auto-release cap. Everything else is `review` or `reject`.

The AI never moves money on its own above the cap. Every decision, with
its reason, is written to an append-only, tamper-evident (hash-chained)
ledger that both
parties can read and export as an evidence pack.

## One engine, many niches

A niche is a JSON template in
[`server/node/src/templates`](server/node/src/templates): milestones,
checklists, the upfront/held split, retention, governance limits and the
site location. Two ship today:

| Template     | Example                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| `renovation` | Bathroom renovation: materials upfront, labour held on proof                               |
| `rental`     | First booking with an unknown host: paid once the keys and the apartment match the listing |

Adding a niche means adding a file. The engine does not change.

## Unhappy paths that are handled

| Situation                          | What RealPay does                                  |
| ---------------------------------- | -------------------------------------------------- |
| Card declined while funding        | Clear 402 error, nothing authorized                |
| Reused photo or wrong file type    | Rejected by prechecks before any AI call           |
| Photo of the wrong room            | AI finds the checklist not met, proof rejected     |
| Certificate or other document      | AI reads it, the homeowner always signs it off     |
| Prompt injection in the proof note | Hard flag, rejected                                |
| AI unsure or unavailable           | Sent to the homeowner for review                   |
| Homeowner rejects the proof        | Contractor can submit new proof, funds stay held   |
| Supplier payout fails              | Retry with the same batch id, no double payment    |
| Authorization about to expire      | Homeowner reauthorizes the held part               |
| Project cancelled mid-way          | Unreleased holds are voided, never charged         |
| One project floods the AI          | Per-project daily cap, then manual review          |
| Dispute opened                     | Releases frozen, evidence pack submitted to PayPal |
| Forged webhook                     | Rejected by `verify-webhook-signature`             |

## Architecture

```text
client/                     Static web app (no build step)
  index.html, project.html  Home and project pages
  js/paypalCheckout.js      PayPal JS SDK v6: PayPal, Pay Later, messages
server/node/
  src/app.ts                Express 5 app: helmet CSP, rate limits, static
  src/routes/               HTTP handlers (thin) for projects and PayPal
  src/domain/               Milestone engine, schedule, money, policy
  src/verification/         Prechecks, AI providers, verdict schema
  src/paypal/               Gateway over the PayPal Server SDK
  src/customApiEndpoints/   Payouts, disputes, webhooks (REST, no SDK yet)
  src/audit/                Hash-chained ledger
  src/db/                   SQLite (better-sqlite3)
docs/
  openapi.yaml              API reference
  postman/                  Postman collection and environment
```

The layout, route naming and conventions follow PayPal's public
[integration samples](https://github.com/paypal-examples): TypeScript ESM,
Express 5, `@paypal/paypal-server-sdk`, zod for input, `dotenvx` for
configuration, vitest and supertest for tests.

**Access model.** There are no accounts. Creating a project returns two
secret links, one for the homeowner and one for the contractor. The token
is sent as `Authorization: Bearer <token>`; only its SHA-256 is stored and
it is compared in constant time.

## Run it locally

You need Node.js 20 or newer and a free
[PayPal developer](https://developer.paypal.com) account.

1. In the developer dashboard, create a **sandbox** REST app and two
   sandbox business accounts (supplier and contractor).
2. Copy the settings file and fill it in:

   ```bash
   cp .env.sample .env
   ```

   AI keys are optional. Without them every proof goes to manual review.
   [Gemini](https://aistudio.google.com) and
   [OpenRouter](https://openrouter.ai) both have free tiers.

3. Install and start:

   ```bash
   cd server/node
   npm install
   npm start
   ```

4. Open <http://localhost:8080>, pick a template and create a project.

With `DEMO_MODE=true` the project page also shows a sandbox test-card
button, an "advance clock" control to skip ahead in time, and a simulated
dispute. Never enable it on a public deployment you do not control.

### Docker

```bash
docker build -t realpay .
docker run --rm -p 8080:8080 --env-file .env -v realpay-data:/data realpay
```

Node 24 runs the TypeScript sources directly, so the image has no build
step and no TypeScript tooling.

### Webhooks

Point a sandbox webhook at `https://<your-host>/paypal-api/webhooks`,
subscribe to `PAYMENT.PAYOUTSBATCH.*`, `PAYMENT.PAYOUTS-ITEM.*` and
`CUSTOMER.DISPUTE.*`, and put its id in `PAYPAL_WEBHOOK_ID`. Events are
verified with PayPal before they can change anything.

Behind a reverse proxy (Render, Fly, a load balancer), set `TRUST_PROXY=1`
so rate limits see the real client address. Leave it at `0` otherwise: a
client could fake its address with `X-Forwarded-For`.

## Path to production

The sandbox build uses the Payouts API as a stand-in to pay the supplier
and the contractor from the platform's account. RealPay is not an escrow
service and does not hold anyone's money. The labour part is a PayPal
authorization: the buyer's funds are reserved, not charged. A production
version would onboard each contractor and supplier as a seller with
[PayPal Multiparty](https://developer.paypal.com/docs/multiparty/) and
capture straight to them, with the platform fee taken at capture. The
engine does not change: only the gateway's capture and payout calls do.

Known limits, stated plainly:

- PayPal guarantees authorized funds only for the 3-day honor period. A
  capture later in the 29-day window can still fail if the buyer's balance
  or card changed. RealPay then reports PayPal's error and nothing is
  released or paid out.
- In this sandbox build the 5% retention is captured into the platform
  account for 30 days. Holding captured third-party money is not something
  a production build should do. There, the retention becomes a delayed
  disbursement to the contractor's Multiparty seller account (PayPal
  supports payment holds there), so the platform never holds it.
- The fee totals count PayPal capture fees only. Payout fees, and the
  capture fee that is not returned on a retention refund, are not tracked
  in sandbox.
- A contractor who disagrees with a retention refund has PayPal's own
  dispute process as recourse. The owner's reason is kept in the ledger.
- Card-funded holds cannot be renewed: a milestone paid by card has 29 days
  to be proven. Wallet-funded holds can be renewed once.

## Tests and checks

```bash
cd server/node
npm test              # vitest: domain, policy, prechecks, AI, ledger, HTTP
npm run lint          # eslint (server and client) and tsc
npm run format:check  # prettier
```

The tests never call PayPal or an AI provider: the gateway and providers
are replaced with fakes. CI runs the same commands on Node 20 and 24 and
checks that the Docker image starts and answers `/healthz`.

## API

See [`docs/openapi.yaml`](docs/openapi.yaml), or import
[`docs/postman`](docs/postman) into Postman.

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.

## License

[MIT](LICENSE)
