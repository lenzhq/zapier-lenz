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

1. Sign up at [lenz.io/api-integration](https://lenz.io/api-integration) to get a key (starts with `lenz_`).
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

## Resources

* [Lenz API documentation](https://lenz.io/developers)
* [lenz-io Node SDK](https://github.com/lenzhq/lenz-io-node) (this integration is a thin wrapper around it)
* [n8n-nodes-lenz](https://github.com/lenzhq/n8n-nodes-lenz) — the equivalent integration for n8n

## Version history

* **1.2.0** — Mapped Lenz failures onto Zapier's error taxonomy (`lib/errors.js`), which previously went unused. **Running out of Lenz credits no longer counts against the Zap.** It used to raise a plain error, so a spent balance accumulated hard errors and could get a customer's automation turned off — for a billing state that resolves the moment they top up. It is now a `HaltedError`, which stops the run without penalising the Zap. A rate limit becomes a `ThrottledError` carrying the wait, so Zapier replays instead of burning the run; a rejected key becomes an `ExpiredAuthError`, which prompts a reconnect. Every action and the polling trigger now handle errors — three actions and the trigger previously had no `.catch` at all. Requires `lenz-io` ≥ 2.7.0.
* **1.1.0** — Added the `key_finding` output field (one declarative sentence stating the finding) to Verify a Claim and New Verification Completed. Additive: existing Zaps keep working, and the new field is available to map.
* **1.0.0** — Initial implementation. Verify a Claim (callback-based), Assess (Fast), Extract Claims, and Ask Follow-Up actions; New Verification Completed polling trigger; API-key credential with a live test against `/me/usage`.
