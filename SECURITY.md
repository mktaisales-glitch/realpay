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

**Limits**

- Per client IP: 300 calls a minute across `/api`, 30 new projects an
  hour, 20 proof uploads every 10 minutes and 25 a day, 60 webhook calls
  a minute.
- Per instance and UTC day: 300 new projects and 100 test-card payments
  (`PROJECTS_PER_DAY`, `DEMO_CARD_FUNDINGS_PER_DAY`), so many clients
  together cannot fill the disk or wear out the sandbox account.
- Per milestone: at most 8 proofs. After that the homeowner has to review
  them or open a dispute.
- Extras: EUR 10 to EUR 2,000 each (or free), at most 50% of the original
  contract in agreed extras, 20 waiting for an answer and 50 per project,
  and 30 change-order actions an hour per client IP. No extra can be
  proposed or accepted while a dispute is open.
- AI calls: 10 per project a day and 150 for the whole instance, so a
  single link cannot drain the model quota.
- Demo controls: 20 calls a minute per client IP. The demo clock stops
  365 days ahead, and the clock and simulated disputes stop once a
  project has 2,000 audit entries.
- Behind a reverse proxy, set `TRUST_PROXY` to the number of proxies
  (1 on Render). Left at 0 there, every visitor shares the proxy's IP;
  set too high, anyone can choose their own IP with `X-Forwarded-For`.

**Input**

- Request bodies are validated with zod and limited to 64 KB.
- Proof uploads are limited to one file of 8 MB. The type (JPEG, PNG or
  PDF) is taken from the file's signature bytes, not its name or the
  `Content-Type` header. This is a type check, not a full parse: a file
  can start like a JPEG and still be malformed, so uploads are stored
  outside the web root and never served back to a browser.
- Prompt injection is handled in layers. A pattern check on the note is
  only the first filter: it flags obvious attempts ("ignore all previous
  instructions") before any model is called, and a flag alone blocks
  automatic release. The real defences are that the model gets the note
  fenced and labelled as untrusted, its answer must match a strict schema, and the release
  policy, not the model, decides what money moves. The AI can never
  release a document on its own, more than the template's cap, or
  anything during a dispute.
- An extra's description is prompt text written by one of the parties:
  once both agree, it becomes the checklist the AI inspector reads for
  that milestone. On the way in, it is flattened to one line and stripped
  of invisible format characters and `"""`, and a description that reads
  as instructions to the inspector is refused
  (`CHANGE_ORDER_LOOKS_LIKE_INSTRUCTIONS`). In the prompt, it sits inside
  a fence labelled as scope agreed by the parties, not instructions, and
  the milestone title made from the same text is left out. An extra is
  never released automatically: the homeowner always signs it off.
- The limits of that: the pattern check is a list of known phrasings,
  and reworded instructions get through it. The other party also has to
  accept the description, and it can only widen what the AI looks for in
  that one extra, never move money on its own. The fence and the
  sign-off are what is relied on, not the filter.

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
- `requestedBy` on a change order is what the proposer says, not a
  verified fact. `proposedBy` always comes from the link that was used,
  and an extra only counts once the other party accepts it.
- Privacy: this is a public sandbox demo. A proof photo, its EXIF data
  (including GPS) and the note are shown to the other party and sent to
  the configured AI providers. Do not upload real personal photos or
  documents.
