/* globals describe, it, expect, jest */

// What the end-to-end harness run found (2026-10-23), pinned.
//
//  1. Assess: claims past the per-call limit come back at the TOP level of the
//     API response as `more_claims`; the app only read them per row.
//  2. `passed` is a boolean only for a real verdict. An Error row, a row with
//     no verdict and an unknown label give an empty `passed`, in Assess and in
//     a completed Verify, as the README promises.
//  3. A failed Verify read from the signed callback fills Failure Reason with
//     the code and says what went wrong in Error, as the status route does.
//  4. A sample returned from a warm container is a fresh copy.

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');
const { signed, AUTH, TASK_ID } = require('./helpers/oracle');

const appTester = zapier.createAppTester(App);

const mockClient = (over = {}) => {
  const client = {
    assess: jest.fn(),
    extract: jest.fn(),
    getStatus: jest.fn(),
    usage: jest.fn().mockResolvedValue({ has_webhook_secret: true }),
    ...over,
  };
  LenzClient.mockImplementation(() => client);
  return client;
};

const assessOut = (body) => {
  mockClient({ assess: jest.fn().mockResolvedValue(body) });
  return appTester(App.creates.assess.operation.perform, { authData: AUTH, inputData: { text: 'x' } });
};

const verdictRow = (n) => ({ claim: `Claim ${n}`, verdict: 'True', confidence: 'high' });
const twentyRows = () => Array.from({ length: 20 }, (_, i) => verdictRow(i + 1));

describe('1. Assess: claims past the limit', () => {
  const extras = ['Claim 21', 'Claim 22', 'Claim 23', 'Claim 24', 'Claim 25'];

  it('lists them from the top-level more_claims (earlier shape)', async () => {
    const out = await assessOut({ claims: twentyRows(), more_claims: extras });
    expect(out.claims).toHaveLength(20);
    expect(out.more_claims).toEqual(extras);
  });

  it('lists them from the top-level more_claims (newer shape)', async () => {
    const rows = twentyRows().map((r) => ({ ...r, status: 'completed', more_claims: [], failure: null }));
    const out = await assessOut({ status: 'ok', claims: rows, more_claims: extras });
    expect(out.claims).toHaveLength(20);
    expect(out.more_claims).toEqual(extras);
  });

  it('reads the earlier name identified_claims when more_claims is absent, and prefers more_claims', async () => {
    expect((await assessOut({ claims: [verdictRow(1)], identified_claims: ['a'] })).more_claims).toEqual(['a']);
    expect(
      (await assessOut({ claims: [verdictRow(1)], more_claims: ['b'], identified_claims: ['a'] })).more_claims,
    ).toEqual(['b']);
  });

  it('is an empty list when the key is absent, null or not a list', async () => {
    expect((await assessOut({ claims: [verdictRow(1)] })).more_claims).toEqual([]);
    expect((await assessOut({ claims: [verdictRow(1)], more_claims: null })).more_claims).toEqual([]);
    expect((await assessOut({ claims: [verdictRow(1)], more_claims: 'nope' })).more_claims).toEqual([]);
  });

  it('keeps a row-level list and the top-level list apart', async () => {
    const out = await assessOut({
      claims: [{ ...verdictRow(1), identified_claims: ['row extra'] }],
      more_claims: ['top extra'],
    });
    expect(out.claims[0].identified_claims).toEqual(['row extra']);
    expect(out.more_claims).toEqual(['top extra']);
  });

  it('is on the no-claim answer and in the sample, and is declared as an output', async () => {
    const none = await assessOut({ claims: [], error: 'No claim found.' });
    expect(none.status).toBe('no_claim');
    expect(none.more_claims).toEqual([]);

    const op = App.creates.assess.operation;
    expect(op.sample.more_claims).toEqual([]);
    expect(op.outputFields).toContainEqual({ key: 'more_claims', label: 'Claims Not Checked', list: true });
  });
});

