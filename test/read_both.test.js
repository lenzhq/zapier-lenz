/* globals describe, it, expect, jest, beforeAll */

// What each action does with the two response shapes the Lenz API can send.
//
// This release keeps sending the version header it has always sent, so what
// reaches the app today is the earlier ("legacy") shape. Two promises:
//
//  1. Legacy responses: every output is exactly what the app produced before
//     it learned a second shape, plus one added boolean, `not_a_claim`, on
//     Assess and Extract Claims. `test/fixtures/oracle/frozen.json` holds the
//     outputs of the code as published (run by test/helpers/oracle.js over
//     every recorded response in test/fixtures/legacy); the first block replays
//     it against the current code.
//  2. Canonical responses (the newer shape, test/fixtures/canonical): the
//     actions do not fail and every output key is present with a sensible
//     value. The output is NOT promised to equal the legacy output; that comes
//     with a later release that sends the newer version header.
//
// Fixtures are recorded API responses with run-specific values replaced.

const fs = require('fs');
const path = require('path');
const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');
const { runAll, loadFixture, signed, AUTH, TASK_ID } = require('./helpers/oracle');

const appTester = zapier.createAppTester(App);

const mockClient = (over = {}) => {
  const client = { assess: jest.fn(), extract: jest.fn(), getStatus: jest.fn(), request: jest.fn(), ...over };
  LenzClient.mockImplementation(() => client);
  return client;
};

const capture = (fn, bundle) =>
  appTester(fn, bundle).then(
    () => null,
    (e) => e,
  );

const clone = (o) => JSON.parse(JSON.stringify(o));

const FROZEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'oracle', 'frozen.json'), 'utf-8'));
const ADDED = 'not_a_claim';

// ─── 1. Legacy responses: unchanged outputs ─────────────────────────────────

describe('legacy responses give the outputs the app has always given', () => {
  let current;
  beforeAll(async () => {
    current = await runAll({ App, appTester, LenzClient, jest, shape: 'legacy' });
  });

  it('covers every recorded response', () => {
    expect(Object.keys(current).sort()).toEqual(Object.keys(FROZEN).sort());
    expect(Object.keys(FROZEN).length).toBeGreaterThan(100);
  });

  it('matches the frozen outputs, serialized, plus not_a_claim on Assess and Extract Claims', () => {
    const mismatches = [];
    for (const [name, frozen] of Object.entries(FROZEN)) {
      const got = clone(current[name]);
      if ((name.startsWith('assess__') || name.startsWith('extract__')) && !got.__error) {
        expect(typeof got[ADDED]).toBe('boolean');
        delete got[ADDED];
      }
      if (JSON.stringify(got) !== JSON.stringify(frozen)) mismatches.push(name);
    }
    expect(mismatches).toEqual([]);
  });
});

