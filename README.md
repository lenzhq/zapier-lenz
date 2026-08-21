# zapier-lenz

This is a Zapier integration for **Lenz** — an audit-grade AI fact-checking API. It catches hallucinations and gives sourced, branch-ready verdicts on any claim or piece of text, not just a bare confidence score.

[Zapier](https://zapier.com/) lets you connect apps into automated workflows ("Zaps") without writing code.

[Installation](#installation)
[Actions](#actions)
[Trigger](#trigger)
[Credentials](#credentials)
[Usage](#usage)
[Example Zap](#example-zap)
[Resources](#resources)
[Version history](#version-history)

## Installation

This integration is not yet in Zapier's public App Directory. While private, it's usable only from the developer account it's pushed to (`zapier login` + `zapier push`), or by anyone that account invites via a share link.

## Actions

| Action | What it does |
|---|---|
| **Verify a Claim** *(default)* | Full pipeline (research → debate → adjudication), ~90 seconds. Returns a verdict, confidence, `lenz_score` (1-10), sourced citations, and an executive summary. Reserve for high-stakes claims that need a thorough, cited answer. Runs asynchronously via Zapier's callback mechanism — the Zap step shows as "waiting," not stuck. |
| **Assess (Fast)** | A quick 3-model panel verdict, ~5-10 seconds, one entry per claim identified in the input text. Good default for lower-stakes checks. |
| **Extract Claims** | Free — pulls the verifiable factual claims out of a block of text without checking them. Useful as a first step before running Assess or Verify a Claim on each claim individually. |
| **Ask Follow-Up** | Asks a question grounded in the full research behind a completed **Verify a Claim** result. Requires the `verification_id` that action returns — not usable standalone. |

Every claim-checking action returns a `passed` boolean (derived from the verdict) alongside the raw verdict/confidence/citations, so you can wire a **Filter** step directly off the result — e.g. only continue the Zap when a claim passed.

## Trigger

| Trigger | What it does |
|---|---|
| **New Verification Completed** | Polls for claims that finish fact-checking under the connected API key. Runs on Zapier's standard polling interval (not instant) — for a claim you're actively submitting in the same Zap, use the **Verify a Claim** action instead, which waits and returns the result inline. |

## Credentials

You'll need a Lenz API key:

1. Sign up at [lenz.io/api-credentials](https://lenz.io/api-credentials) to get a key (starts with `lenz_`).
2. In Zapier, when connecting the Lenz app, paste the key and Zapier will test it automatically against your account's usage endpoint.

## Usage

- **Verify a Claim takes ~90 seconds.** The Zap step will show as "waiting" while the pipeline runs — this is expected, not a stuck Zap.
- **Verify a Claim** requires the connected API key to have webhook delivery enabled (an HMAC secret provisioned) — see the Lenz dashboard's API key settings if a submission fails immediately with a webhook-related error.
- For **Ask Follow-Up**, chain it directly after **Verify a Claim** in the same Zap, mapping its `verification_id` output into the Ask step's Verification ID field.
- Use **Extract Claims** first when the input text might contain more than one claim, then fan out to **Assess (Fast)** or **Verify a Claim** per extracted claim.

## Example Zap

A simple "fact-check gate" pattern — verify a claim before acting on it:

```
[Form/Webhook trigger]  ──▶  [Lenz: Verify a Claim]  ──▶  [Filter]  ──▶  continue
  a claim comes in            waits ~90s, returns          only if
                               verdict + passed             {{passed}} is true
```

1. Add a trigger step that produces the claim text (a form submission, a webhook, a spreadsheet row, etc.).
2. Add the **Lenz: Verify a Claim** action, mapping the Claim field to the upstream text.
3. Add a **Filter by Zapier** step after it with the condition `passed` **is true**.
4. Continue the Zap normally after the filter — claims that failed are simply filtered out (add a separate branch/Zap if you want to route them somewhere, e.g. a Slack alert).

For a lighter check on lower-stakes content, swap the action to **Assess (Fast)** instead — same wiring, ~5-10s instead of ~90s.

## Building and pushing

**Do not run `zapier push` from Windows.** `zapier-platform-cli` 19.1.0 copies the
project into `%TEMP%\zapier-<hash>` and archives it with that path embedded, so the
uploaded package carries every source file under
`AppData/Local/Temp/zapier-<hash>/` and a root `index.js` that is a 43-byte symlink
rather than the app. The CLI reports success either way, which is how this shipped
unnoticed in both 1.0.0 and 1.2.0 before app review caught it (2026-08-20).

Build and push from Linux instead. With Docker, from the project root:

```bash
MSYS_NO_PATHCONV=1 docker run --rm   -v "$(pwd):/src:ro" -v "$HOME/.zapierrc:/root/.zapierrc:ro" node:22-slim sh -c '
    mkdir -p /work &&
    tar -C /src --exclude=node_modules --exclude=build --exclude=.git -cf - . | tar -C /work -xf - &&
    cd /work && npm ci --omit=dev && npx --yes "zapier-platform-cli@^19" push'
```

Two things that bite:

* The CLI requires Node >= 22. `node:20` is rejected outright.
* Never mount the host `node_modules`: it holds `@esbuild/win32-x64` and Linux needs
  `@esbuild/linux-x64`. Copying the source without it and running `npm ci` inside the
  container also leaves the host tree — and `npm test` — untouched.

Confirm the layout before trusting any build, because a bad one looks identical from
the CLI's output:

```bash
unzip -l build/build.zip | head
# expect: index.js, definition.json, creates/, triggers/, node_modules/
# and NO AppData/ prefix anywhere
```

## Resources

* [Lenz API documentation](https://lenz.io/developers)
* [lenz-io Node SDK](https://github.com/lenzhq/lenz-io-node) (this integration is a thin wrapper around it)
* [n8n-nodes-lenz](https://github.com/lenzhq/n8n-nodes-lenz) — the equivalent integration for n8n

## Version history

* **1.2.2** — A failed verification now returns `failure_reason`, `failure_class` (closed set: `upstream_unavailable` / `insufficient_evidence` / `invalid_input` / `cancelled` / `internal`) and `retryable` as mappable output fields, so a Filter or Paths step can branch on *why* it failed instead of parsing the error prose. Capacity refusals (HTTP 503 with `code: capacity` or `upstream_unavailable`, sent when Lenz is shedding load or its model providers are down) become a `ThrottledError` carrying the server's stated wait — Zapier replays instead of hard-failing, for the same reason a spent balance halts: a self-resolving condition must not count against the Zap's error budget and get it auto-disabled.
* **1.2.1** — App review fixes (2026-08-20). Removed the connection label, which showed the account's plan tier: Zapier renders that label unredacted and asks for an account name, email, or name instead (publishing requirement 5.6), so it is now unset and Zapier numbers the connections. Rewrote all five trigger/action descriptions to the build guidelines — concise, opening with a third-person verb, no platform name, no Markdown — and moved the webhook-secret requirement and the "Test returns a sample" note into help text, which is where Zapier asks for that detail. No functional change: no `perform` body, input key, or output field was touched. Also the first release packaged from Linux — see [Building and pushing](#building-and-pushing).
* **1.2.0** — Mapped Lenz failures onto Zapier's error taxonomy (`lib/errors.js`), which previously went unused. **Running out of Lenz credits no longer counts against the Zap.** It used to raise a plain error, so a spent balance accumulated hard errors and could get a customer's automation turned off — for a billing state that resolves the moment they top up. It is now a `HaltedError`, which stops the run without penalising the Zap. A rate limit becomes a `ThrottledError` carrying the wait, so Zapier replays instead of burning the run; a rejected key becomes an `ExpiredAuthError`, which prompts a reconnect. Every action and the polling trigger now handle errors — three actions and the trigger previously had no `.catch` at all. Requires `lenz-io` ≥ 2.7.0.
* **1.1.0** — Added the `key_finding` output field (one declarative sentence stating the finding) to Verify a Claim and New Verification Completed. Additive: existing Zaps keep working, and the new field is available to map.
* **1.0.0** — Initial implementation. Verify a Claim (callback-based), Assess (Fast), Extract Claims, and Ask Follow-Up actions; New Verification Completed polling trigger; API-key credential with a live test against `/me/usage`.

## Maintainer

[@David19782](https://github.com/David19782)
