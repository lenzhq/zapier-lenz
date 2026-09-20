'use strict';

const { LenzError } = require('lenz-io');
const { mapLenzError } = require('../lib/errors');
const { lenzClient } = require('../client');
const { languageField } = require('../lib/languages');

function isPassingVerdict(verdict) {
  return verdict === 'True' || verdict === 'Mostly True';
}

// Realistic, internally coherent example (Eiffel Tower) — Zapier's build
// guidelines want representative sample values ("'Bob', not 'string'"), not
// placeholder text, for public review. The "this is a test sample" signal
// lives in the action description (shown above the fields) and in the two
// prose fields a user is likely to map into a downstream step on its own —
// key_finding and executive_summary — NOT in the structured field values. A
// coherent example also means a chained editor test (e.g. a final "send
// email" step) reads as example data, never a mismatched real result; that
// is why key_finding carries the marker too rather than a bare factual
// sentence, since outputFields points users at it as the short form of the
// summary. Live runs never use SAMPLE (performResume builds from the real
// status.result), so this only shows while testing.
const SAMPLE = {
  task_id: '2f8b2e2b6a4a4e6c9e8f9a6c3f4b2a1c',
  status: 'completed',
  passed: true,
  verification_id: 'ab12cd34',
  claim: 'The Eiffel Tower is 330 metres tall.',
  verdict: 'True',
  confidence: 'high',
  lenz_score: 9,
  key_finding:
    'Sample finding shown while testing in the Zap editor — a live, turned-on Zap returns the real finding for your claim.',
  executive_summary:
    'Sample summary shown while testing in the Zap editor — a live, turned-on Zap returns the real analysis for your claim.',
  sources: [
    {
      source_name: 'Tour Eiffel',
      title: 'Official Eiffel Tower site',
      url: 'https://www.toureiffel.paris',
      snippet: 'The tower stands 330 metres tall including its antennas.',
      // Publication date of the source article, not of the check. '' when the
      // research step could not determine one — the API normalises its
      // 'unknown' sentinel to '' (lenz/api/verification_payload.py:119), so
      // this is never null and never the literal "unknown".
      date: '2026-01-15',
    },
  ],
  language: 'en',
  domain: 'Science',
  // Caveats the conclusion attached to this verdict; [] on most claims. Wrapped
  // as line items rather than left as bare strings for the same reason as
  // Candidate Readings below: a string array is not mappable per-item.
  warnings: [],
  created_at: '2026-07-14T12:00:00Z',
  // Read-backs from the completed verdict. `depth` is what the verdict was
  // PRODUCED with, which can differ from what was requested — see the
  // completed branch in performResume. Empty on every non-completed branch.
  depth: 'standard',
  visibility: 'private',
  // Failure fields — empty on this happy-path sample; populated when a live
  // verification ends in status: 'failed'.
  error: '',
  failure_reason: '',
  failure_class: '',
  retryable: null,
  // needs_input fields — empty here; populated when Lenz stops to ask for
  // input instead of running the pipeline. See NO_INPUT_NEEDED.
  reason: '',
  message: '',
  claims: [],
  candidates: [],
  similar_claims: [],
  duplicate_verification_id: '',
  duplicate_url: '',
};

// The failure fields as they read when nothing failed. Spread into EVERY
// non-failed branch, because Zapier's Filter treats a MISSING field and an
// EMPTY one as different conditions ("does not exist" vs "is empty") — and the
// Zap editor builds those filters from SAMPLE, which promises all four. Omit
// them on the success path and a filter the user tested against the sample
// behaves differently on a live run.
const NO_FAILURE = { error: '', failure_reason: '', failure_class: '', retryable: null };