// not_a_claim says whether the API found nothing to check.
describe('not_a_claim', () => {
  const assess = App.creates.assess.operation;
  const extract = App.creates.extract_claims.operation;
  const runAssess = (body) => {
    mockClient({ assess: jest.fn().mockResolvedValue(body) });
    return appTester(assess.perform, { authData: AUTH, inputData: { text: 'x' } });
  };
  const runExtract = (body) => {
    mockClient({ extract: jest.fn().mockResolvedValue(body) });
    return appTester(extract.perform, { authData: AUTH, inputData: { text: 'x' } });
  };

  it('assess: true with no rows, and when every row has no checkable claim', async () => {
    expect((await runAssess(loadFixture('legacy', 'assess__single_no_claim'))).not_a_claim).toBe(true);
    expect((await runAssess(loadFixture('legacy', 'assess__list_all_error_rows'))).not_a_claim).toBe(true);
    expect((await runAssess(loadFixture('canonical', 'assess__list_all_error_rows'))).not_a_claim).toBe(true);
  });

  it('assess: false when a row has a verdict, or the failures are something else', async () => {
    expect((await runAssess(loadFixture('legacy', 'assess__single_one_claim'))).not_a_claim).toBe(false);
    expect((await runAssess(loadFixture('legacy', 'assess__list_mixed_rows'))).not_a_claim).toBe(false);
    expect((await runAssess(loadFixture('canonical', 'assess__list_mixed_rows'))).not_a_claim).toBe(false);
  });

  it('extract: true for not_a_claim, false otherwise, in both shapes', async () => {
    for (const shape of ['legacy', 'canonical']) {
      expect((await runExtract(loadFixture(shape, 'extract__not_a_claim'))).not_a_claim).toBe(true);
      expect((await runExtract(loadFixture(shape, 'extract__ready_several_claims'))).not_a_claim).toBe(false);
      expect((await runExtract(loadFixture(shape, 'extract__no_match_with_focus'))).not_a_claim).toBe(false);
    }
  });

  it('is declared on both actions and on both samples', () => {
    expect(assess.outputFields.some((f) => f.key === ADDED && f.type === 'boolean')).toBe(true);
    expect(extract.outputFields.some((f) => f.key === ADDED && f.type === 'boolean')).toBe(true);
    expect(assess.sample[ADDED]).toBe(false);
    expect(extract.sample[ADDED]).toBe(false);
  });
});

// The language the claims are written in rides through on both response shapes.
describe('extract language output', () => {
  const extract = App.creates.extract_claims.operation;
  const run = (body) => {
    mockClient({ extract: jest.fn().mockResolvedValue(body) });
    return appTester(extract.perform, { authData: AUTH, inputData: { text: 'x', language: 'auto' } });
  };

  it('passes language through on the flat shape and on the claim-list shape', async () => {
    expect(
      (await run({ status: 'ready', claim: 'A', identified_claims: [], language: 'de' })).language,
    ).toBe('de');
    expect(
      (await run({ status: 'ready', claims: [{ claim: 'A', positions: [] }], language: 'de' })).language,
    ).toBe('de');
  });

  it('adds nothing when the API sent no language', async () => {
    expect(await run({ status: 'ready', claim: 'A', identified_claims: [] })).not.toHaveProperty('language');
  });

  it('is declared in the output fields and the sample', () => {
    expect(extract.outputFields.some((f) => f.key === 'language')).toBe(true);
    expect(extract.sample.language).toBe('en');
  });
});

// ─── 2. Canonical responses: no failure, every key present ──────────────────

