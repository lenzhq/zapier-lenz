/* globals describe, it, expect, jest */

// Every field the app reads, against BOTH response shapes of the Lenz API.
//
// `test/fixtures/legacy/*.json` are the bodies the API has always sent;
// `test/fixtures/dated/*.json` are the same responses in the dated shape
// (`failure` blocks, `status: failed` rows, `claims` on an extraction,
// `completed_at`, ...). Each case runs the same action code over both and
// expects the SAME output, because a saved Zap maps and filters on the output
// and must not notice which shape arrived. Run-specific values in the
// fixtures were replaced with realistic ones.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');

const appTester = zapier.createAppTester(App);

const SHAPES = ['legacy', 'dated'];
const fx = (shape, name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', shape, `${name}.json`), 'utf-8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const SECRET = 'whsec_test';
const AUTH = { access_token: 'lat_good', webhook_secret: SECRET };
const TASK_ID = '2f8b2e2b6a4a4e6c9e8f9a6c3f4b2a1c';

const mockClient = (over = {}) => {
  const client = { assess: jest.fn(), extract: jest.fn(), getStatus: jest.fn(), request: jest.fn(), ...over };
  LenzClient.mockImplementation(() => client);
  return client;
};

const sign = (body) =>
  `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(body, 'utf-8')).digest('hex')}`;

// A signed callback as Zapier hands it over.
const signed = (payload) => {
  const content = JSON.stringify({ ...payload, delivered_at: new Date().toISOString() });
  return { content, headers: { 'Http-Content-Type': 'application/json', 'Http-X-Lenz-Signature': sign(content) } };
};

const capture = (fn, bundle) =>
  appTester(fn, bundle).then(
    () => null,
    (e) => e,
  );

// ─── Assess ─────────────────────────────────────────────────────────────────

describe.each(SHAPES)('creates.assess reads the %s shape', (shape) => {
  const assess = App.creates.assess.operation;
  const run = async (name, edit) => {
    const body = fx(shape, name);
    if (edit) edit(body);
    mockClient({ assess: jest.fn().mockResolvedValue(body) });
    return appTester(assess.perform, { authData: AUTH, inputData: { text: 'x' } });
  };

  it('a text with nothing checkable', async () => {
    const out = await run('assess__single_no_claim');
    expect(out).toMatchObject({ status: 'no_claim', not_a_claim: true, claims: [], candidate_claims: [] });
    expect(out.message).toMatch(/\S/);
  });

  it('one checked claim', async () => {
    const out = await run('assess__single_one_claim');
    expect(out).toMatchObject({ status: 'ok', not_a_claim: false, message: '', candidate_claims: [] });
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({
      verdict: 'True',
      passed: true,
      error_code: '',
      hint: '',
      identified_claims: [],
    });
  });

  it('rows with no verdict read as Error / low / no_claim, and say nothing is checkable', async () => {
    const out = await run('assess__list_all_error_rows');
    expect(out.status).toBe('ok');
    expect(out.not_a_claim).toBe(true);
    expect(out.claims.map((c) => [c.verdict, c.confidence, c.passed, c.error_code])).toEqual([
      ['Error', 'low', false, 'no_claim'],
      ['Error', 'low', false, 'no_claim'],
    ]);
    expect(out.claims[0].hint).toMatch(/Send one factual claim/);
    expect(out.claims[0].identified_claims).toEqual([]);
  });

  it('a mixed wave keeps the verdict row and names each cause', async () => {
    const out = await run('assess__list_mixed_rows');
    expect(out.not_a_claim).toBe(false);
    expect(out.claims.map((c) => [c.verdict, c.error_code])).toEqual([
      ['True', ''],
      ['Error', 'no_claim'],
      ['Error', 'upstream_unavailable'],
      ['Error', 'framing_failed'],
    ]);
    expect(out.claims[2].hint).toMatch(/Retry it; nothing was charged/);
  });

  it('the claims a compound item held back', async () => {
    const out = await run('assess__list_compound_item');
    expect(out.claims[0].identified_claims).toEqual(['Second claim.', 'Third claim.']);
    expect(out.claims[0].hint).toMatch(/main claim only/);
    expect(out.claims[1].identified_claims).toEqual([]);
  });

  it('replays when every row is a transient failure, nothing charged', async () => {
    const err = await capture(assess.perform, {
      authData: AUTH,
      inputData: { text: 'x' },
      ...(() => {
        const body = fx(shape, 'assess__list_mixed_rows');
        body.claims = body.claims.filter((c) => c.claim === 'vendor is down');
        mockClient({ assess: jest.fn().mockResolvedValue(body) });
        return {};
      })(),
    });
    expect(err.name).toBe('ThrottledError');
    expect(JSON.parse(err.message).message).toMatch(/upstream_unavailable.*nothing was charged/);
  });

  it('answers a mixed wave with a transient row instead of replaying', async () => {
    const out = await run('assess__list_mixed_rows');
    expect(out.status).toBe('ok');
  });

  it('does not replay a row that will not change (framing_failed)', async () => {
    const body = fx(shape, 'assess__list_mixed_rows');
    body.claims = body.claims.filter((c) => c.claim === 'cannot frame');
    mockClient({ assess: jest.fn().mockResolvedValue(body) });
    const out = await appTester(assess.perform, { authData: AUTH, inputData: { text: 'x' } });
    expect(out.claims[0]).toMatchObject({ verdict: 'Error', error_code: 'framing_failed' });
  });
});

describe('creates.assess: a failed row replays on status alone', () => {
  const assess = App.creates.assess.operation;

  it('a dated row with status failed and a transient failure code', async () => {
    mockClient({
      assess: jest.fn().mockResolvedValue({
        status: 'error',
        claims: [
          {
            claim: 'x',
            status: 'failed',
            verdict: null,
            confidence: null,
            more_claims: [],
            failure: { code: 'timeout', detail: 'Out of time.', hint: 'Retry.', failure_class: 'upstream_unavailable', retryable: true },
          },
        ],
        failure: null,
        more_claims: [],
      }),
    });
    const err = await capture(assess.perform, { authData: AUTH, inputData: { text: 'x' } });
    expect(err.name).toBe('ThrottledError');
  });

  it('a dated top-level status of no_checkable_claim with no rows', async () => {
    mockClient({
      assess: jest
        .fn()
        .mockResolvedValue({ status: 'no_checkable_claim', claims: [], failure: { code: 'no_checkable_claim', detail: 'Nothing to check.' }, more_claims: [] }),
    });
    const out = await appTester(assess.perform, { authData: AUTH, inputData: { text: 'x' } });
    expect(out).toMatchObject({ status: 'no_claim', not_a_claim: true, message: 'Nothing to check.' });
  });
});

// ─── Extract Claims ─────────────────────────────────────────────────────────

describe.each(SHAPES)('creates.extract_claims reads the %s shape', (shape) => {
  const extract = App.creates.extract_claims.operation;
  const run = async (name) => {
    mockClient({ extract: jest.fn().mockResolvedValue(fx(shape, name)) });
    return appTester(extract.perform, { authData: AUTH, inputData: { text: 'x' } });
  };

  it('several claims', async () => {
    const out = await run('extract__ready_several_claims');
    expect(out).toMatchObject({
      status: 'ready',
      not_a_claim: false,
      claim: 'Alpha rose 5% in 2024.',
      identified_claims: ['Alpha rose 5% in 2024.', 'Beta fell 3% last year.'],
      candidate_claims: [],
      message: '',
    });
    expect(out.claims.map((c) => c.claim)).toEqual(['Alpha rose 5% in 2024.', 'Beta fell 3% last year.']);
  });

  it('one claim leaves identified_claims empty', async () => {
    const out = await run('extract__ready_one_claim');
    expect(out.status).toBe('ready');
    expect(out.claim).toMatch(/\S/);
    expect(out.identified_claims).toEqual([]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].claim).toBe(out.claim);
  });

  it('nothing checkable keeps the status not_a_claim', async () => {
    const out = await run('extract__not_a_claim');
    expect(out).toMatchObject({ status: 'not_a_claim', not_a_claim: true, claim: '', identified_claims: [], claims: [] });
  });

  it('no_match under a Focus', async () => {
    const out = await run('extract__no_match_with_focus');
    expect(out.status).toBe('no_match');
    expect(out.not_a_claim).toBe(false);
    expect(out.message).toMatch(/none of them fall within your Focus/);
  });
});

