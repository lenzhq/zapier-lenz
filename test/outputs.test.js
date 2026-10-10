/* globals describe, it, expect, jest, beforeAll */

// What each action gives for the Lenz API responses it reads. The app asks for
// the `2026-10-11` shape (client.js API_VERSION) and reads only that shape.
//
// test/fixtures/oracle/outputs.json holds the outputs every recorded response
// gave before the app stopped reading the earlier (`2026-05-13`) shape:
// `mocked` (the actions over a mocked client, here), and `reads` / `starts`
// (the real SDK with only `fetch` replaced, test/api_version.test.js). Every
// output must stay exactly what it was: same keys, same order, same values.
// A change to that file is a change to what Zaps receive, and is never made
// to make a test pass.
//
// Fixtures are recorded API responses with run-specific values replaced.

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');
const { runAll, loadFixture, loadOracle, normalize, signed, AUTH, TASK_ID } = require('./helpers/oracle');

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

const ORACLE = loadOracle().mocked;
const ADDED = 'not_a_claim';

// ─── Every recorded response: the outputs it has always given ───────────────

describe('recorded responses give the outputs they always have', () => {
  let current;
  beforeAll(async () => {
    current = normalize(await runAll({ App, appTester, LenzClient, jest }));
  });

  it('covers every recorded response', () => {
    expect(Object.keys(current).sort()).toEqual(Object.keys(ORACLE).sort());
    expect(Object.keys(ORACLE).length).toBeGreaterThan(100);
  });

  it('matches the recorded outputs, serialized (key order included)', () => {
    const mismatches = Object.keys(ORACLE).filter((name) => JSON.stringify(current[name]) !== JSON.stringify(ORACLE[name]));
    expect(mismatches).toEqual([]);
  });

  it('carry no undefined value', () => {
    const undef = [];
    const walk = (v, where) => {
      if (v === undefined) undef.push(where);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    };
    // Before normalizing: JSON drops an undefined value silently.
    return runAll({ App, appTester, LenzClient, jest }).then((raw) => {
      for (const [name, out] of Object.entries(raw)) walk(out, name);
      expect(undef).toEqual([]);
    });
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
    expect((await runAssess(loadFixture('assess__single_no_claim'))).not_a_claim).toBe(true);
    expect((await runAssess(loadFixture('assess__list_all_error_rows'))).not_a_claim).toBe(true);
  });

  it('assess: false when a row has a verdict, or the failures are something else', async () => {
    expect((await runAssess(loadFixture('assess__single_one_claim'))).not_a_claim).toBe(false);
    expect((await runAssess(loadFixture('assess__list_mixed_rows'))).not_a_claim).toBe(false);
  });

  it('extract: true for nothing checkable, false otherwise', async () => {
    expect((await runExtract(loadFixture('extract__not_a_claim'))).not_a_claim).toBe(true);
    expect((await runExtract(loadFixture('extract__ready_several_claims'))).not_a_claim).toBe(false);
    expect((await runExtract(loadFixture('extract__no_match_with_focus'))).not_a_claim).toBe(false);
  });

  it('is declared on both actions and on both samples', () => {
    expect(assess.outputFields.some((f) => f.key === ADDED && f.type === 'boolean')).toBe(true);
    expect(extract.outputFields.some((f) => f.key === ADDED && f.type === 'boolean')).toBe(true);
    expect(assess.sample[ADDED]).toBe(false);
    expect(extract.sample[ADDED]).toBe(false);
  });
});

