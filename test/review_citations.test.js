/* globals describe, it, expect, jest */

// Review a Draft and Check Citations (2.1.0). Both are callback actions like
// Verify a Claim: perform submits with the Zapier callback URL as
// `webhook_url`; performResume reads the SIGNED `review.*` / `citecheck.*`
// body, and reads the job by id whenever it cannot.

const crypto = require('crypto');
const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient, LenzError } = require('lenz-io');
const App = require('../index');

const appTester = zapier.createAppTester(App);

const capture = (fn, bundle) =>
  appTester(fn, bundle).then(
    () => null,
    (e) => e,
  );

const SECRET = 'whsec_test';
const AUTH = { access_token: 'lat_good', webhook_secret: SECRET };
const CALLBACK = 'https://auth-json-server.zapier-staging.com/echo';

const sign = (body, secret = SECRET) =>
  `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf-8')).digest('hex')}`;

const callback = (payload, { secret = SECRET } = {}) => {
  const content = JSON.stringify(payload);
  return { content, headers: { 'Http-Content-Type': 'application/json', 'Http-X-Lenz-Signature': sign(content, secret) } };
};

const mockClient = (over = {}) => {
  const client = {
    usage: jest.fn().mockResolvedValue({ has_webhook_secret: true }),
    review: jest.fn().mockResolvedValue({ review_id: 'rev12345', status: 'queued' }),
    getReview: jest.fn(),
    citecheck: jest.fn().mockResolvedValue({ citecheck_id: 'cc123456', status: 'queued' }),
    getCitecheck: jest.fn(),
    ...over,
  };
  LenzClient.mockImplementation(() => client);
  return client;
};

const throttleDelay = (err) => JSON.parse(err.message).delay;

// ─── Review a Draft ──────────────────────────────────────────────────────────

const review = App.creates.review_draft.operation;
const REVIEW_ID = 'rev12345';

// Trimmed from a recorded review (lenz/tests/fixtures/review_completed_located.json).
const REVIEW = {
  review_id: REVIEW_ID,
  view: 'full',
  status: 'completed',
  outcome: 'issues_found',
  created_at: '2026-09-27T19:20:11Z',
  completed_at: '2026-09-27T19:23:02Z',
  language: 'en',
  summary: {
    claims_selected: 4,
    input_truncated: false,
    assessments: { completed: 4, failed: 0 },
    verifications: { planned: 2, completed: 2, failed: 0 },
    issues: 1,
  },
  credits: { charged: 14 },
  issues: [
    {
      claim_index: 0,
      claim: 'The EU AI Act entered into force in March 2024.',
      verified_claim: null,
      verdict: 'False',
      confidence: 'high',
      source: 'verification',
      verification_id: 'c9b769e1',
      verification_url: 'https://lenz.io/api/v1/verifications/c9b769e1',
      url: 'https://lenz.io/c/eu-ai-act-c9b769e1',
      key_finding: 'It entered into force on 1 August 2024.',
      rationale: 'Published 12 July 2024; in force 1 August 2024.',
      suggested_rewrite: 'The EU AI Act entered into force on 1 August 2024.',
      failure: null,
    },
  ],
  failures: [],
  citation_issues: [
    {
      citation_index: 0,
      reference: 'https://example.org/a',
      cited_url: 'https://example.org/a',
      doi: null,
      statement: 'A said B.',
      finding: 'contradicted',
      snippet: 'A said C.',
      rationale: 'The page says C.',
      page_title: 'A',
    },
  ],
  claims: [],
};

const reviewEvent = (over = {}) => ({
  event: 'review.completed',
  event_id: 'evt_abc',
  review_id: REVIEW_ID,
  task_id: 'chain_1',
  status: 'completed',
  review: REVIEW,
  attempt: 1,
  delivered_at: new Date().toISOString(),
  ...over,
});

const resumeReview = (rawRequest) => ({
  authData: AUTH,
  outputData: { review_id: REVIEW_ID, status: 'queued' },
  rawRequest,
});