// ─── Verify a Claim ─────────────────────────────────────────────────────────

describe.each(SHAPES)('creates.verify_claim reads the %s shape', (shape) => {
  const verify = App.creates.verify_claim.operation;
  const resume = (extra = {}) => ({ authData: AUTH, outputData: { task_id: TASK_ID }, ...extra });
  const viaStatus = async (name) => {
    mockClient({ getStatus: jest.fn().mockResolvedValue(fx(shape, name)) });
    return appTester(verify.performResume, resume());
  };

  it('a completed poll', async () => {
    const out = await viaStatus('verify__status_completed');
    expect(out).toMatchObject({ status: 'completed', passed: true, verdict: 'True', error: '', failure_reason: '' });
    expect(out.verification_id).toMatch(/\S/);
  });

  it('a failed poll: stage, class and retryable', async () => {
    const out = await viaStatus('verify__status_failed_live');
    expect(out).toMatchObject({
      status: 'failed',
      failure_reason: 'research_empty',
      failure_class: 'insufficient_evidence',
      retryable: false,
    });
    expect(out.error).toMatch(/\S/);
    expect(out.verdict).toBeNull();
  });

  it('a failed poll from the stored record', async () => {
    const out = await viaStatus('verify__status_failed_durable');
    expect(out).toMatchObject({ failure_reason: 'conclusion_failed', failure_class: 'internal', retryable: false });
    expect(out.error).toMatch(/\S/);
  });

  it('nothing checkable keeps failure_reason not_a_claim', async () => {
    const out = await viaStatus('verify__status_not_a_claim');
    expect(out).toMatchObject({ status: 'failed', failure_reason: 'not_a_claim', failure_class: 'invalid_input', retryable: false });
    expect(out.error).toMatch(/\S/);
  });

  it('needs_input options read as Claims Found with a text key', async () => {
    const out = await viaStatus('verify__status_needs_input');
    expect(out.status).toBe('needs_input');
    expect(out.reason).toBe('multi_claim');
    expect(out.claims).toEqual([
      { text: 'The Earth is round.', domain: 'Science' },
      { text: 'Water boils at 100C at sea level.', domain: 'Science' },
    ]);
  });
});