// The language the claims are written in rides through.
describe('extract language output', () => {
  const extract = App.creates.extract_claims.operation;
  const run = (body) => {
    mockClient({ extract: jest.fn().mockResolvedValue(body) });
    return appTester(extract.perform, { authData: AUTH, inputData: { text: 'x', language: 'auto' } });
  };

  it('passes language through', async () => {
    expect(
      (await run({ status: 'ready', claims: [{ claim: 'A', positions: [] }], language: 'de' })).language,
    ).toBe('de');
  });

  it('adds nothing when the API sent no language', async () => {
    expect(await run({ status: 'ready', claims: [{ claim: 'A', positions: null }] })).not.toHaveProperty('language');
  });

  it('is declared in the output fields and the sample', () => {
    expect(extract.outputFields.some((f) => f.key === 'language')).toBe(true);
    expect(extract.sample.language).toBe('en');
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

  it.each(['upstream_unavailable', 'timeout'])('replays when every row is a failed row (%s)', async (code) => {
    mockClient({ assess: jest.fn().mockResolvedValue({ status: 'error', claims: [failedRow(code)], more_claims: [] }) });
    const thrown = await capture(assess.perform, { authData: AUTH, inputData: { text: 'x' } });
    expect(thrown.name).toBe('ThrottledError');
  });

  it('does not replay a mixed wave, or a failure that will not change', async () => {
    const mixed = await run({
      status: 'ok',
      claims: [
        failedRow('upstream_unavailable'),
        { claim: 'y', status: 'completed', verdict: 'True', confidence: 'high', more_claims: [], failure: null },
      ],
    });
    expect(mixed.status).toBe('ok');
    const framing = await run({ status: 'error', claims: [failedRow('framing_failed')] });
    expect(framing.claims[0]).toMatchObject({ verdict: 'Error', error_code: 'framing_failed' });
  });

  it('reads a failed row: verdict Error, confidence low, the cause and hint from its failure block', async () => {
    const out = await run({
      status: 'no_checkable_claim',
      claims: [failedRow('no_checkable_claim')],
      failure: null,
      more_claims: [],
    });
    expect(out.claims[0]).toMatchObject({
      verdict: 'Error',
      confidence: 'low',
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

  it('words an answer with no rows as it always has', async () => {
    const out = await run({
      status: 'no_checkable_claim',
      claims: [],
      failure: { code: 'no_checkable_claim', detail: 'Nothing to check.' },
      more_claims: [],
    });
    expect(out).toMatchObject({ status: 'no_claim', not_a_claim: true, message: 'No verifiable claim detected' });
  });
});

describe('creates.extract_claims reads the list form', () => {
  const extract = App.creates.extract_claims.operation;
  const run = (body) => {
    mockClient({ extract: jest.fn().mockResolvedValue(body) });
    return appTester(extract.perform, { authData: AUTH, inputData: { text: 'x' } });
  };

  it('several claims', async () => {
    const out = await run(loadFixture('extract__ready_several_claims'));
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
    const one = await run(loadFixture('extract__ready_one_claim'));
    expect(one.identified_claims).toEqual([]);
    expect(one.claim).toMatch(/\S/);
    const none = await run(loadFixture('extract__not_a_claim'));
    expect(none).toMatchObject({ status: 'not_a_claim', claim: '', identified_claims: [], not_a_claim: true });
  });
});

describe('creates.verify_claim reads the failure block and the nested callback', () => {
  const verify = App.creates.verify_claim.operation;
  const resume = (extra = {}) => ({ authData: AUTH, outputData: { task_id: TASK_ID }, ...extra });
  const poll = (name) => {
    mockClient({ getStatus: jest.fn().mockResolvedValue(loadFixture(name)) });
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
    const body = loadFixture('verify__status_completed');
    const out = await appTester(
      verify.performResume,
      resume({ rawRequest: signed(envelope('verification.completed', { ...body, task_id: TASK_ID })) }),
    );
    expect(out).toMatchObject({ status: 'completed', verification_id: body.result.verification_id, verdict: body.result.verdict });
  });

  it('a nested failed callback', async () => {
    const body = loadFixture('verify__status_not_a_claim');
    const out = await appTester(
      verify.performResume,
      resume({ rawRequest: signed(envelope('verification.failed', { ...body, task_id: TASK_ID })) }),
    );
    // As the flat callback always read: the code in `error`, no
    // failure_reason on this path.
    expect(out).toMatchObject({
      status: 'failed',
      error: 'not_a_claim',
      failure_reason: '',
      failure_class: 'invalid_input',
      retryable: false,
    });
  });
});

describe('triggers.new_verification', () => {
  const trigger = App.triggers.new_verification.operation;
  const run = (item) => {
    mockClient({ request: jest.fn().mockResolvedValue({ items: [item], total: 1, page: 1, page_size: 100 }) });
    return appTester(trigger.perform, { authData: AUTH }).then((r) => r[0]);
  };
  const base = { verification_id: 'ab12cd34', claim: 'A', verdict: 'True' };

  it('modified_at is read from completed_at: set on a later UTC day only, and no completed_at is added', async () => {
    const later = await run({ ...base, created_at: '2026-10-07T23:59:00Z', completed_at: '2026-10-08T00:02:00Z' });
    expect(later.modified_at).toBe('2026-10-08T00:02:00Z');
    const same = await run({ ...base, created_at: '2026-10-08T08:00:00Z', completed_at: '2026-10-08T17:30:00Z' });
    expect(same.modified_at).toBeNull();
    expect(later).not.toHaveProperty('completed_at');
    expect(same).not.toHaveProperty('completed_at');
  });
});

describe('Review a Draft and Check Citations', () => {
  const review = App.creates.review_draft.operation;
  const check = App.creates.check_citations.operation;

  it.each([
    ['citecheck__get_text_limit_reached', true],
    ['citecheck__get_text_limit_exactly_at_limit', false],
  ])('the citation limit in %s', async (name, reached) => {
    const body = loadFixture(name);
    mockClient({ getCitecheck: jest.fn().mockResolvedValue(body) });
    const out = await appTester(check.performResume, { authData: {}, outputData: { citecheck_id: body.citecheck_id } });
    expect(out.citation_limit_reached).toBe(reached);
  });

  it('a failed review: no_claim and the hint', async () => {
    const body = loadFixture('review__get_failed_no_claim');
    mockClient({ getReview: jest.fn().mockResolvedValue(body) });
    const out = await appTester(review.performResume, { authData: {}, outputData: { review_id: body.review_id } });
    expect(out).toMatchObject({ status: 'failed', failure_reason: 'no_claim', failure_class: 'invalid_input', retryable: false });
    expect(out.error).toMatch(/Send one factual claim/);
  });

  it('a failure block', () => {
    const { shapeJobFailure } = require('../lib/jobs');
    expect(
      shapeJobFailure({ code: 'no_checkable_claim', detail: 'Nothing.', hint: 'Send a claim.', failure_class: 'invalid_input', retryable: false }),
    ).toEqual({ error: 'Send a claim.', failure_reason: 'no_claim', failure_class: 'invalid_input', retryable: false });
    // No hint: the code, as this output has always read; `detail` alone is not used.
    expect(shapeJobFailure({ code: 'timeout', detail: 'Out of time.' }).error).toBe('timeout');
    expect(shapeJobFailure(null)).toEqual({ error: 'The job failed.', failure_reason: '', failure_class: '', retryable: null });
  });
});