describe('creates.review_draft perform', () => {
  it('submits with the callback URL and parks the review id', async () => {
    const client = mockClient();
    const out = await appTester(review.perform, {
      authData: AUTH,
      inputData: { text: 'Draft.', maxVerifications: '3', depth: 'low', maxCitations: '5', language: 'de' },
    });

    expect(out).toMatchObject({ review_id: REVIEW_ID, status: 'queued', issue_count: 0, issues: [], error: '' });
    expect(client.review).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Draft.',
        webhookUrl: CALLBACK,
        maxVerifications: 3,
        maxCitations: 5,
        depth: 'low',
        language: 'de',
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it('leaves blank options to the server, and 0 citations means none', async () => {
    const client = mockClient();
    await appTester(review.perform, { authData: AUTH, inputData: { text: 'Draft.', maxVerifications: '', maxCitations: '0' } });

    const sent = client.review.mock.calls[0][0];
    expect(sent.maxVerifications).toBeUndefined();
    expect(sent.maxCitations).toBeUndefined();
    expect(sent.depth).toBeUndefined();
  });

  it('sends the same key for a replay of the same draft, a different one for another draft', async () => {
    const client = mockClient();
    const run = (text) => appTester(review.perform, { authData: AUTH, inputData: { text }, meta: { zap: { id: 7 } } });
    await run('Draft one.');
    await run('Draft one.');
    await run('Draft two.');

    const keys = client.review.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('while testing: only the free usage check, then the sample', async () => {
    const client = mockClient();
    const out = await appTester(review.perform, { authData: AUTH, inputData: { text: 'x' }, meta: { isLoadingSample: true } });

    expect(client.usage).toHaveBeenCalledTimes(1);
    expect(client.review).not.toHaveBeenCalled();
    expect(out).toMatchObject({ review_id: '442b6aa9', status: 'completed' });
  });

  it('while testing: says so when the connection has no webhook secret', async () => {
    mockClient({ usage: jest.fn().mockResolvedValue({ has_webhook_secret: false }) });
    const err = await capture(review.perform, { authData: AUTH, inputData: { text: 'x' }, meta: { isLoadingSample: true } });

    expect(err.message).toMatch(/Review a Draft needs this Lenz connection to have a webhook signing secret/);
  });

  it('halts, not fails, when Lenz refuses the callback for a missing secret', async () => {
    mockClient({
      review: jest.fn().mockRejectedValue(
        new LenzError({ message: 'no secret', statusCode: 422, code: 'webhook_secret_missing', body: { code: 'webhook_secret_missing' } }),
      ),
    });
    const err = await capture(review.perform, { authData: AUTH, inputData: { text: 'x' } });

    expect(err.name).toBe('HaltedError');
    expect(err.message).toMatch(/so Review a Draft cannot receive its result/);
  });

  it('waits and replays while the same key is still being created', async () => {
    mockClient({
      review: jest.fn().mockRejectedValue(
        new LenzError({
          message: 'A review with this Idempotency-Key is being created.',
          statusCode: 409,
          code: 'idempotency_conflict',
          body: { code: 'idempotency_conflict', review_id: null },
        }),
      ),
    });
    const err = await capture(review.perform, { authData: AUTH, inputData: { text: 'x' } });

    expect(err.name).toBe('ThrottledError');
    expect(throttleDelay(err)).toBeGreaterThan(0);
  });
});

describe('creates.review_draft performResume', () => {
  it('reads the full review from the signed callback without calling the API', async () => {
    const client = mockClient();
    const out = await appTester(review.performResume, resumeReview(callback(reviewEvent())));

    expect(client.getReview).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      review_id: REVIEW_ID,
      status: 'completed',
      outcome: 'issues_found',
      clean: false,
      issue_count: 1,
      citation_issue_count: 1,
      claims_checked: 4,
      deep_checks: 2,
      unchecked_claims: 0,
      credits_charged: 14,
      message: '',
      error: '',
    });
    expect(out.issues[0]).toEqual({
      claim: 'The EU AI Act entered into force in March 2024.',
      verdict: 'False',
      confidence: 'high',
      source: 'verification',
      key_finding: 'It entered into force on 1 August 2024.',
      rationale: 'Published 12 July 2024; in force 1 August 2024.',
      suggested_rewrite: 'The EU AI Act entered into force on 1 August 2024.',
      url: 'https://lenz.io/c/eu-ai-act-c9b769e1',
      verification_id: 'c9b769e1',
    });
    expect(out.citation_issues[0]).toMatchObject({ finding: 'contradicted', doi: '', snippet: 'A said C.' });
  });

  it('a clean review reads as clean', async () => {
    mockClient();
    const clean = { ...REVIEW, outcome: 'clean', issues: [], citation_issues: [] };
    const out = await appTester(review.performResume, resumeReview(callback(reviewEvent({ review: clean }))));

    expect(out).toMatchObject({ clean: true, issue_count: 0, issues: [] });
  });

  it('shapes a failed review with the failure block', async () => {
    mockClient();
    const failed = {
      ...REVIEW,
      status: 'failed',
      outcome: null,
      issues: [],
      citation_issues: [],
      failure: { failure_reason: 'upstream_unavailable', failure_class: 'upstream_unavailable', retryable: true, hint: 'Try again shortly.' },
    };
    const out = await appTester(
      review.performResume,
      resumeReview(callback(reviewEvent({ event: 'review.failed', status: 'failed', review: failed }))),
    );

    expect(out).toMatchObject({
      status: 'failed',
      error: 'Try again shortly.',
      failure_reason: 'upstream_unavailable',
      failure_class: 'upstream_unavailable',
      retryable: true,
    });
  });

  it("does not take a child check's certificate event for the review's result", async () => {
    const client = mockClient({ getReview: jest.fn().mockResolvedValue(REVIEW) });
    const certificate = { event: 'certificate.timestamped', task_id: 'chain_1', delivered_at: new Date().toISOString() };
    const out = await appTester(review.performResume, resumeReview(callback(certificate)));

    expect(client.getReview).toHaveBeenCalledWith(REVIEW_ID);
    expect(out).toMatchObject({ status: 'completed', issue_count: 1 });
  });

  it('reads by id when the callback is for another review', async () => {
    const client = mockClient({ getReview: jest.fn().mockResolvedValue(REVIEW) });
    await appTester(review.performResume, resumeReview(callback(reviewEvent({ review_id: 'other999' }))));

    expect(client.getReview).toHaveBeenCalledWith(REVIEW_ID);
  });

  it('reads by id when the signature does not verify', async () => {
    const client = mockClient({ getReview: jest.fn().mockResolvedValue(REVIEW) });
    await appTester(review.performResume, resumeReview(callback(reviewEvent(), { secret: 'whsec_wrong' })));

    expect(client.getReview).toHaveBeenCalledWith(REVIEW_ID);
  });

  it('reads by id when the callback carries no review', async () => {
    const client = mockClient({ getReview: jest.fn().mockResolvedValue(REVIEW) });
    await appTester(review.performResume, resumeReview(callback(reviewEvent({ review: undefined }))));

    expect(client.getReview).toHaveBeenCalledWith(REVIEW_ID);
  });

  it('a review still running is reported as running, not as a failure', async () => {
    mockClient({ getReview: jest.fn().mockResolvedValue({ review_id: REVIEW_ID, status: 'verifying', summary: {} }) });
    const out = await appTester(review.performResume, resumeReview(undefined));

    expect(out).toMatchObject({ status: 'verifying', outcome: '', error: '', retryable: null });
    expect(out.message).toMatch(/still running .* Review ID is rev12345/);
  });

  it('maps an error reading the review', async () => {
    mockClient({ getReview: jest.fn().mockRejectedValue(new LenzError({ message: 'Forbidden', statusCode: 403 })) });
    const err = await capture(review.performResume, resumeReview(undefined));

    expect(err.message).toMatch(/Forbidden/);
  });
});

// ─── Check Citations ─────────────────────────────────────────────────────────

const cite = App.creates.check_citations.operation;
const CITECHECK_ID = 'cc123456';

const CITECHECK = {
  citecheck_id: CITECHECK_ID,
  status: 'completed',
  outcome: 'issues_found',
  created_at: '2026-09-27T19:24:05Z',
  completed_at: '2026-09-27T19:24:08Z',
  summary: { citation_limit_reached: true, citation_checks: { checked: 2, unchecked: 1, failed: 1 }, citation_issues: 1 },
  credits: { charged: 2 },
  citations: [
    {
      index: 0,
      reference: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
      cited_url: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
      doi: null,
      statement: 'The Eiffel Tower was completed in 1889.',
      result: { finding: 'supported', source: 'support', is_issue: false },
      check: { status: 'completed', page_title: 'Eiffel Tower - Wikipedia', snippet: '31 March 1889', rationale: 'Supported.' },
    },
    {
      index: 1,
      reference: 'doi:10.1000/x',
      cited_url: null,
      doi: '10.1000/x',
      statement: 'Mount Everest is 7,000 metres high.',
      result: { finding: 'contradicted', source: 'support', is_issue: true },
      check: null,
    },
  ],
  citation_issues: [
    {
      citation_index: 1,
      reference: 'doi:10.1000/x',
      cited_url: null,
      doi: '10.1000/x',
      statement: 'Mount Everest is 7,000 metres high.',
      finding: 'contradicted',
      snippet: '8,848.86 m',
      rationale: 'Contradicted.',
      page_title: 'Mount Everest',
    },
  ],
};

const citeEvent = (over = {}) => ({
  event: 'citecheck.completed',
  event_id: 'evt_def',
  citecheck_id: CITECHECK_ID,
  task_id: 'chain_2',
  status: 'completed',
  citecheck: CITECHECK,
  attempt: 1,
  delivered_at: new Date().toISOString(),
  ...over,
});

const resumeCite = (rawRequest) => ({
  authData: AUTH,
  outputData: { citecheck_id: CITECHECK_ID, status: 'queued' },
  rawRequest,
});

describe('creates.check_citations', () => {
  it('submits the draft with the callback URL and a replay-stable key', async () => {
    const client = mockClient();
    const out = await appTester(cite.perform, { authData: AUTH, inputData: { text: 'See [1].', maxCitations: '4' } });

    expect(out).toMatchObject({ citecheck_id: CITECHECK_ID, status: 'queued', citations: [] });
    expect(client.citecheck).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'See [1].',
        maxCitations: 4,
        webhookUrl: CALLBACK,
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it('while testing: only the free usage check, then the sample', async () => {
    const client = mockClient();
    const out = await appTester(cite.perform, { authData: AUTH, inputData: { text: 'x' }, meta: { isLoadingSample: true } });

    expect(client.citecheck).not.toHaveBeenCalled();
    expect(out.citecheck_id).toBe('217c8a01');
  });

  it('halts when Lenz refuses the callback for a missing secret', async () => {
    mockClient({
      citecheck: jest.fn().mockRejectedValue(
        new LenzError({ message: 'no secret', statusCode: 422, code: 'webhook_secret_missing', body: { code: 'webhook_secret_missing' } }),
      ),
    });
    const err = await capture(cite.perform, { authData: AUTH, inputData: { text: 'x' } });

    expect(err.name).toBe('HaltedError');
    expect(err.message).toMatch(/so Check Citations cannot receive its result/);
  });

  it('waits and replays while citation checking is unavailable', async () => {
    mockClient({
      citecheck: jest.fn().mockRejectedValue(
        new LenzError({ message: 'unavailable', statusCode: 503, code: 'citations_unavailable', body: { retry_after: 300 } }),
      ),
    });
    const err = await capture(cite.perform, { authData: AUTH, inputData: { text: 'x' } });

    expect(err.name).toBe('ThrottledError');
    expect(throttleDelay(err)).toBe(300);
    expect(JSON.parse(err.message).message).toMatch(/Citation checking is temporarily unavailable/);
  });

  it('reads the check from the signed callback without calling the API', async () => {
    const client = mockClient();
    const out = await appTester(cite.performResume, resumeCite(callback(citeEvent())));

    expect(client.getCitecheck).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      citecheck_id: CITECHECK_ID,
      status: 'completed',
      outcome: 'issues_found',
      citations_checked: 2,
      citations_unchecked: 2,
      citation_issue_count: 1,
      citation_limit_reached: true,
      credits_charged: 2,
      error: '',
    });
    expect(out.citations).toHaveLength(2);
    expect(out.citations[0]).toMatchObject({ finding: 'supported', is_issue: false, page_title: 'Eiffel Tower - Wikipedia' });
    // A citation that was not read has no check block: every field still a string.
    expect(out.citations[1]).toMatchObject({ finding: 'contradicted', is_issue: true, cited_url: '', rationale: '', snippet: '' });
  });

  it('shapes a failed check', async () => {
    mockClient();
    const failed = { ...CITECHECK, status: 'failed', outcome: null, citations: [], citation_issues: [], failure: { failure_reason: 'no_citations' } };
    const out = await appTester(
      cite.performResume,
      resumeCite(callback(citeEvent({ event: 'citecheck.failed', status: 'failed', citecheck: failed }))),
    );

    expect(out).toMatchObject({ status: 'failed', error: 'no_citations', failure_reason: 'no_citations', retryable: null });
  });

  it('reads by id for any other event, another check, or no body', async () => {
    const client = mockClient({ getCitecheck: jest.fn().mockResolvedValue(CITECHECK) });
    await appTester(cite.performResume, resumeCite(callback(citeEvent({ event: 'review.completed' }))));
    await appTester(cite.performResume, resumeCite(callback(citeEvent({ citecheck_id: 'zz999999' }))));
    await appTester(cite.performResume, resumeCite(callback(citeEvent({ citecheck: undefined }))));
    await appTester(cite.performResume, resumeCite(undefined));

    expect(client.getCitecheck).toHaveBeenCalledTimes(4);
  });

  it('a check still running is reported as running', async () => {
    mockClient({ getCitecheck: jest.fn().mockResolvedValue({ citecheck_id: CITECHECK_ID, status: 'checking' }) });
    const out = await appTester(cite.performResume, resumeCite(undefined));

    expect(out).toMatchObject({ status: 'checking', error: '' });
    expect(out.message).toMatch(/Citation Check ID is cc123456/);
  });
});

// ─── Review fixes: edges the first pass missed ───────────────────────────────

const keysOf = (op) => op.outputFields.map((f) => f.key).sort();

describe('every branch returns exactly the declared output keys', () => {
  it('Review a Draft: parked, completed, failed and still running', async () => {
    mockClient({ getReview: jest.fn().mockResolvedValue({ review_id: REVIEW_ID, status: 'verifying' }) });
    const failed = { ...REVIEW, status: 'failed', failure: null };
    const outs = [
      await appTester(review.perform, { authData: AUTH, inputData: { text: 'x' } }),
      await appTester(review.performResume, resumeReview(callback(reviewEvent()))),
      await appTester(review.performResume, resumeReview(callback(reviewEvent({ event: 'review.failed', review: failed })))),
      await appTester(review.performResume, resumeReview(undefined)),
    ];
    for (const out of outs) expect(Object.keys(out).sort()).toEqual(keysOf(review));
  });

  it('Check Citations: parked, completed, failed and still running', async () => {
    mockClient({ getCitecheck: jest.fn().mockResolvedValue({ citecheck_id: CITECHECK_ID, status: 'checking' }) });
    const failed = { ...CITECHECK, status: 'failed', failure: null };
    const outs = [
      await appTester(cite.perform, { authData: AUTH, inputData: { text: 'x' } }),
      await appTester(cite.performResume, resumeCite(callback(citeEvent()))),
      await appTester(cite.performResume, resumeCite(callback(citeEvent({ event: 'citecheck.failed', citecheck: failed })))),
      await appTester(cite.performResume, resumeCite(undefined)),
    ];
    for (const out of outs) expect(Object.keys(out).sort()).toEqual(keysOf(cite));
  });
});

describe('Review a Draft edges', () => {
  it('0 deep checks is sent as 0 (quick checks only), not left to the default', async () => {
    const client = mockClient();
    await appTester(review.perform, { authData: AUTH, inputData: { text: 'x', maxVerifications: '0', visibility: 'unlisted' } });

    const sent = client.review.mock.calls[0][0];
    expect(sent.maxVerifications).toBe(0);
    expect(sent.visibility).toBe('unlisted');
  });

  it('a value that is not a number is left to the server default', async () => {
    const client = mockClient();
    await appTester(review.perform, { authData: AUTH, inputData: { text: 'x', maxVerifications: 'abc' } });

    expect(client.review.mock.calls[0][0].maxVerifications).toBeUndefined();
  });

  it('reads by id when the callback review has no status', async () => {
    const client = mockClient({ getReview: jest.fn().mockResolvedValue(REVIEW) });
    await appTester(review.performResume, resumeReview(callback(reviewEvent({ review: { review_id: REVIEW_ID } }))));

    expect(client.getReview).toHaveBeenCalledWith(REVIEW_ID);
  });

  it('a failed review with no failure block still reads as failed', async () => {
    mockClient();
    const failed = { ...REVIEW, status: 'failed', outcome: null, issues: [], citation_issues: [], failure: null };
    const out = await appTester(
      review.performResume,
      resumeReview(callback(reviewEvent({ event: 'review.failed', status: 'failed', review: failed }))),
    );

    expect(out).toMatchObject({ status: 'failed', error: 'The job failed.', failure_reason: '', failure_class: '', retryable: null });
  });

  it('says when citations were asked for and not checked, and counts only claims with no verdict', async () => {
    mockClient();
    const skipped = {
      ...REVIEW,
      summary: {
        ...REVIEW.summary,
        assessments: { completed: 3, failed: 1 },
        citations_skipped: 'insufficient_credits',
        citation_checks: { checked: 0, unchecked: 0, failed: 0 },
      },
      failures: [
        { claim_index: 2, stage: 'assessment' },
        { claim_index: 3, stage: 'verification' },
      ],
    };
    const out = await appTester(review.performResume, resumeReview(callback(reviewEvent({ review: skipped }))));

    expect(out).toMatchObject({ citations_skipped: 'insufficient_credits', claims_checked: 3, unchecked_claims: 1 });
  });

  it('two runs of the same draft get different keys, because each has its own callback URL', async () => {
    // The app tester hands every run the same echo URL, so perform is called
    // with a minimal z whose callback URL changes per run, as Zapier's does.
    // Under one key the second run would be refused (422
    // idempotency_body_mismatch): the server binds the key to webhook_url too.
    const client = mockClient();
    const zFor = (url) => ({
      generateCallbackUrl: () => url,
      hash: (alg, str, enc, inEnc) => crypto.createHash(alg).update(str, inEnc).digest(enc),
      errors: zapier.errors,
      console,
    });
    const bundle = { authData: AUTH, inputData: { text: 'Same draft.' }, meta: { zap: { id: 7 } } };
    await review.perform(zFor('https://hooks.zapier.com/a'), bundle);
    await review.perform(zFor('https://hooks.zapier.com/a'), bundle);
    await review.perform(zFor('https://hooks.zapier.com/b'), bundle);

    const keys = client.review.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe('Check Citations edges', () => {
  it('0 or blank citations is the default (20), never a 422', async () => {
    const client = mockClient();
    await appTester(cite.perform, { authData: AUTH, inputData: { text: 'x', maxCitations: '0', language: 'fr' } });
    await appTester(cite.perform, { authData: AUTH, inputData: { text: 'x', maxCitations: '' } });

    expect(client.citecheck.mock.calls[0][0]).toMatchObject({ maxCitations: undefined, language: 'fr' });
    expect(client.citecheck.mock.calls[1][0].maxCitations).toBeUndefined();
  });

  it('sends the same key for a replay of the same run, a different one for another draft', async () => {
    const client = mockClient();
    const run = (text) => appTester(cite.perform, { authData: AUTH, inputData: { text }, meta: { zap: { id: 7 } } });
    await run('Draft one.');
    await run('Draft one.');
    await run('Draft two.');

    const keys = client.citecheck.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('while testing: says so when the connection has no webhook secret', async () => {
    mockClient({ usage: jest.fn().mockResolvedValue({ has_webhook_secret: false }) });
    const err = await capture(cite.perform, { authData: AUTH, inputData: { text: 'x' }, meta: { isLoadingSample: true } });

    expect(err.message).toMatch(/Check Citations needs this Lenz connection to have a webhook signing secret/);
  });

  it('reads by id when the callback check has no status', async () => {
    const client = mockClient({ getCitecheck: jest.fn().mockResolvedValue(CITECHECK) });
    await appTester(cite.performResume, resumeCite(callback(citeEvent({ citecheck: { citecheck_id: CITECHECK_ID } }))));

    expect(client.getCitecheck).toHaveBeenCalledWith(CITECHECK_ID);
  });

  it('maps an error reading the check', async () => {
    mockClient({ getCitecheck: jest.fn().mockRejectedValue(new LenzError({ message: 'Forbidden', statusCode: 403 })) });
    const err = await capture(cite.performResume, resumeCite(undefined));

    expect(err.message).toMatch(/Forbidden/);
  });
});

// ─── Maximum Citations to Check: a number above 20 is 20 ────────────────────

describe('a citation limit above the 20 one run takes counts as 20', () => {
  it('Check Citations: 50 is sent as 20, blank and 0 as the default', async () => {
    const client = mockClient();
    for (const value of ['50', '20', '', '0']) {
      await appTester(cite.perform, { authData: AUTH, inputData: { text: 'x', maxCitations: value } });
    }
    expect(client.citecheck.mock.calls.map(([input]) => input.maxCitations)).toEqual([20, 20, undefined, undefined]);
  });

  it('Review a Draft: 100 is sent as 20, 5 as 5, blank skips citations', async () => {
    const client = mockClient();
    for (const value of ['100', '5', '']) {
      await appTester(review.perform, { authData: AUTH, inputData: { text: 'x', maxCitations: value } });
    }
    expect(client.review.mock.calls.map(([input]) => input.maxCitations)).toEqual([20, 5, undefined]);
  });
});