// The signed callback. The earlier payload is flat (`result`, `error`); the
// enveloped one nests the same body a poll returns under `verification`.
describe('creates.verify_claim reads the signed callback in both shapes', () => {
  const verify = App.creates.verify_claim.operation;
  const bundle = (payload) => ({ authData: AUTH, outputData: { task_id: TASK_ID }, rawRequest: signed(payload) });
  const envelope = (event, verification) => ({
    event,
    event_id: 'evt_0123456789abcdef01234567',
    task_id: TASK_ID,
    verification_id: null,
    status: verification.status,
    verification,
    attempt: 1,
  });

  it('completed, flat', async () => {
    const out = await appTester(verify.performResume, bundle(fx('legacy', 'webhook__verification_completed')));
    expect(out).toMatchObject({ status: 'completed', passed: false, verdict: 'False' });
  });

  it('completed, nested', async () => {
    const poll = fx('dated', 'verify__status_completed');
    const out = await appTester(verify.performResume, bundle(envelope('verification.completed', poll)));
    expect(out).toMatchObject({ status: 'completed', passed: true, verdict: 'True', verification_id: poll.result.verification_id });
  });

  it('failed, flat: the code stays in error, as before', async () => {
    const out = await appTester(verify.performResume, bundle(fx('legacy', 'webhook__verification_failed_not_a_claim')));
    expect(out).toMatchObject({ status: 'failed', error: 'not_a_claim', failure_class: 'invalid_input', retryable: false });
  });

  it('failed, nested: the sentence is error, the earlier code is failure_reason', async () => {
    const poll = fx('dated', 'verify__status_not_a_claim');
    const out = await appTester(verify.performResume, bundle(envelope('verification.failed', poll)));
    expect(out).toMatchObject({
      status: 'failed',
      failure_reason: 'not_a_claim',
      failure_class: 'invalid_input',
      retryable: false,
    });
    expect(out.error).toBe(poll.failure.detail);
  });

  it('failed with a retryable cause, nested', async () => {
    const poll = fx('dated', 'verify__status_failed_live');
    poll.failure = { ...poll.failure, code: 'framing_failed', failure_class: 'upstream_unavailable', retryable: true };
    const out = await appTester(verify.performResume, bundle(envelope('verification.failed', poll)));
    expect(out).toMatchObject({ failure_reason: 'framing_failed', failure_class: 'upstream_unavailable', retryable: true });
  });

  it('failed, flat, with a retryable cause', async () => {
    const out = await appTester(verify.performResume, bundle(fx('legacy', 'webhook__verification_failed_upstream_unavailable')));
    expect(out).toMatchObject({ error: 'framing_failed', failure_class: 'upstream_unavailable', retryable: true });
  });
});

// ─── New Verification Completed ─────────────────────────────────────────────

