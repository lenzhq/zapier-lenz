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
| **Assess (Fast)** | A quick 3-model panel verdict, ~10 seconds, one entry per claim identified in the input text. Good default for lower-stakes checks. |
| **Extract Claims** | Free — pulls the verifiable factual claims out of a block of text without checking them. Useful as a first step before running Assess or Verify a Claim on each claim individually. **Text** can also be a single public web page URL: Lenz reads the page, or a YouTube video's transcript, and extracts the claims from its first 50,000 characters. Pages behind a login (Facebook, Instagram, Threads, LinkedIn) can't be read. A URL call typically takes 5-40 seconds and a Zap step has 30, so a slow page can fail the step; for a long page, send its text instead. |
| **Ask Follow-Up** | Asks a question grounded in the full research behind a completed **Verify a Claim** result. Requires the `verification_id` that action returns — not usable standalone. |

Every claim-checking action returns a `passed` boolean (derived from the verdict) alongside the raw verdict and confidence — and, on Verify a Claim, the sourced citations — so you can wire a **Filter** step directly off the result — e.g. only continue the Zap when a claim passed.

### Values to filter on

A **Filter** or **Paths** step compares against exact strings, and the Zap editor offers
only what the sample shows. These are the values the API actually sends:

| Field | Where | Values |
|---|---|---|
| `status` | Extract Claims | `ready` when claims were found, `not_a_claim` when none were, or `no_match` when claims were found and a **Focus** excluded all of them. `no_match` is reachable only when you set a Focus. |
| `status` | Assess (Fast) | `ok` when at least one row came back, `no_claim` when none did. Built by the integration, not the API. `ambiguous` was a third value until the API retired it on 2026-09-12 — a vague input is now checked on its most likely reading — so a Paths branch on it never fires; remove it. |
| `claims[].error_code` | Assess (Fast) | Empty on a verdict row. On a row whose `verdict` is `Error`, why it has no verdict: `no_claim`, `framing_failed`, `upstream_unavailable` or `timeout` — an open set, so branch on the ones you know and let the rest fall through. Error rows are free, and `hint` on the same row says what to send instead. |
| `domain` | Extract Claims, New Verification Completed | Capitalised: `Health`, `Science`, `Politics`, `Finance`, `Tech`, `History`, `Legal`, `General` — **or empty**, when the extractor produced no usable domain. A Paths step covering all eight still needs a branch for the empty case. |
| `passed` | Verify a Claim, Assess (Fast) | Boolean, derived from the verdict. The reliable thing to branch on. |
| `domain` | Verify a Claim | Same eight capitalised values as above, or empty. |
| `status` | Verify a Claim | `completed`, `needs_input`, `failed`, or `processing`. Built by the integration. |
| `reason` | Verify a Claim, when `status` is `needs_input` | `multi_claim` or `duplicate_found`. Empty otherwise. `clarification_required` was a third value until the API retired it on 2026-09-12; **Candidate Readings** is still emitted, always empty, so a Zap that maps it keeps working. |
| `depth` | Verify a Claim, when `status` is `completed` | `standard` or `low` — the depth the verdict was **produced** with, which is not always the one you asked for. Empty on every other status, and on verdicts from before Lenz recorded it. |
| `visibility` | Verify a Claim, when `status` is `completed` | `private`, `unlisted` or `public`. You can only *request* the first two; `public` is read back when the verdict was served from an existing verification someone made public. Empty on every other status. |
| `language` | all four actions (input) | `en` `es` `de` `fr` `it` `pt` `nl` `sv` `da` `no` `fi` `bg`. A dropdown since 1.4.0 — it was free text, and anything outside this set fails the run. |

Every field in the table above, and every other field Verify a Claim declares, is
**present on every result** — empty when it does not apply, never missing. Zapier treats
"does not exist" and "is empty" as different conditions, so this is what lets a Filter you
built against the sample behave the same on a live run. `Passed` and `Lenz Score` are
empty rather than `false`/`0` on a result with no verdict, since nothing was checked.

### When Lenz asks for input instead of answering

**Verify a Claim** can stop before running the pipeline and hand back `status: needs_input`.
It does that for three different reasons, and each carries data you can act on — so branch
on `reason` rather than treating them as one case:

| `reason` | What Lenz found | What to map | What to do |
|---|---|---|---|
| `multi_claim` | Several separate claims in one input | **Claims Found** (line items: `text`, `domain`) | Fan out — a Verify step per item, or send them one at a time |
| ~~`clarification_required`~~ | *Retired 2026-09-12.* A vague claim is now checked on its most likely reading instead of paused | **Candidate Readings** — still present, always empty | Nothing; it no longer occurs |
| `duplicate_found` | A verification of this claim **already exists** | **Duplicate Verification ID** and **Duplicate URL**; the full list in **Similar Claims** | Reuse it — map the ID into **Ask Follow-Up**. Do **not** re-run: that spends a full check to reproduce an answer you already have |

Before 1.4.0 all three produced the same "rephrase and re-run" message and the data was
dropped. For `duplicate_found` that advice was wrong and cost money.

Two fields on Extract Claims look filterable and are not:

- **`presumed_intent`** is free text, one sentence per document. It is not an enumeration, so an exact-string filter on it cannot hold.
- **`identified_claims`** is the complete ordered list when more than one claim was found, and `[]` when only one was. It is never a one-element list, so branch on `claim` for the single-claim case rather than on this field's length.

Extract's `status` read `ok` in the sample until 1.3.2 — a value the API never sends — so
a filter built on it matched nothing on a live run. If you built one before 1.3.2, change
it to `ready`. A lowercase `domain` needs capitalising the same way.

### Language

All four actions take an optional **Language**, and it is a dropdown of the twelve codes
the API accepts: `en` `es` `de` `fr` `it` `pt` `nl` `sv` `da` `no` `fi` `bg`. Anything
outside that set is refused with a 422, which counts as a failed run — so until 1.4.0,
when this was a free-text box described only as "ISO 639-1", typing `English`, `en-US` or
any unsupported code failed **every** run of that Zap with nothing in the editor to say
why. If you have an existing Zap with a hand-typed value, re-pick it from the dropdown.

**It sets the language of the answer, not of your input.** Lenz never inspects what
language your text is in; this field alone decides what comes back. Reading it the other
way round is the easy mistake, and it quietly changes the output.

**Blank means two different things.** On Verify a Claim, Assess and Extract Claims a blank
field means English. On **Ask Follow-Up** it means *the language the verification is stored
in*, which is usually what you want — you can ask in English about a Spanish verification
by leaving it blank, or set it explicitly to override.

### Depth, Visibility and Focus

Three optional fields, all blank by default. Leaving them blank sends nothing and keeps
existing Zaps behaving exactly as before.

**Depth** (*Verify a Claim*) — `Standard` or `Low`.

`Low` costs **5 credits instead of 10**, and buys less work rather than a different kind
of work. It runs at most 3 searches against a 12-page reading limit, where Standard keeps
searching until it has enough and reads up to 48; it also skips the extra evidence pass
Standard falls back on when a search provider is struggling. Its debate stops after both
sides' opening arguments instead of letting them answer each other — so the panel still
sees both cases in full, just not the replies. Every step runs the same models, and
framing, the panel and the conclusion are identical at both depths. Useful for bulk
checks where a thinner answer is still worth having.

The one thing worth knowing before you branch on it: **you are charged for the depth you
request, but the `depth` output echoes the depth the verdict was produced with.** Lenz can
answer a `Low` request from a `Standard` verdict it already has — that run costs 5 and
reads back `standard`. The charge follows your request; the echo describes the evidence.
They are meant to differ, so a Zap comparing the two will see mismatches that are not errors.

**Visibility** (*Verify a Claim*) — `Private` or `Unlisted`.

`Private` is the default: only your account can read the result. `Unlisted` makes it
readable by anyone holding its Verification ID or its lenz.io link — useful when the Zap
posts that link into Slack or email for people without Lenz accounts. Unlisted results are
never listed in the public Library and never appear in search.

**Focus** (*Extract Claims*) — a short hint, at most 300 characters, costing nothing extra.

It narrows the result to the claims it describes, e.g. `pricing and headcount`. It only
**selects** from the claims Lenz already found — it cannot add a claim, reword one, or
change what counts as a claim.

When nothing matches, `status` comes back as `no_match` with an empty list and a **Message**
explaining why. The unfocused claims are deliberately not substituted, so `no_match` is a
real answer rather than a failure — but it looks identical to "nothing here" unless your
Zap branches on the status. A Focus over 300 characters fails the step with the actual
count rather than being silently shortened, which would return a subset of the claims with
nothing to indicate it happened.