// The verdict fields as they read when there is no verdict yet, or never will
// be. Spread into EVERY branch that is not `completed`, for the same reason as
// NO_FAILURE and NO_INPUT_NEEDED: Zapier's Filter treats a MISSING field and an
// EMPTY one as different conditions, and the editor builds filters from SAMPLE,
// which promises all of them (fifteen keys: the nine verdict fields that
// shipped first, plus Depth, Visibility, Language, Domain, Warnings and
// Created At).
//
// This file argued that rule for the failure fields from the start and then did
// not apply it to the verdict ones — so a Zap filtering on "Verdict is empty"
// tested clean against the sample and then matched nothing on a live run that
// ended in needs_input or failed. No error, nothing to notice (#22).
//
// The empty VALUE per field mirrors what the completed branch itself falls back
// to (`|| null` vs `|| ''` vs `?? null` below), so a given field has the same
// type on every branch rather than being a string here and null there.
// `passed` is null, not false: there is no verdict, and false would assert this
// claim did NOT pass — the same reason `retryable` is null when nothing failed.
const NO_VERDICT = {
  passed: null,
  verification_id: null,
  claim: '',
  verdict: null,
  confidence: null,
  lenz_score: null,
  key_finding: '',
  executive_summary: '',
  sources: [],
  language: '',
  domain: '',
  warnings: [],
  created_at: '',
  depth: '',
  visibility: '',
};

// The needs_input fields as they read when Lenz did NOT stop for input. Same
// rule as NO_FAILURE, same reason: every branch carries every key.
const NO_INPUT_NEEDED = {
  reason: '',
  message: '',
  claims: [],
  candidates: [],
  similar_claims: [],
  duplicate_verification_id: '',
  duplicate_url: '',
};

// Lenz can stop a verification to ask for input rather than run the pipeline,
// and it does so for THREE different reasons that need three different
// responses. Until 1.4.0 all three collapsed into one "rephrase and re-run"
// message and the data Lenz offered was thrown away. For duplicate_found that
// advice was actively wrong: a verification of the claim already EXISTS, and
// re-running spends a full 10-credit pipeline to reproduce it.
//
// The server shapes (lenz/api/public_authed.py, /verify/status):
//   multi_claim             claims:         [{ text, domain }]
//   clarification_required  candidates:     [string]
//   duplicate_found         similar_claims: [{ verification_id, claim, verdict,
//                                              confidence, lenz_score, url,
//                                              distance }]
//
// `candidates` is normalised to `[{ text }]` so all three lists share the
// line-item shape a Zap can iterate; a bare string array is not mappable
// per-item in the editor.
function shapeNeedsInput(status) {
  const reason = status.reason || '';
  const claims = (status.claims || []).map((c) => ({ text: c.text || '', domain: c.domain || '' }));
  const candidates = (status.candidates || []).map((text) => ({ text: String(text || '') }));
  const similar = (status.similar_claims || []).map((s) => ({
    verification_id: s.verification_id || '',
    claim: s.claim || '',
    verdict: s.verdict || '',
    confidence: s.confidence || '',
    lenz_score: s.lenz_score ?? null,
    url: s.url || '',
  }));
  const first = similar[0] || {};

  let message;
  if (reason === 'multi_claim') {
    message =
      `Lenz found ${claims.length} separate claims in this input. Each needs its own check — ` +
      'send them one at a time, or map the Claims Found list into a Verify a Claim step per item.';
  } else if (reason === 'clarification_required') {
    message =
      `This claim can be read ${candidates.length} ways. Pick one of the Candidate Readings and ` +
      're-run with that exact wording.';
  } else if (reason === 'duplicate_found') {
    // NOT "rephrase and re-run". The check already exists; reusing it costs
    // nothing, and it feeds straight into Ask Follow-Up.
    message =
      `This claim has already been verified (${first.verification_id || 'see Similar Claims'}). ` +
      'Reusing it costs nothing: map Duplicate Verification ID into Ask Follow-Up, or open ' +
      'Duplicate URL. Re-running would spend a full check for the same answer.';
  } else {
    message = `Lenz needs more input before it can verify this claim (reason: ${reason || 'unknown'}).`;
  }

  return {
    reason,
    message,
    claims,
    candidates,
    similar_claims: similar,
    duplicate_verification_id: first.verification_id || '',
    duplicate_url: first.url || '',
  };
}