describe('2. passed is empty without a real verdict', () => {
  it.each([
    ['True', true],
    ['Mostly True', true],
    ['Mixed', false],
    ['Mostly False', false],
    ['False', false],
    ['No Public Record', null],
    ['Error', null],
    ['Something New', null],
    [null, null],
  ])('assess: verdict %p gives passed %p', async (verdict, passed) => {
    const out = await assessOut({ claims: [{ claim: 'x', verdict, confidence: 'high' }, verdictRow(2)] });
    expect(out.claims[0].passed).toBe(passed);
  });

  it('assess: a failed row in the newer shape gives an empty passed', async () => {
    const out = await assessOut({
      status: 'ok',
      claims: [
        verdictRow(1),
        {
          claim: 'x',
          status: 'failed',
          verdict: null,
          confidence: null,
          more_claims: [],
          failure: { code: 'internal', detail: 'Detail.', hint: 'Hint.', failure_class: 'internal', retryable: false },
        },
      ],
    });
    expect(out.claims[1]).toMatchObject({ verdict: 'Error', confidence: 'low', passed: null });
    expect(out.claims[0].passed).toBe(true);
  });

  const resumeCompleted = async (result) => {
    mockClient({ getStatus: jest.fn().mockResolvedValue({ status: 'completed', result }) });
    return appTester(App.creates.verify_claim.operation.performResume, {
      authData: AUTH,
      outputData: { task_id: TASK_ID },
    });
  };

  it.each([
    ['True', true],
    ['Mostly False', false],
    ['No Public Record', null],
    ['Error', null],
    [undefined, null],
  ])('verify: a completed result with verdict %p gives passed %p', async (verdict, passed) => {
    const out = await resumeCompleted({ verdict, claim: 'x', sources: [] });
    expect(out.passed).toBe(passed);
  });
});

describe('3. A failed Verify from the signed callback', () => {
  const resume = (event) =>
    appTester(App.creates.verify_claim.operation.performResume, {
      authData: AUTH,
      outputData: { task_id: TASK_ID },
      rawRequest: signed({ event: 'verification.failed', task_id: TASK_ID, ...event }),
    });

  it('fills Failure Reason with the code and Error with what happened (flat payload)', async () => {
    mockClient();
    const out = await resume({ error: 'not_a_claim', failure_class: 'invalid_input', retryable: false });
    expect(out).toMatchObject({
      status: 'failed',
      failure_reason: 'not_a_claim',
      failure_class: 'invalid_input',
      retryable: false,
    });
    expect(out.error).toBe('No claim in the input could be checked against public evidence.');
  });

  it('does the same from a nested failure block, using the server detail for Error', async () => {
    mockClient();
    const out = await resume({
      verification: {
        status: 'failed',
        failure: {
          code: 'upstream_unavailable',
          detail: 'A research provider was down.',
          failure_class: 'upstream_unavailable',
          retryable: true,
        },
      },
    });
    expect(out).toMatchObject({
      status: 'failed',
      failure_reason: 'upstream_unavailable',
      error: 'A research provider was down.',
      retryable: true,
    });
  });
});

describe('4. Samples are fresh copies', () => {
  const sampleOf = {
    assess: (b) => b.claims,
    verify_claim: (b) => b.sources,
    check_citations: (b) => b.citations,
    review_draft: (b) => b.issues,
  };

  it.each(Object.keys(sampleOf))('%s: mutating a returned sample does not change the next one', async (key) => {
    mockClient();
    const op = App.creates[key].operation;
    const bundle = {
      authData: AUTH,
      inputData: { text: '', claim: '', draft: '' },
      meta: { isLoadingSample: true },
    };
    const first = await appTester(op.perform, bundle);
    const list = Object.values(first).find((v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object');
    expect(list).toBeTruthy();
    const before = JSON.stringify(first);
    list[0].__mutated = true;
    list.push({ __mutated: true });
    const second = await appTester(op.perform, bundle);
    expect(JSON.stringify(second)).toBe(before);
  });
});