describe('canonical responses', () => {
  let legacy;
  let canonical;
  beforeAll(async () => {
    legacy = await runAll({ App, appTester, LenzClient, jest, shape: 'legacy' });
    canonical = await runAll({ App, appTester, LenzClient, jest, shape: 'canonical' });
  });

  const keysOf = (v) => (Array.isArray(v) ? keysOf(v[0] || {}) : Object.keys(v || {}));

  it('every recorded response is read', () => {
    expect(Object.keys(canonical).sort()).toEqual(Object.keys(legacy).sort());
  });

  it('never fail where the legacy response does not', () => {
    const failed = Object.entries(canonical)
      .filter(([, out]) => out.__error)
      .map(([name, out]) => `${name}: ${out.__error.name}`);
    const legacyFailed = Object.entries(legacy)
      .filter(([, out]) => out.__error)
      .map(([name, out]) => `${name}: ${out.__error.name}`);
    expect(failed).toEqual(legacyFailed);
  });

  it('carry every output key a legacy response does', () => {
    const missing = [];
    for (const [name, out] of Object.entries(canonical)) {
      if (out.__error || legacy[name].__error) continue;
      const have = new Set(keysOf(out));
      for (const key of keysOf(legacy[name])) if (!have.has(key)) missing.push(`${name}: ${key}`);
      if (out.claims && legacy[name].claims && out.claims[0] && legacy[name].claims[0]) {
        const rowHave = new Set(Object.keys(out.claims[0]));
        for (const key of Object.keys(legacy[name].claims[0])) {
          if (!rowHave.has(key)) missing.push(`${name}: claims[].${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('carry no undefined value', () => {
    const undef = [];
    const walk = (v, where) => {
      if (v === undefined) undef.push(where);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    };
    for (const [name, out] of Object.entries(canonical)) walk(out, name);
    expect(undef).toEqual([]);
  });
});

// ─── Targeted behaviour ─────────────────────────────────────────────────────

describe('creates.assess rows', () => {
  const assess = App.creates.assess.operation;
  const run = (body) => {
    mockClient({ assess: jest.fn().mockResolvedValue(body) });
    return appTester(assess.perform, { authData: AUTH, inputData: { text: 'x' } });
  };
  const failedRow = (code) => ({
    claim: 'x',
    language: 'en',
    status: 'failed',
    verdict: null,
    confidence: null,
    verification_url: null,
    rationale: null,
    dissent: null,
    suggested_rewrite: null,
    more_claims: [],
    failure: { code, detail: 'Detail.', hint: 'Hint.', failure_class: 'upstream_unavailable', retryable: true },
  });
  const errorRow = (code, over = {}) => ({
    claim: 'x',
    language: 'en',
    verdict: 'Error',
    confidence: 'low',
    error_code: code,
    hint: 'Hint.',
    identified_claims: [],
    ...over,
  });

  it('keeps a legacy Error row as sent: a null confidence stays null, an empty hint stays empty', async () => {
    const out = await run({ claims: [errorRow('no_claim', { confidence: null, hint: '' })] });
    expect(out.claims[0]).toMatchObject({ verdict: 'Error', confidence: null, hint: '', error_code: 'no_claim' });
  });

  it('keeps a legacy verdict row without a hint with an empty one', async () => {
    const out = await run({
      claims: [{ claim: 'x', verdict: 'True', confidence: 'high', identified_claims: ['y'], hint: null }],
    });
    expect(out.claims[0]).toMatchObject({ hint: '', identified_claims: ['y'] });
  });

  it('replays when every row is a transient legacy Error row', async () => {
    const thrown = await capture(assess.perform, {
      authData: AUTH,
      inputData: { text: 'x' },
      ...(mockClient({ assess: jest.fn().mockResolvedValue({ claims: [errorRow('upstream_unavailable')] }) }) && {}),
    });
    expect(thrown.name).toBe('ThrottledError');
    expect(JSON.parse(thrown.message).message).toMatch(/upstream_unavailable.*nothing was charged/);
  });

  it.each(['upstream_unavailable', 'timeout'])('replays when every row is a failed row (%s)', async (code) => {
    mockClient({ assess: jest.fn().mockResolvedValue({ status: 'error', claims: [failedRow(code)], more_claims: [] }) });
    const thrown = await capture(assess.perform, { authData: AUTH, inputData: { text: 'x' } });
    expect(thrown.name).toBe('ThrottledError');
  });

  it('does not replay a mixed wave, or a failure that will not change', async () => {
    const mixed = await run({
      claims: [errorRow('upstream_unavailable'), { claim: 'y', verdict: 'True', confidence: 'high' }],
    });
    expect(mixed.status).toBe('ok');
    const framing = await run({ status: 'error', claims: [failedRow('framing_failed')] });
    expect(framing.claims[0]).toMatchObject({ verdict: 'Error', error_code: 'framing_failed' });
  });

  it('reads a failed row: verdict Error, the cause and hint from its failure block', async () => {
    const out = await run({
      status: 'no_checkable_claim',
      claims: [failedRow('no_checkable_claim')],
      failure: null,
      more_claims: [],
    });
    expect(out.claims[0]).toMatchObject({
      verdict: 'Error',
      confidence: null,
      passed: false,
      error_code: 'no_claim',
      hint: 'Hint.',
      identified_claims: [],
    });
    expect(out.not_a_claim).toBe(true);
    expect(out.status).toBe('ok');
  });

  it('reads more_claims as the other claims found', async () => {
    const out = await run({
      status: 'ok',
      claims: [{ claim: 'x', status: 'completed', verdict: 'False', confidence: 'high', more_claims: ['a', 'b'], failure: null }],
    });
    expect(out.claims[0].identified_claims).toEqual(['a', 'b']);
  });

  it('reads the sentence of an answer with no rows from its failure block', async () => {
    const out = await run({
      status: 'no_checkable_claim',
      claims: [],
      failure: { code: 'no_checkable_claim', detail: 'Nothing to check.' },
      more_claims: [],
    });
    expect(out).toMatchObject({ status: 'no_claim', not_a_claim: true, message: 'Nothing to check.' });
  });
});

describe('creates.extract_claims reads the list form', () => {
  const extract = App.creates.extract_claims.operation;
  const run = (body) => {
    mockClient({ extract: jest.fn().mockResolvedValue(body) });
    return appTester(extract.perform, { authData: AUTH, inputData: { text: 'x' } });
  };

  it('several claims', async () => {
    const out = await run(loadFixture('canonical', 'extract__ready_several_claims'));
    expect(out).toMatchObject({
      status: 'ready',
      claim: 'Alpha rose 5% in 2024.',
      identified_claims: ['Alpha rose 5% in 2024.', 'Beta fell 3% last year.'],
      candidate_claims: [],
      locations: null,
      message: '',
    });
  });

  it('one claim leaves identified_claims empty; none keeps status not_a_claim', async () => {
    const one = await run(loadFixture('canonical', 'extract__ready_one_claim'));
    expect(one.identified_claims).toEqual([]);
    expect(one.claim).toMatch(/\S/);
    const none = await run(loadFixture('canonical', 'extract__not_a_claim'));
    expect(none).toMatchObject({ status: 'not_a_claim', claim: '', identified_claims: [], not_a_claim: true });
  });
});

describe('creates.verify_claim reads the failure block and the nested callback', () => {
  const verify = App.creates.verify_claim.operation;
  const resume = (extra = {}) => ({ authData: AUTH, outputData: { task_id: TASK_ID }, ...extra });
  const poll = (name) => {
    mockClient({ getStatus: jest.fn().mockResolvedValue(loadFixture('canonical', name)) });
    return appTester(verify.performResume, resume());
  };
  // The enveloped callback: the same body a poll returns, under `verification`.
  const envelope = (event, verification) => ({
    event,
    event_id: 'evt_0123456789abcdef01234567',
    task_id: TASK_ID,
    verification_id: null,
    status: verification.status,
    verification,
    attempt: 1,
  });

  it('a failed poll: sentence, stage, class and retryable', async () => {
    const out = await poll('verify__status_failed_live');
    expect(out).toMatchObject({
      status: 'failed',
      failure_reason: 'research_empty',
      failure_class: 'insufficient_evidence',
      retryable: false,
    });
    expect(out.error).toMatch(/\S/);
  });

  it('nothing checkable reads failure_reason not_a_claim', async () => {
    expect(await poll('verify__status_not_a_claim')).toMatchObject({
      failure_reason: 'not_a_claim',
      failure_class: 'invalid_input',
    });
  });

  it('needs_input options read as Claims Found with a text key', async () => {
    const out = await poll('verify__status_needs_input');
    expect(out.claims).toEqual([
      { text: 'The Earth is round.', domain: 'Science' },
      { text: 'Water boils at 100C at sea level.', domain: 'Science' },
    ]);
  });

  it('a nested completed callback', async () => {
    const body = loadFixture('canonical', 'verify__status_completed');
    const out = await appTester(
      verify.performResume,
      resume({ rawRequest: signed(envelope('verification.completed', { ...body, task_id: TASK_ID })) }),
    );
    expect(out).toMatchObject({ status: 'completed', verification_id: body.result.verification_id, verdict: body.result.verdict });
  });

  it('a nested failed callback', async () => {
    const body = loadFixture('canonical', 'verify__status_not_a_claim');
    const out = await appTester(
      verify.performResume,
      resume({ rawRequest: signed(envelope('verification.failed', { ...body, task_id: TASK_ID })) }),
    );
    expect(out).toMatchObject({
      status: 'failed',
      failure_reason: 'not_a_claim',
      failure_class: 'invalid_input',
      retryable: false,
    });
    expect(out.error).toBe(body.failure.detail);
  });
});

describe('triggers.new_verification', () => {
  const trigger = App.triggers.new_verification.operation;
  const run = (item) => {
    mockClient({ request: jest.fn().mockResolvedValue({ items: [item], total: 1, page: 1, page_size: 100 }) });
    return appTester(trigger.perform, { authData: AUTH }).then((r) => r[0]);
  };
  const base = { verification_id: 'ab12cd34', claim: 'A', verdict: 'True' };

  it('passes modified_at through as sent, null included, and adds no completed_at', async () => {
    const later = await run({ ...base, created_at: '2026-10-07T10:00:00Z', modified_at: '2026-10-08T09:00:00Z' });
    expect(later.modified_at).toBe('2026-10-08T09:00:00Z');
    expect(later).not.toHaveProperty('completed_at');
    const same = await run({ ...base, created_at: '2026-10-08T10:00:00Z', modified_at: null });
    expect(same.modified_at).toBeNull();
    expect(same).not.toHaveProperty('completed_at');
  });

  it('an item with completed_at gets modified_at by the earlier rule: a later UTC day only', async () => {
    const later = await run({ ...base, created_at: '2026-10-07T23:59:00Z', completed_at: '2026-10-08T00:02:00Z' });
    expect(later.modified_at).toBe('2026-10-08T00:02:00Z');
    const same = await run({ ...base, created_at: '2026-10-08T08:00:00Z', completed_at: '2026-10-08T17:30:00Z' });
    expect(same.modified_at).toBeNull();
  });
});

describe('Review a Draft and Check Citations', () => {
  const review = App.creates.review_draft.operation;
  const check = App.creates.check_citations.operation;

  it.each([
    ['citecheck__get_text_limit_reached', true],
    ['citecheck__get_text_limit_exactly_at_limit', false],
  ])('the citation limit in %s, in both shapes', async (name, reached) => {
    for (const shape of ['legacy', 'canonical']) {
      const body = loadFixture(shape, name);
      mockClient({ getCitecheck: jest.fn().mockResolvedValue(body) });
      const out = await appTester(check.performResume, { authData: {}, outputData: { citecheck_id: body.citecheck_id } });
      expect(out.citation_limit_reached).toBe(reached);
    }
  });

  it('a canonical failed review: no_claim and the hint', async () => {
    const body = loadFixture('canonical', 'review__get_failed_no_claim');
    mockClient({ getReview: jest.fn().mockResolvedValue(body) });
    const out = await appTester(review.performResume, { authData: {}, outputData: { review_id: body.review_id } });
    expect(out).toMatchObject({ status: 'failed', failure_reason: 'no_claim', failure_class: 'invalid_input', retryable: false });
    expect(out.error).toMatch(/Send one factual claim/);
  });

  it('a failure block read from either spelling', () => {
    const { shapeJobFailure } = require('../lib/jobs');
    expect(
      shapeJobFailure({ code: 'no_checkable_claim', detail: 'Nothing.', hint: 'Send a claim.', failure_class: 'invalid_input', retryable: false }),
    ).toEqual({ error: 'Send a claim.', failure_reason: 'no_claim', failure_class: 'invalid_input', retryable: false });
    expect(shapeJobFailure({ code: 'timeout', detail: 'Out of time.' }).error).toBe('Out of time.');
    expect(shapeJobFailure({ failure_reason: 'timeout' }).error).toBe('timeout');
    expect(shapeJobFailure(null)).toEqual({ error: 'The job failed.', failure_reason: '', failure_class: '', retryable: null });
  });
});