// Kicks off the full pipeline and hands Lenz a Zapier-managed callback URL as
// the per-call webhook_url. Zapier parks the Task as "waiting" until Lenz
// posts back to that URL (see performResume) or ~90s median passes.
const perform = async (z, bundle) => {
  const client = lenzClient(bundle);

  // Editor testing (isLoadingSample) never runs the real ~90s pipeline and
  // never spends verify credits — Zapier's recommended handling for a
  // callback action. But rather than stubbing blindly, we make the ONE free
  // call that costs nothing (GET /me/usage — no credits) to answer the only
  // question the stub otherwise can't: does this key have a webhook secret?
  // Verify a Claim REQUIRES one (it always sends a callback webhook_url, which
  // Lenz refuses on a secret-less key). If it's missing, warn NOW at test time
  // instead of showing a false "accepted" and only failing on the first live
  // run. usage() also re-validates auth for free.
  //
  // Strict `=== false`: older servers that don't yet return the field leave it
  // undefined, so the check is a no-op there (plain stub) — the backend field
  // and this check can deploy in any order.
  if (bundle.meta && bundle.meta.isLoadingSample) {
    // Mapped like every other call: this is the FIRST place a revoked key
    // surfaces (the user clicking Test in the editor), so it's the last place
    // that should throw a raw SDK error instead of an ExpiredAuthError.
    const usage = await client.usage().catch((err) => mapLenzError(z, err));
    if (usage && usage.has_webhook_secret === false) {
      throw new z.errors.Error(
        'Verify a Claim needs a webhook secret on this API key, and this key doesn\'t have one yet. ' +
          'Go to lenz.io → API key settings → "Generate webhook secret" (Webhooks panel) once, then try this step again. ' +
          '(Assess, Extract Claims, and Ask Follow-Up work without a secret.)',
        'WebhookSecretMissing',
        422,
      );
    }
    return { ...SAMPLE };
  }

  const callbackUrl = z.generateCallbackUrl();

  return client
    .verify({
      claim: bundle.inputData.claim,
      sourceUrl: bundle.inputData.sourceUrl || undefined,
      language: bundle.inputData.language || undefined,
      // `|| undefined` so a blank field is omitted from the request body
      // entirely and the server applies its own default, rather than us
      // sending an empty string it would have to interpret.
      depth: bundle.inputData.depth || undefined,
      visibility: bundle.inputData.visibility || undefined,
      webhookUrl: callbackUrl,
    })
    // Every key on every branch (see NO_FAILURE). This is what Zapier parks
    // as outputData and, if the callback never arrives, what the user sees.
    .then((accepted) => ({
      task_id: accepted.task_id,
      status: 'processing',
      ...NO_FAILURE,
      ...NO_INPUT_NEEDED,
      ...NO_VERDICT,
    }))
    .catch((err) => {
      // Lenz rejects webhook_url on a key with no signing secret yet, tagged
      // with this machine-readable code (public_authed.py) — turn it into a
      // precise, actionable message instead of the raw API error text.
      //
      // HaltedError, not Error. This is a permanent CONFIGURATION state for
      // this action, not a failed execution: the key has no webhook secret, so
      // Verify cannot get its callback, and retrying cannot change that. As a
      // hard error every scheduled run counted toward the error rate that
      // turns a Zap off — the same auto-disable pressure the 402 branch was
      // moved to HaltedError to avoid. The isLoadingSample pre-check above
      // catches most of this at test time, but a secret removed after the Zap
      // is on, or a Zap built by mapping without testing, lands here on every
      // single run.
      //
      // HaltedError takes only a message — no code or status argument — so the
      // 'WebhookSecretMissing'/422 pair the old throw carried is gone; it never
      // reached the user anyway.
      if (err instanceof LenzError && err.body && err.body.code === 'webhook_secret_missing') {
        throw new z.errors.HaltedError(
          'This API key doesn\'t have a webhook secret yet. Go to lenz.io → API key ' +
            'settings → "Generate webhook secret" (Webhooks panel) once, then turn this Zap ' +
            'back on.',
        );
      }
      return mapLenzError(z, err);
    });
};