describe.each(SHAPES)('triggers.new_verification reads the %s shape', (shape) => {
  const trigger = App.triggers.new_verification.operation;
  const run = (items) => {
    mockClient({ request: jest.fn().mockResolvedValue({ items, total: items.length, page: 1, page_size: 100 }) });
    return appTester(trigger.perform, { authData: AUTH });
  };

  it('a listed verification carries both completion keys', async () => {
    const [item] = await run(fx(shape, 'verify__list_200').items);
    expect(item).toMatchObject({ id: item.verification_id, claim: 'The Earth is round.' });
    expect(item).toHaveProperty('modified_at');
    expect(item).toHaveProperty('completed_at');
    expect(item.suggested_rewrite).toBe('');
  });
});

describe('triggers.new_verification: completion time across the two names', () => {
  const trigger = App.triggers.new_verification.operation;
  const run = (item) => {
    mockClient({ request: jest.fn().mockResolvedValue({ items: [item], total: 1, page: 1, page_size: 100 }) });
    return appTester(trigger.perform, { authData: AUTH }).then((r) => r[0]);
  };
  const base = { verification_id: 'ab12cd34', claim: 'A', verdict: 'True' };

  it('completed_at on a later UTC day than created_at is also modified_at', async () => {
    const out = await run({ ...base, created_at: '2026-10-07T23:59:00Z', completed_at: '2026-10-08T00:02:00Z' });
    expect(out).toMatchObject({ completed_at: '2026-10-08T00:02:00Z', modified_at: '2026-10-08T00:02:00Z' });
  });

  it('completed_at on the day of creation leaves modified_at null, as before', async () => {
    const out = await run({ ...base, created_at: '2026-10-08T08:00:00Z', completed_at: '2026-10-08T17:30:00Z' });
    expect(out).toMatchObject({ completed_at: '2026-10-08T17:30:00Z', modified_at: null });
  });

  it('an earlier-shape item keeps its modified_at and reads it as completed_at', async () => {
    const out = await run({ ...base, created_at: '2026-10-07T10:00:00Z', modified_at: '2026-10-08T09:00:00Z' });
    expect(out).toMatchObject({ completed_at: '2026-10-08T09:00:00Z', modified_at: '2026-10-08T09:00:00Z' });
  });

  it('an earlier-shape item with a null modified_at stays null', async () => {
    const out = await run({ ...base, created_at: '2026-10-08T10:00:00Z', modified_at: null });
    expect(out).toMatchObject({ completed_at: null, modified_at: null });
  });
});

// ─── Review a Draft and Check Citations ─────────────────────────────────────

describe.each(SHAPES)('creates.review_draft reads the %s shape', (shape) => {
  const review = App.creates.review_draft.operation;

  it('a review of nothing checkable fails as no_claim', async () => {
    const body = fx(shape, 'review__get_failed_no_claim');
    mockClient({ getReview: jest.fn().mockResolvedValue(body) });
    const out = await appTester(review.performResume, {
      authData: {},
      outputData: { review_id: body.review_id },
    });
    expect(out).toMatchObject({ status: 'failed', failure_reason: 'no_claim', failure_class: 'invalid_input', retryable: false });
    expect(out.error).toMatch(/Send one factual claim/);
  });

  it('a review where every claim failed keeps its code and counts them', async () => {
    const body = fx(shape, 'review__get_failed_every_assessment_failed');
    mockClient({ getReview: jest.fn().mockResolvedValue(body) });
    const out = await appTester(review.performResume, { authData: {}, outputData: { review_id: body.review_id } });
    expect(out).toMatchObject({
      outcome: 'incomplete',
      failure_reason: 'assessment_failed',
      failure_class: 'upstream_unavailable',
      retryable: true,
      unchecked_claims: 2,
    });
  });

  it('the signed failed callback', async () => {
    const payload = fx(shape, 'webhook__review_failed');
    const out = await appTester(review.performResume, {
      authData: AUTH,
      outputData: { review_id: payload.review_id },
      rawRequest: signed(payload),
    });
    expect(out).toMatchObject({ status: 'failed', failure_reason: 'no_claim', failure_class: 'invalid_input', retryable: false });
  });

  it('the signed completed callback', async () => {
    const payload = fx(shape, 'webhook__review_completed');
    const out = await appTester(review.performResume, {
      authData: AUTH,
      outputData: { review_id: payload.review_id },
      rawRequest: signed(payload),
    });
    expect(out.status).toBe('completed');
    expect(out.error).toBe('');
    expect(out.failure_reason).toBe('');
  });

  it.each([
    ['review__get_citations_limit_reached', true],
    ['review__get_citations_limit_exactly_at_limit', false],
  ])('the citation limit in %s', async (name, reached) => {
    const body = fx(shape, name);
    mockClient({ getReview: jest.fn().mockResolvedValue(body) });
    const out = await appTester(review.performResume, { authData: {}, outputData: { review_id: body.review_id } });
    expect(out.citations_checked).toBe(body.summary.citation_checks.checked);
    expect(out.error).toBe('');
    // Review a Draft does not output the limit flag; its counts must not move.
    expect(out).not.toHaveProperty('citation_limit_reached');
    expect(reached).toBe(Boolean(body.summary.citation_limit_exceeded ?? body.summary.citation_limit_reached));
  });
});

