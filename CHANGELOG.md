# Changelog

User-facing changes to the Lenz integration for Zapier. Build and release
mechanics live in [README.md](README.md#building-and-pushing).

## 1.3.3

- Fix trigger/new_verification: the trigger reads up to 100 finished checks per
  poll instead of 20, so a busy account stops losing the oldest ones.

Zapier polls every 1-15 minutes and only ever reads the first page. At the old
page size of 20, an account that finished more than 20 checks between two polls
never saw the oldest of them — they had already scrolled off the first page by
the time the next poll ran. Nothing failed and nothing was logged; the rows
simply never reached the Zap. 100 is the largest page the API will return, so a
run of more than 100 between polls can still outrun it.

**The trigger is account-wide, and always was.** It fires for every completed
verification the account owns, whichever surface produced it — a check run on
the website, through the MCP server, or with a different API key starts this Zap
too. The docs said "under the connected API key", which was wrong. Nothing
changed here except the wording; if that is not what you want, filter on
something the Zap can see, such as Domain or Verdict.

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