## Trigger

| Trigger | What it does |
|---|---|
| **New Verification Completed** | Polls for claims that finish fact-checking on the connected **account**. Runs on Zapier's standard polling interval (not instant) — for a claim you're actively submitting in the same Zap, use the **Verify a Claim** action instead, which waits and returns the result inline. |

**The trigger is account-wide, not key-wide.** It fires for every completed verification
the account owns, whichever surface produced it — a check you ran on the website, through
the MCP server, or with a different API key will start this Zap. Filter on something the
Zap can see (`domain`, `verdict`, `passed`) if you only want a subset.

It reads up to 100 completions per poll. Zapier polls every 1-15 minutes, so an account
finishing more than 100 verifications between two polls can still outrun it; that is the
server's maximum page size, not a setting.

## Credentials

You'll need a Lenz API key:

1. Sign up at [lenz.io/api-credentials](https://lenz.io/api-credentials) to get a key (starts with `lenz_`).
2. In Zapier, when connecting the Lenz app, paste the key and Zapier will test it automatically against your account's usage endpoint.

## Usage

- **Verify a Claim takes ~90 seconds.** The Zap step will show as "waiting" while the pipeline runs — this is expected, not a stuck Zap.
- **Verify a Claim** requires the connected API key to have webhook delivery enabled (an HMAC secret provisioned) — see the Lenz dashboard's API key settings if a submission fails immediately with a webhook-related error.
- For **Ask Follow-Up**, chain it directly after **Verify a Claim** in the same Zap, mapping its `verification_id` output into the Ask step's Verification ID field.

### What happens when something goes wrong

Zapier turns a Zap off after enough failed runs, so which failures *count* matters
more than it looks. Since 1.4.0:

| Condition | What Zapier does | Counts as an error? |
|---|---|---|
| Out of credits (402) | Halts the run with a top-up link | No |
| Daily `/extract` cap (429) | Waits the stated time and replays | No |
| Lenz at capacity, or providers down (503) | Waits the stated time and replays | No |
| Assess (Fast): every claim came back `Error` with `upstream_unavailable` or `timeout` | Waits until the next hour begins and replays — Error rows are free, so nothing was charged. The wait is tied to the hour because the replay key is; a sooner replay would be handed the same stored rows | No |
| Network drop, or a 5xx naming no reason | Waits 60s and replays | No |
| No webhook secret on the key (Verify a Claim) | Halts with instructions | No |
| Focus over 300 characters (Extract Claims) | Halts with instructions | No |
| Key rejected (401) | Prompts you to reconnect | No |
| Claim could not be framed, text unreadable (typed 502) | Fails the run | Yes |
| Private verification or blocked IP (403) | Fails the run | Yes |

The last two are deliberate: they are answers about the input, so replaying them
spends the run again for the same result.

**On replays.** A run that waits and replays runs the action again. For the refusals
above — out of credits, over a cap, Lenz at capacity — that costs nothing, because
the call is turned away before any work happens. A *timeout* is different: the
request may have reached Lenz and be running, and there is no way to tell from the
Zap's side. Both claim-checking actions guard against paying twice for it. Verify a
Claim carries a per-run callback URL that keeps runs apart. Assess (Fast) sends an
idempotency key built from the Zap, the input and the current hour, so a replay
within the hour gets the answer Lenz already produced instead of a second panel.
The one edge that follows: if a single Zap sends the *same* text twice on purpose
within one hour, the second run gets the first answer rather than a fresh check.

A call makes **one attempt** and lets Zapier do any waiting. The SDK used to retry
up to four times inside one run and could sleep a stated wait of up to a minute —
past the ~30s Zapier allows a step, so the run was killed and counted as a failure
before the wait it was asked to honour had elapsed.

Every error message ends with the Lenz request id (`(Lenz request abc123)`). Quote it
when asking for help: this integration calls the API through the Lenz SDK rather than
Zapier's HTTP client, so Zapier's per-request log tab is empty and that id is the only
way to find the specific run.
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

For a lighter check on lower-stakes content, swap the action to **Assess (Fast)** instead — same wiring, ~10s instead of ~90s.

## Building and pushing

**Push a version only from a commit whose CI run is green.** Nothing enforces this
technically: the release runs from a developer's machine, so there is no workflow to
gate, and `zapier push` will package a tree whose tests fail without complaint. A
pushed version is then one `promote` away from every user. `npm test` locally runs
exactly what CI runs, coverage floor included, so a clean local run is the minimum
before building.

**The version number is set once, at release time — not per pull request.** Bumping it
in every PR guaranteed a conflict in `package.json` and `CHANGELOG.md` between any two
open branches, which is what happened to #32 and #33. So a merged PR leaves both at the
number of the release being accumulated, and whoever builds sets them together.

Three places carry it and all three move at once: `package.json`, the top `CHANGELOG.md`
heading, and the "Since x.y.z:" reference under [What happens when something goes
wrong](#what-happens-when-something-goes-wrong). Zapier does **not** require versions to
be sequential: 1.4.0 was pushed on 2026-09-20 with neither 1.3.3 nor 1.3.4 ever having
existed on Zapier, and it was accepted without comment. An earlier version of this
paragraph claimed otherwise; it had never been tested.

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

* **1.3.0** — Lenz replaced its six per-endpoint quotas with **one credit pool** per account. The out-of-credits `HaltedError` now names the shortfall in credits — the cost of the call that was refused beside the balance that refused it — instead of only saying the balance is spent. That is the difference between a top-up and a plan change, and the user reads this message in the Zap history with no other context. Wording throughout follows the pool: credits are no longer per endpoint, so a `verify` no longer spends "a verify credit". `/extract` costs no credits at all and keeps its own daily fair-use cap, which still maps to a `ThrottledError` and replays. Reads `creditBalance` (the pool) rather than the deprecated `creditsRemaining`, which aliases `remaining` and is in the capability's unit, not credits. Requires `lenz-io` ≥ 2.9.0, the first version to carry `creditBalance` and `cost` on the quota error.
* **1.2.2** — A failed verification now returns `failure_reason`, `failure_class` (closed set: `upstream_unavailable` / `insufficient_evidence` / `invalid_input` / `cancelled` / `internal`) and `retryable` as mappable output fields, so a Filter or Paths step can branch on *why* it failed instead of parsing the error prose. Capacity refusals (HTTP 503 with `code: capacity` or `upstream_unavailable`, sent when Lenz is shedding load or its model providers are down) become a `ThrottledError` carrying the server's stated wait — Zapier replays instead of hard-failing, for the same reason a spent balance halts: a self-resolving condition must not count against the Zap's error budget and get it auto-disabled. All four failure fields are present-but-empty on a successful run rather than absent, because Zapier's Filter treats a missing field and an empty one as different conditions. And a callback that arrives before the pipeline settles now reports its real status (`processing`) instead of `failed` — calling it a failure would have sent `retryable: null` about a verification that was still running and about to succeed.
* **1.2.1** — App review fixes (2026-08-20). Removed the connection label, which showed the account's plan tier: Zapier renders that label unredacted and asks for an account name, email, or name instead (publishing requirement 5.6), so it is now unset and Zapier numbers the connections. Rewrote all five trigger/action descriptions to the build guidelines — concise, opening with a third-person verb, no platform name, no Markdown — and moved the webhook-secret requirement and the "Test returns a sample" note into help text, which is where Zapier asks for that detail. No functional change: no `perform` body, input key, or output field was touched. Also the first release packaged from Linux — see [Building and pushing](#building-and-pushing).
* **1.2.0** — Mapped Lenz failures onto Zapier's error taxonomy (`lib/errors.js`), which previously went unused. **Running out of Lenz credits no longer counts against the Zap.** It used to raise a plain error, so a spent balance accumulated hard errors and could get a customer's automation turned off — for a billing state that resolves the moment they top up. It is now a `HaltedError`, which stops the run without penalising the Zap. A rate limit becomes a `ThrottledError` carrying the wait, so Zapier replays instead of burning the run; a rejected key becomes an `ExpiredAuthError`, which prompts a reconnect. Every action and the polling trigger now handle errors — three actions and the trigger previously had no `.catch` at all. Requires `lenz-io` ≥ 2.7.0.
* **1.1.0** — Added the `key_finding` output field (one declarative sentence stating the finding) to Verify a Claim and New Verification Completed. Additive: existing Zaps keep working, and the new field is available to map.
* **1.0.0** — Initial implementation. Verify a Claim (callback-based), Assess (Fast), Extract Claims, and Ask Follow-Up actions; New Verification Completed polling trigger; API-key credential with a live test against `/me/usage`.

## Maintainer

[@David19782](https://github.com/David19782)
