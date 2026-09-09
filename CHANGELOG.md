# Changelog

User-facing changes to the Lenz integration for Zapier. Build and release
mechanics live in [README.md](README.md#building-and-pushing).

## 1.4.0

Problems that pass on their own now pause your Zap instead of failing it.
Zapier turns a Zap off after enough failed runs, and conditions like a busy
moment at Lenz or a brief network drop were counting toward that.

- Update create/verify_claim, create/assess, create/extract_claims,
  create/ask and trigger/new_verification: a call makes one attempt and hands
  the waiting to Zapier, which replays the run. It used to retry up to four
  times inside a single run, sleeping a stated wait of as much as a minute —
  longer than Zapier allows a step to take, so the run was killed and counted
  as a failure before the wait it was told to honour had passed.
- Update create/verify_claim, create/assess, create/extract_claims,
  create/ask and trigger/new_verification: a network drop, or a temporary
  error from Lenz that names no reason, now waits and replays instead of
  failing. Errors that ARE about your input — a claim that could not be
  framed, text that could not be read — still fail the run, because replaying
  them would spend it again for the same answer.
- Note on replays: if a request timed out after Lenz had already received it,
  the replay can run that check a second time and charge for it. Being out of
  credits or hitting a cap is refused before any work, so those replays cost
  nothing; a timeout is the case we cannot tell apart from here.
- Fix create/verify_claim: a key with no webhook secret now halts the Zap with
  instructions instead of failing on every scheduled run. It cannot be fixed
  by retrying, so it was quietly using up the error budget that turns a Zap
  off.
- Update: connecting an account reports a rejected key as a reconnect prompt,
  and a network problem as a network problem, rather than showing the raw
  error text.
- Update: every error message ends with the Lenz request id, so support can
  trace one specific run.

## 1.3.2

- Fix create/extract_claims and create/assess: the example data shown while
  building a Zap now matches what the API really returns.

The Zap editor builds Filter and Paths steps from the example each action
shows, so an example value the API never sends teaches a filter that matches
nothing on a live run — and says nothing about why.

**Extract Claims** showed `Status: ok`, and the API sends `ready` when it
found claims or `not_a_claim` when it did not. `Domain` was lowercase where
the API capitalises it, on Extract Claims and on **New Verification
Completed**. `Identified Claims` showed a single entry, a shape the API never
produces: it carries the complete list when more than one claim was found and
is empty when only one was. `Presumed Intent` showed `informational`, which
reads like a fixed set of options but is a free-text sentence.

**Assess (Fast)** declared a `Message` output but left it out of its example,
so a filter on it tested clean in the editor and behaved differently live.
Message and Candidate Claims are now present on every result, empty when
there is nothing to report.

**What to check in your Zaps.** A Filter or Paths step built on Extract's
Status before this release needs `ok` changed to `ready`, and a lowercase
Domain capitalising. Anything branching on Presumed Intent, or on Identified
Claims having exactly one entry, was never going to hold — use the Claim
field for the single-claim case. Nothing was renamed or removed, and the
request each action sends is unchanged. The values worth filtering on are now
listed in [README.md](README.md#values-to-filter-on).

## 1.3.1

The input on **Assess (Fast)** is labelled **Claim** instead of **Text**,
matching the API's vocabulary: a document is `text` (**Extract Claims** keeps
that label), a claim is `claim`. Label and help text only: the field key saved
in existing Zaps is unchanged, and so is every request the integration sends.

## 1.3.0

Lenz replaced its six per-endpoint quotas with one credit pool per account.
A refused call now names what it costs beside the balance that refused it,
so it is clear whether the answer is a top-up or a plan change.

- Update create/verify_claim, create/assess and create/ask: an out-of-credits
  error reports the cost of the call and the credits left, and still halts the
  Zap without counting toward the error rate that turns a Zap off.
- Update create/extract_claims: extract spends no credits. It keeps its own
  daily fair-use cap, which waits and replays rather than failing.

## 1.2.2

- Update create/verify_claim and trigger/new_verification: a failed
  verification returns failure_reason, failure_class and retryable as fields
  you can map, so a Filter or Paths step branches on why it failed instead of
  parsing the error text. failure_class is one of upstream_unavailable,
  insufficient_evidence, invalid_input, cancelled or internal. The fields are
  present and empty on a successful run, because Zapier's Filter treats a
  missing field and an empty one as different conditions.
- Update create/verify_claim and create/assess: when Lenz is shedding load or
  a model provider is down, the action waits the interval Lenz states and
  replays, instead of failing the run.
- Fix create/verify_claim: a callback that arrives before the pipeline settles
  reports processing rather than failed.

## 1.2.1

- Update create/verify_claim, create/assess, create/extract_claims,
  create/ask and trigger/new_verification: rewrote the descriptions, and moved
  the webhook-secret requirement into help text where Zapier asks for it.
- Fix: removed the connection label, which showed the account's plan tier.

## 1.2.0

- Update create/verify_claim, create/assess, create/extract_claims,
  create/ask and trigger/new_verification: Lenz failures now map onto Zapier's
  error types. Running out of credits halts the Zap instead of counting as an
  error, a rate limit waits and replays, and a rejected key prompts a
  reconnect.

## 1.1.0

- Update create/verify_claim and trigger/new_verification: added key_finding,
  one sentence stating what the check established.

## 1.0.0

Initial release. Verify a Claim, Assess (Fast), Extract Claims and Ask
Follow-Up actions, a New Verification Completed trigger, and an API-key
connection tested against /me/usage.
