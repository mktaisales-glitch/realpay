# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository. You will get an answer within five working days.

RealPay is a hackathon project that runs against the PayPal sandbox only.
No real money is ever involved, but reports are still taken seriously.

## What is in place

**Money**

- The server refuses to start unless the PayPal API base is the sandbox.
- Funds are authorized, not captured, until the release policy says so.
  The AI cannot release more than the template's auto-release cap, below
  the minimum confidence, with any precheck flag, or during a dispute.
- Every PayPal call carries a deterministic `PayPal-Request-Id` and every
  payout a deterministic `sender_batch_id`, so retries are idempotent.
- Webhooks are verified with PayPal's `verify-webhook-signature` before
  they can change a milestone. Unverified events are rejected, and a
  replayed event id is recognised and not processed twice.

**Access**

- No accounts or passwords. Each project has one capability link per
  role; only the SHA-256 of each token is stored, and comparison is
  constant-time.
- Every route checks the role it needs (homeowner or contractor).
- Creating projects and uploading proof are rate-limited.

**Input**

- Request bodies are validated with zod and limited to 64 KB.
- Proof uploads are limited to one file of 8 MB, and the type is checked
  from the file's bytes, not its name.
- The proof note is screened for instructions aimed at the AI before any
  model sees it, and the model's answer must match a strict schema.

**Browser**

- helmet sets a strict Content Security Policy that only allows PayPal
  origins for scripts and frames, `frame-ancestors 'none'` and
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` (needed by the
  PayPal popup).
- No CORS headers: the API is same-origin only.
- The PayPal client secret never reaches the browser; the client only
  receives the browser-safe client id.

**Audit**

- Every action, AI verdict and policy decision is appended to a
  hash-chained ledger. Editing a past entry breaks the chain.

## Out of scope

- Demo mode (`DEMO_MODE=true`) deliberately adds a test-card funding
  button, a clock control and simulated disputes. It is meant for the
  public sandbox demo only.
- Anyone holding a capability link can act as that role. Treat the links
  like passwords.