// Lenz's webhook POST is only the wake-up signal here — the terminal result
// is fetched fresh via getStatus() so this never depends on how Zapier
// represents the raw callback body (bundle.cleanedRequest / rawRequest).
const performResume = async (z, bundle) => {
  const client = lenzClient(bundle);
  const status = await client
    .getStatus(bundle.outputData.task_id)
    .catch((err) => mapLenzError(z, err));

  if (status.status === 'completed' && status.result) {
    const result = status.result;
    return {
      task_id: bundle.outputData.task_id,
      status: 'completed',
      passed: isPassingVerdict(result.verdict),
      verification_id: result.verification_id || null,
      claim: result.claim || '',
      verdict: result.verdict || null,
      confidence: result.confidence || null,
      lenz_score: result.lenz_score ?? null,
      key_finding: result.key_finding || '',
      executive_summary: result.executive_summary || '',
      // All five keys, not just title and url. The API always sends all five
      // (lenz/api/verification_payload.py:124-133) and uses '' rather than
      // null for a missing one, so the `|| ''` here is belt-and-braces for an
      // older server. snippet is the quotable half of a citation — dropping it
      // meant a Zap could link a source but never quote it.
      sources: (result.sources || []).map((s) => ({
        source_name: s.source_name || '',
        title: s.title || '',
        url: s.url || '',
        snippet: s.snippet || '',
        date: s.date || '',
      })),
      language: result.language || '',
      domain: result.domain || '',
      // Bare strings on the wire; wrapped as line items so a Zap can iterate
      // them, matching how Candidate Readings is handled.
      warnings: (result.warnings || []).map((text) => ({ text: String(text || '') })),
      created_at: result.created_at || '',
      // The depth the verdict was actually PRODUCED with, which is not always
      // the one requested: a `low` request Lenz can answer from an existing
      // `standard` verdict reads back `standard`. The echo describes the
      // evidence; the charge follows the request. Without this field there is
      // no way to tell the two apart. Empty on verdicts from before the field.
      depth: result.depth || '',
      visibility: result.visibility || '',
      ...NO_FAILURE,
      ...NO_INPUT_NEEDED,
    };
  }

  if (status.status === 'needs_input') {
    return {
      task_id: bundle.outputData.task_id,
      status: 'needs_input',
      ...NO_FAILURE,
      ...NO_VERDICT,
      ...shapeNeedsInput(status),
    };
  }

  // A terminal failure. failure_class is a closed set (upstream_unavailable |
  // insufficient_evidence | invalid_input | cancelled | internal); retryable is
  // true only for upstream_unavailable. Both are absent on verifications older
  // than 2026-08 — explicit fields so a Filter/Paths step can branch on WHY,
  // not parse prose.
  if (status.status === 'failed') {
    return {
      task_id: bundle.outputData.task_id,
      status: 'failed',
      error: status.error || status.failure_reason || 'Pipeline failed.',
      failure_reason: status.failure_reason || '',
      failure_class: status.failure_class || '',
      retryable: status.retryable ?? null,
      ...NO_INPUT_NEEDED,
      ...NO_VERDICT,
    };
  }

  // Anything else: Lenz's callback fired before the pipeline reached a terminal
  // state. This is NOT a failure — the task is still running and will most
  // likely complete. Reporting it as 'failed' would send retryable: null, which
  // asserts "re-running this will not help" about a live task, so a Zap
  // branching on that field raises a false alarm on a verification that is
  // about to succeed. Surface the real status and leave the failure fields
  // empty; a Zap gating on `status is completed` still correctly skips it.
  // `message` is set AFTER the NO_INPUT_NEEDED spread so it wins: the spread
  // carries an empty message, and this branch has something to say.
  return {
    task_id: bundle.outputData.task_id,
    status: status.status || 'processing',
    ...NO_FAILURE,
    ...NO_INPUT_NEEDED,
    ...NO_VERDICT,
    message:
      'Lenz signalled before this verification reached a terminal state — it is still ' +
      'running. Look it up by Task ID in Lenz, or re-run this Zap.',
  };
};