describe.each(SHAPES)('creates.check_citations reads the %s shape', (shape) => {
  const check = App.creates.check_citations.operation;
  const resumeById = async (name) => {
    const body = fx(shape, name);
    mockClient({ getCitecheck: jest.fn().mockResolvedValue(body) });
    return appTester(check.performResume, { authData: {}, outputData: { citecheck_id: body.citecheck_id } });
  };

  it('no citations to check', async () => {
    const out = await resumeById('citecheck__get_failed_no_citations');
    expect(out).toMatchObject({ status: 'failed', failure_reason: 'no_citations', failure_class: 'invalid_input', retryable: false });
    expect(out.error).toMatch(/no citation to check/);
  });

  it('a transient failure', async () => {
    const out = await resumeById('citecheck__get_failed_upstream_unavailable');
    expect(out).toMatchObject({ status: 'failed', failure_class: 'upstream_unavailable', retryable: true });
    expect(out.failure_reason).toMatch(/\S/);
  });

  it('issues found', async () => {
    const out = await resumeById('citecheck__get_completed_issues_found');
    expect(out).toMatchObject({ status: 'completed', error: '', citation_limit_reached: false });
    expect(out.citation_issue_count).toBeGreaterThan(0);
  });

  it('the citation limit: found more than the limit reads as reached', async () => {
    expect((await resumeById('citecheck__get_text_limit_reached')).citation_limit_reached).toBe(true);
  });

  it('the citation limit: exactly at the limit does not', async () => {
    expect((await resumeById('citecheck__get_text_limit_exactly_at_limit')).citation_limit_reached).toBe(false);
  });

  it('the signed failed callback', async () => {
    const payload = fx(shape, 'webhook__citecheck_failed');
    const out = await appTester(check.performResume, {
      authData: AUTH,
      outputData: { citecheck_id: payload.citecheck_id },
      rawRequest: signed(payload),
    });
    expect(out).toMatchObject({ status: 'failed', failure_reason: 'no_citations', retryable: false });
  });

  it('the signed completed callback', async () => {
    const payload = fx(shape, 'webhook__citecheck_completed');
    const out = await appTester(check.performResume, {
      authData: AUTH,
      outputData: { citecheck_id: payload.citecheck_id },
      rawRequest: signed(payload),
    });
    expect(out.status).toBe('completed');
  });
});

describe('a failure block read from either spelling', () => {
  const { shapeJobFailure } = require('../lib/jobs');

  it('maps the dated no_checkable_claim back to no_claim, hint first', () => {
    expect(
      shapeJobFailure({ code: 'no_checkable_claim', detail: 'Nothing.', hint: 'Send a claim.', failure_class: 'invalid_input', retryable: false }),
    ).toEqual({ error: 'Send a claim.', failure_reason: 'no_claim', failure_class: 'invalid_input', retryable: false });
  });

  it('falls back to the sentence, then the code, when there is no hint', () => {
    expect(shapeJobFailure({ code: 'timeout', detail: 'Out of time.' }).error).toBe('Out of time.');
    expect(shapeJobFailure({ failure_reason: 'timeout' }).error).toBe('timeout');
    expect(shapeJobFailure(null)).toEqual({ error: 'The job failed.', failure_reason: '', failure_class: '', retryable: null });
  });
});

// Unused-fixture guard: every fixture file is read by a case above, so a
// fixture that stops being exercised is noticed.
it('has the same fixtures for both shapes', () => {
  const names = (shape) => fs.readdirSync(path.join(__dirname, 'fixtures', shape)).sort();
  expect(names('dated')).toEqual(names('legacy'));
  expect(clone(names('legacy')).length).toBeGreaterThan(0);
});
