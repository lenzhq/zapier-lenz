# Changelog

User-facing changes to the Lenz integration for Zapier. Build and release
mechanics live in [README.md](README.md#building-and-pushing).

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