module.exports = {
  key: 'verify_claim',
  noun: 'Verification',
  display: {
    label: 'Verify a Claim',
    // Zapier's build guidelines: concise, opens with a singular third-person
    // verb, ends with a period, and carries no platform name. The
    // webhook-secret requirement and the "Test returns a sample" note used to
    // sit here; both moved to help text, which is where Zapier asks for extra
    // detail and the only place Markdown is documented to render.
    description:
      'Runs the full fact-checking pipeline on one claim — research, debate, and panel review — and returns a sourced verdict with score and citations. Takes about 90 seconds.',
  },
  operation: {
    inputFields: [
      {
        key: 'claim',
        label: 'Claim',
        type: 'text',
        required: true,
        helpText:
          'The claim to investigate in depth. Up to 10,000 characters; longer input is cut off without warning. This action needs a webhook secret on your Lenz API key — generate it once under API key settings → Webhooks. Clicking Test shows an example verdict so you can map the output fields; a turned-on Zap verifies this claim and returns the real result.',
      },
      {
        key: 'sourceUrl',
        label: 'Source URL',
        type: 'string',
        required: false,
        helpText: 'Optional URL the claim was found on.',
      },
      languageField(),
      {
        // Half price, and that is the reason to offer it at all:
        // VERIFY_DEPTH_COSTS in lenz/billing.py is {standard: 10, low: 5}.
        //
        // What `low` actually cuts, from the server's own tables — do not
        // describe it as "same reasoning, less evidence", which is the phrase
        // lenz/constants.py uses and then immediately qualifies:
        //   RESEARCH_DEPTH_PROFILES[low] = max_queries 3 (vs unbounded),
        //     extraction_ceiling 12 (vs 48), grounded_discovery False.
        //   DEBATE_DEPTH_PROFILES[low]   = rebuttals False — the debate stops
        //     after the openings. That is a REASONING step, not an evidence
        //     one, and it is the contract's one stated exception, so the help
        //     text names it rather than promising identical reasoning.
        // Framing, the panel and the conclusion are depth-blind, and no step
        // swaps models.
        //
        // NOTE the installed SDK's own docstring for this field says "same
        // quota cost" (lenz-io 2.9.0, types.ts:578) — that is stale, and the
        // same file contradicts it at :414 with "5 — half price". The server
        // is authoritative. Do not "correct" this help text from the SDK
        // comment.
        //
        // The charge/echo split needs saying, because it reads as a billing
        // bug otherwise: you are charged for the depth you REQUESTED, but the
        // Depth OUTPUT echoes the depth the verdict was actually produced
        // with. A Low request Lenz answers from an existing standard verdict
        // therefore costs 5 and reads back "standard".
        key: 'depth',
        label: 'Depth',
        type: 'string',
        required: false,
        // `sample` duplicates `value` on every choice because
        // FieldChoiceWithLabelSchema REQUIRES it and says it "should match the
        // value" — it is a legacy key the editor no longer reads, but omitting
        // it fails `zapier validate` and blocks the push. Not a copy-paste slip.
        choices: [
          { value: 'standard', sample: 'standard', label: 'Standard — full research (10 credits)' },
          { value: 'low', sample: 'low', label: 'Low — fewer sources, half the credits (5)' },
        ],
        helpText:
          'How much work the check does. Leave blank for Standard. **Low costs 5 credits instead of 10**: it runs at most 3 searches against a 12-page reading limit instead of searching until it has enough, and its debate stops after the opening arguments from both sides rather than letting them answer each other. Same models at every step, and the panel and conclusion are identical. You are charged for the depth you request: a Low request that Lenz can answer from an existing Standard verdict still costs 5, and the Depth output then reads "standard" because it describes the evidence behind the verdict, not the request.',
      },
      {
        key: 'visibility',
        label: 'Visibility',
        type: 'string',
        required: false,
        // See the note on Depth's choices: `sample` is a required legacy key.
        choices: [
          { value: 'private', sample: 'private', label: 'Private — only you can see it' },
          { value: 'unlisted', sample: 'unlisted', label: 'Unlisted — anyone with the link' },
        ],
        helpText:
          'Leave blank for Private, which is the default and means only your account can read the result. Unlisted makes it readable by anyone holding its Verification ID or its lenz.io link, but it is never listed in the public Library or search.',
      },
    ],
    perform,
    performResume,
    sample: SAMPLE,
    outputFields: [
      { key: 'task_id', label: 'Task ID' },
      { key: 'status', label: 'Status' },
      { key: 'passed', label: 'Passed', type: 'boolean' },
      { key: 'verification_id', label: 'Verification ID' },
      { key: 'claim', label: 'Claim' },
      { key: 'verdict', label: 'Verdict' },
      { key: 'confidence', label: 'Confidence' },
      { key: 'lenz_score', label: 'Lenz Score', type: 'integer' },
      // One declarative sentence stating the finding — the short form to map
      // into a Slack/email step when the full summary is too long. Empty on
      // claims that pre-date the field.
      { key: 'key_finding', label: 'Key Finding' },
      { key: 'executive_summary', label: 'Executive Summary' },
      // Failure fields — populated only when Status is 'failed', so a
      // Filter/Paths step can branch on WHY instead of parsing prose.
      //
      // No `helpText` on any of these: it is an INPUT-field property, and
      // PlainOutputFieldSchema rejects it outright ("is not allowed to have the
      // additional property"), which fails `zapier validate` and blocks the
      // push. Zapier gives output fields no per-field help affordance at all —
      // the editor renders them as bare labels — so what each one means is
      // documented here and in the action description instead.
      //
      //   error           Human-readable failure message. Empty on success.
      //   failure_reason  Where the pipeline stopped, e.g. 'research_empty'.
      //   failure_class   Why, from a closed set: upstream_unavailable |
      //                   insufficient_evidence | invalid_input | cancelled |
      //                   internal. Empty on verifications older than 2026-08.
      //   retryable       True only for upstream_unavailable — re-running that
      //                   same claim later can succeed. Every other class means
      //                   retrying the same input will not help.
      { key: 'error', label: 'Error' },
      { key: 'failure_reason', label: 'Failure Reason' },
      { key: 'failure_class', label: 'Failure Class' },
      { key: 'retryable', label: 'Retryable', type: 'boolean' },
      // needs_input fields — populated only when Status is 'needs_input',
      // empty otherwise. Which of the three lists is filled depends on Reason:
      //
      //   reason           multi_claim | clarification_required |
      //                    duplicate_found
      //   message          What to do about it, in a sentence.
      //   claims           multi_claim: the separate claims Lenz found, one
      //                    line item each — fan out into a Verify step per item.
      //   candidates       clarification_required: the possible readings, one
      //                    line item each — pick one and re-run with it.
      //   similar_claims   duplicate_found: verifications that already exist
      //                    for this claim.
      //   duplicate_verification_id / duplicate_url
      //                    The first of those, lifted out so it maps straight
      //                    into Ask Follow-Up without a line-item step.
      { key: 'reason', label: 'Input Needed Reason' },
      { key: 'message', label: 'Message' },
      {
        key: 'claims',
        label: 'Claims Found',
        list: true,
        children: [
          { key: 'text', label: 'Claim' },
          { key: 'domain', label: 'Domain' },
        ],
      },
      {
        key: 'candidates',
        label: 'Candidate Readings',
        list: true,
        children: [{ key: 'text', label: 'Reading' }],
      },
      {
        key: 'similar_claims',
        label: 'Similar Claims',
        list: true,
        children: [
          { key: 'verification_id', label: 'Verification ID' },
          { key: 'claim', label: 'Claim' },
          { key: 'verdict', label: 'Verdict' },
          { key: 'confidence', label: 'Confidence' },
          { key: 'lenz_score', label: 'Lenz Score', type: 'integer' },
          { key: 'url', label: 'URL' },
        ],
      },
      { key: 'duplicate_verification_id', label: 'Duplicate Verification ID' },
      { key: 'duplicate_url', label: 'Duplicate URL' },
      // Sources were returned but never DECLARED, so the citations behind a
      // verdict could be seen in a test result and not mapped into the next
      // step (#22). Declared as line items with all five keys the API sends.
      {
        key: 'sources',
        label: 'Sources',
        list: true,
        children: [
          { key: 'source_name', label: 'Source Name' },
          { key: 'title', label: 'Title' },
          { key: 'url', label: 'URL' },
          // The quotable half of a citation.
          { key: 'snippet', label: 'Snippet' },
          // Publication date of the source, not of this check.
          { key: 'date', label: 'Published' },
        ],
      },
      // Passthroughs the API always sends and this action used to drop.
      //
      //   language    The language the verdict is written in.
      //   domain      Capitalised, or '' when the extractor produced none —
      //               the same vocabulary the trigger and Extract emit.
      //   warnings    Caveats the conclusion attached to this verdict, one
      //               line item each. [] on most claims.
      //   created_at  When the verification was created.
      { key: 'language', label: 'Language' },
      { key: 'domain', label: 'Domain' },
      {
        key: 'warnings',
        label: 'Warnings',
        list: true,
        children: [{ key: 'text', label: 'Warning' }],
      },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
      // Read-backs, populated only on a completed verdict.
      //
      //   depth       The depth the verdict was PRODUCED with — not always
      //               the one requested. A Low request served from an existing
      //               Standard verdict is charged 5 and reads "standard".
      //   visibility  "private" or "unlisted", echoing what was submitted.
      { key: 'depth', label: 'Depth' },
      { key: 'visibility', label: 'Visibility' },
    ],
  },
};
