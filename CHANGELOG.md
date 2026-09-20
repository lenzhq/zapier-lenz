# Changelog

User-facing changes to the Lenz integration for Zapier. Build and release
mechanics live in [README.md](README.md#building-and-pushing).

## Unreleased

- New create/assess: each claim carries **Error Code**, **Hint**, **Other
  Claims Found**, **Reviewer Rationale** and **Reviewer Dissent**. A claim
  that could not be checked comes back as a row whose Verdict is `Error`, with
  Error Code saying why (`no_claim`, `framing_failed`, `upstream_unavailable`
  or `timeout`) and Hint saying what to send instead, so a Filter or Paths
  step can branch on the reason rather than on a bare "Error". Error rows
  cost nothing. Other Claims Found lists the claims in a compound input that
  were not the one assessed, to fan out into their own steps.
- Fix create/assess: a run that waits and replays after a timeout no longer
  pays for a second panel. The action sends an idempotency key built from the
  Zap, the input and the current hour, so Lenz returns the answer it already
  produced. The one edge: the same Zap sending the same text twice on purpose
  within one hour gets the first answer twice. Verify a Claim was already
  covered by its per-run callback URL; Extract Claims is free.
- Fix create/assess: when every claim comes back as an `Error` row for a
  reason that passes on its own — `upstream_unavailable` or `timeout` — the
  run waits and replays instead of returning `Passed: false`. Those rows
  cost nothing, and returning them would have sent a claim that was never
  checked down a Zap's "failed fact-check" branch. A result that mixes
  verdicts with such rows is returned as is, because the verdicts were
  charged; each row's Error Code says which is which.
- Update create/assess: `Status` is `ok` or `no_claim`. `ambiguous` is gone —
  the API retired it on 2026-09-12 and now checks a vague claim on its most
  likely reading. **Candidate Claims** is still emitted and always empty.
- Update create/verify_claim: the `clarification_required` reason is gone for
  the same cause. **Candidate Readings** is still emitted and always empty. A
  Paths step with a branch on either retired value has a leg that never
  fires; remove it.
- Fix create/assess and create/extract_claims: both calls pin their own
  timeout to the Zap step budget. The updated Lenz SDK gives `assess` a 45s
  and `extract` a 90s wait by default — right for a script, but past the
  ~30s Zapier allows a step, so without the pin the step would be killed and
  counted as a failure instead of paused or mapped. Requires `lenz-io`
  ≥ 2.15.0.

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
- Fix create/verify_claim: when Lenz stops to ask for input, the action now says
  which of three things happened and hands over what Lenz found, instead of one
  fixed "rephrase and re-run" message for all of them.
- Fix trigger/new_verification: the trigger reads up to 100 finished checks per
  poll instead of 20, so a busy account stops losing the oldest ones.
- New create/verify_claim: **Depth**, to run a check at half the credit cost.
- New create/verify_claim: **Visibility**, to make a result readable by anyone
  holding its link.
- New create/extract_claims: **Focus**, to narrow the extraction to the claims
  you care about.
- Fix: **Language** is a dropdown of the twelve codes the API accepts, on all
  four actions. It was free text, and anything else failed every run.
- Fix create/verify_claim: the verdict fields are present-but-empty on every
  result, instead of missing on the ones that carry no verdict.
- Fix create/assess: the per-claim verdict fields are declared, so they can be
  mapped in the editor.
- New create/verify_claim: Sources carry the quote and the publication date,
  not just a title and a link; and the verdict carries Language, Domain,
  Warnings and Created At.
- New create/assess: each claim carries the Language its verdict is written in.

**Asking for input.** Lenz pauses a verification for three different reasons,
and each one needs a different response:

- **Several claims in one input** (`multi_claim`) — each is returned as a line
  item under Claims Found, so a Zap can fan them out into a check per claim.
- **One claim that reads several ways** (`clarification_required`) — the
  possible readings are returned under Candidate Readings; pick one and re-run
  with that wording.
- **This claim was already verified** (`duplicate_found`) — the existing
  result is returned under Similar Claims, with the first one's ID and URL
  lifted out as Duplicate Verification ID and Duplicate URL so they map
  straight into Ask Follow-Up.

That last one matters most. The old message told the user to rephrase and
re-run, which spends a full check to reproduce an answer that already exists.
Reusing it costs nothing.

All the new fields are present on every result and empty when they do not
apply, so a Filter or Paths step can rely on them. Nothing was renamed or
removed, and the request the action sends is unchanged.

**The trigger's page size.** Zapier polls every 1-15 minutes and only ever reads
the first page. At the old page size of 20, an account that finished more than
20 checks between two polls never saw the oldest of them — they had already
scrolled off the first page by the time the next poll ran. Nothing failed and
nothing was logged; the rows simply never reached the Zap. 100 is the largest
page the API will return, so a run of more than 100 between polls can still
outrun it.

**Three new fields, all optional.** Each is blank by default; a blank field is
left out of the request entirely, so a Zap built before this release sends
exactly what it sent before and gets exactly what it got before.

- **Depth** on Verify a Claim — Standard or Low. Low costs 5 credits instead of
  10. It runs at most 3 searches against a 12-page reading limit, where Standard
  keeps searching until it has enough and reads up to 48, and its debate stops
  after both sides' opening arguments rather than letting them answer each
  other. The panel still sees both cases in full. Every step runs the same
  models, and framing, the panel and the conclusion are identical at both
  depths.
- **Visibility** on Verify a Claim — Private or Unlisted. Private is the default
  and means only your account can read the result. Unlisted makes it readable by
  anyone holding its Verification ID or its lenz.io link, which is what you want
  when the Zap posts that link to people without Lenz accounts. Unlisted results
  are never listed in the public Library and never appear in search.
- **Focus** on Extract Claims — a hint of up to 300 characters, e.g. "pricing and
  headcount", that costs nothing extra. It only selects from the claims Lenz
  already found; it cannot add a claim, reword one, or change what counts as a
  claim. Over 300 characters the step stops with the actual count instead of
  being shortened without saying so, which would return a subset of the claims
  with nothing to indicate it happened. It is checked when you click Test, not
  only on a live run, and it pauses the Zap rather than failing it — the value
  is fixed in the step, so a failure there would count against the Zap on every
  run for something no retry can fix.

**Two things to know before branching on them.**

Verify a Claim now also returns **Depth** and **Visibility** as outputs, and the
Depth output is not always the Depth you asked for. You are charged for the depth
you REQUEST; the output echoes the depth the verdict was PRODUCED with. Lenz can
answer a Low request from a Standard verdict it already holds — that run costs 5
and reads back "standard". The two are meant to differ, so a Zap comparing them
will see mismatches that are not errors.

**The verdict fields are on every result now.** Verify a Claim promised
`Passed`, `Verdict`, `Confidence`, `Lenz Score`, `Verification ID`, `Claim`,
`Key Finding`, `Executive Summary` and `Sources` in its sample, and then left
all nine OUT of any result that was not a finished verdict — a run that ended
in needs_input, failed, or was still processing. Zapier treats a missing field
and an empty one as different conditions, and the Zap editor builds filters
from the sample, so a filter like "Verdict is empty" tested clean while you were
building and then matched nothing on a live run. Nothing failed and nothing was
logged. They are now present and empty on those results, the same way the
failure fields already were.

`Passed` is empty rather than false on a result with no verdict: false would say
this claim did not pass, and nothing was checked.

**Sources are whole citations now.** Verify a Claim returned only a title and a
URL per source. The API sends five fields, always: the publication name, the
title, the URL, the **quoted passage** the verdict rests on, and the source's
publication date. A Zap could link a source but not quote it. All five are
returned and mappable, and Sources itself is now declared — it was being
returned without being declared, so it showed up in a test result and could not
be mapped into the next step.

The verdict also carries four fields it used to drop: **Language**, **Domain**,
**Warnings** (caveats the conclusion attached to this verdict, one line item
each) and **Created At**.

**Assess's per-claim fields can be mapped.** The action returns a claim, verdict,
confidence, passed and verification URL for each claim it assessed, but declared
only Status and Message — so the verdicts showed up in a test result and could
not be mapped into the next step. All five are declared now.

**Language is now a dropdown.** It was a free-text box described as "ISO 639-1",
but the API accepts exactly twelve codes — `en es de fr it pt nl sv da no fi bg` —
and refuses anything else with a 422. A 422 fails the run, so a Zap with
`English`, `en-US` or an unsupported code in that box failed EVERY time it ran,
and nothing in the editor said why. The dropdown can only offer values the
server accepts. If you have a Zap with a hand-typed value, re-pick it from the
list.

Two things about that field that were never written down:

- **It sets the language of the ANSWER, not of your input.** Lenz never inspects
  what language your text is in — this field alone decides what comes back.
- **Blank means something different on Ask Follow-Up.** On Verify a Claim,
  Assess and Extract Claims a blank field means English. On Ask Follow-Up it
  means the language the verification is stored in, so you can ask in English
  about a Spanish verification by leaving it blank.

Extract Claims gains a third Status value, `no_match`, which means claims WERE
found and the Focus excluded all of them. It is only reachable when a Focus is
set, so nothing that ran before this release can start returning it. It arrives
with a **Message** saying why the list is empty, because an empty list from a
Focus looks identical to "nothing here" otherwise. The unfocused claims are
deliberately never substituted.

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
