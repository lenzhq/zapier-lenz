/* globals describe, it, expect, jest */

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient, LenzValidationError } = require('lenz-io');
const App = require('../index');

const appTester = zapier.createAppTester(App);

async function captureCreateError(performFn, bundle) {
  return appTester(performFn, bundle).then(
    () => null,
    (e) => e,
  );
}

function mockClient(overrides = {}) {
  return {
    verify: jest.fn(),
    getStatus: jest.fn(),
    assess: jest.fn(),
    extract: jest.fn(),
    ask: { send: jest.fn() },
    usage: jest.fn(),
    ...overrides,
  };
}

describe('creates.verify_claim', () => {
  it('perform submits with a Zapier callback URL and returns the task_id', async () => {
    const client = mockClient({
      verify: jest.fn().mockResolvedValue({ task_id: 'task_123' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
    };
    const result = await appTester(App.creates.verify_claim.operation.perform, bundle);

    expect(result).toMatchObject({ task_id: 'task_123', status: 'processing' });
    // appTester hardcodes callback_url to Zapier's staging echo server; in
    // production Zapier's platform injects a real per-Zap callback URL here.
    expect(client.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: 'The Eiffel Tower is 330 metres tall.',
        webhookUrl: 'https://auth-json-server.zapier-staging.com/echo',
      }),
    );
  });

  it('while loading a sample: makes only the free usage() check (never verify) and stubs when the key has a webhook secret', async () => {
    const client = mockClient({
      verify: jest.fn(),
      usage: jest.fn().mockResolvedValue({ plan: 'plus', has_webhook_secret: true }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'A different claim.' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.verify_claim.operation.perform, bundle);

    // Fully canned Eiffel-Tower example — the real input claim is NOT spliced
    // in, so a chained test reads as obvious example data, not a mismatch.
    expect(result).toMatchObject({
      status: 'completed',
      verification_id: 'ab12cd34',
      claim: expect.stringContaining('Eiffel Tower'),
    });
    // Free usage() call only; NO credit-spending verify submission.
    expect(client.usage).toHaveBeenCalled();
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('while loading a sample: warns at test time when the key has no webhook secret (has_webhook_secret === false)', async () => {
    const client = mockClient({
      verify: jest.fn(),
      usage: jest.fn().mockResolvedValue({ plan: 'plus', has_webhook_secret: false }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_nosecret' },
      inputData: { claim: 'A claim.' },
      meta: { isLoadingSample: true },
    };

    await expect(appTester(App.creates.verify_claim.operation.perform, bundle)).rejects.toThrow(
      /webhook secret/i,
    );
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('while loading a sample: degrades gracefully on an older server that omits has_webhook_secret (no false warning)', async () => {
    const client = mockClient({
      verify: jest.fn(),
      // Old server: field absent → undefined → strict === false check is a no-op.
      usage: jest.fn().mockResolvedValue({ plan: 'plus' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'A claim.' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.verify_claim.operation.perform, bundle);

    expect(result).toMatchObject({ status: 'completed', verification_id: 'ab12cd34' });
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('perform surfaces a clear, actionable message when the key has no webhook secret yet (live run)', async () => {
    const apiError = new LenzValidationError({
      message: 'webhook_url was supplied but this API key has no HMAC secret. Generate one at https://lenz.io/api-credentials.',
      statusCode: 422,
      body: { detail: 'webhook_url was supplied but this API key has no HMAC secret.', code: 'webhook_secret_missing' },
    });
    const client = mockClient({ verify: jest.fn().mockRejectedValue(apiError) });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
    };

    await expect(appTester(App.creates.verify_claim.operation.perform, bundle)).rejects.toThrow(
      /generate webhook secret/i,
    );
  });

  it('perform re-throws any other error unchanged', async () => {
    const apiError = new LenzValidationError({ message: 'Text is required.', statusCode: 422, body: { detail: 'Text is required.' } });
    const client = mockClient({ verify: jest.fn().mockRejectedValue(apiError) });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { claim: '' } };

    await expect(appTester(App.creates.verify_claim.operation.perform, bundle)).rejects.toThrow('Text is required.');
  });

  it('performResume fetches the terminal status and shapes a completed verdict', async () => {
    const client = mockClient({
      getStatus: jest.fn().mockResolvedValue({
        status: 'completed',
        result: {
          verification_id: 'ab12cd34',
          claim: 'The Eiffel Tower is 330 metres tall.',
          verdict: 'True',
          confidence: 'high',
          lenz_score: 9,
          key_finding: 'Official Eiffel Tower figures confirm a current height of 330 metres.',
          executive_summary: 'Confirmed by multiple official sources.',
          sources: [{ title: 'Official site', url: 'https://www.toureiffel.paris' }],
        },
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      outputData: { task_id: 'task_123', status: 'processing' },
    };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result).toMatchObject({
      task_id: 'task_123',
      status: 'completed',
      passed: true,
      verification_id: 'ab12cd34',
      verdict: 'True',
      key_finding: 'Official Eiffel Tower figures confirm a current height of 330 metres.',
    });
    expect(client.getStatus).toHaveBeenCalledWith('task_123');
  });

  it('performResume defaults key_finding to "" on claims that pre-date the field', async () => {
    const client = mockClient({
      getStatus: jest.fn().mockResolvedValue({
        status: 'completed',
        result: {
          verification_id: 'ab12cd34',
          claim: 'The Eiffel Tower is 330 metres tall.',
          verdict: 'True',
          confidence: 'high',
          lenz_score: 9,
          executive_summary: 'Confirmed by multiple official sources.',
          sources: [],
        },
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      outputData: { task_id: 'task_123', status: 'processing' },
    };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result.key_finding).toBe('');
  });

  it('performResume surfaces a needs_input pause without throwing', async () => {
    const client = mockClient({
      getStatus: jest.fn().mockResolvedValue({ status: 'needs_input', reason: 'multi_claim' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, outputData: { task_id: 'task_123' } };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result).toMatchObject({ status: 'needs_input', reason: 'multi_claim' });
  });

  // Depth and Visibility (#18). Depth is the one that saves money:
  // VERIFY_DEPTH_COSTS in lenz/billing.py is {standard: 10, low: 5}.
  describe('depth and visibility', () => {
    const SUBMIT = {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
    };

    async function submitWith(inputData) {
      const client = mockClient({ verify: jest.fn().mockResolvedValue({ task_id: 'task_123' }) });
      LenzClient.mockImplementation(() => client);
      await appTester(App.creates.verify_claim.operation.perform, {
        ...SUBMIT,
        inputData: { ...SUBMIT.inputData, ...inputData },
      });
      return client.verify.mock.calls[0][0];
    }

    it('asks for the depth chosen, so a low check is billed at the low price', async () => {
      expect(await submitWith({ depth: 'low' })).toMatchObject({ depth: 'low' });
    });

    it('sends visibility when chosen', async () => {
      expect(await submitWith({ visibility: 'unlisted' })).toMatchObject({
        visibility: 'unlisted',
      });
    });

    // Blank must be OMITTED, not sent as '', so the server applies its own
    // default and an existing Zap's request stays byte-identical.
    it('omits both when left blank, leaving existing Zaps unchanged on the wire', async () => {
      const body = await submitWith({});
      expect(body.depth).toBeUndefined();
      expect(body.visibility).toBeUndefined();
    });

    // The charge follows the REQUEST; the echo describes the EVIDENCE. A low
    // request Lenz answers from an existing standard verdict costs 5 and
    // reads back "standard". Without this field the two are indistinguishable.
    it('reports the depth the verdict was produced with, not the one requested', async () => {
      const client = mockClient({
        getStatus: jest.fn().mockResolvedValue({
          status: 'completed',
          result: { verdict: 'True', sources: [], depth: 'standard', visibility: 'unlisted' },
        }),
      });
      LenzClient.mockImplementation(() => client);

      const result = await appTester(App.creates.verify_claim.operation.performResume, {
        authData: { apiKey: 'lenz_good' },
        outputData: { task_id: 'task_123' },
      });

      expect(result.depth).toBe('standard');
      expect(result.visibility).toBe('unlisted');
    });

    it('reports an empty depth on a verdict stored before the field existed', async () => {
      const client = mockClient({
        getStatus: jest
          .fn()
          .mockResolvedValue({ status: 'completed', result: { verdict: 'True', sources: [] } }),
      });
      LenzClient.mockImplementation(() => client);

      const result = await appTester(App.creates.verify_claim.operation.performResume, {
        authData: { apiKey: 'lenz_good' },
        outputData: { task_id: 'task_123' },
      });

      expect(result.depth).toBe('');
      expect(result.visibility).toBe('');
    });

    // Same every-branch rule as the failure and needs_input fields.
    it.each([
      ['needs_input', { status: 'needs_input', reason: 'multi_claim' }],
      ['failed', { status: 'failed', error: 'boom' }],
      ['processing', { status: 'processing' }],
    ])('carries depth and visibility EMPTY, not missing, on %s', async (_label, body) => {
      LenzClient.mockImplementation(() =>
        mockClient({ getStatus: jest.fn().mockResolvedValue(body) }),
      );

      const result = await appTester(App.creates.verify_claim.operation.performResume, {
        authData: { apiKey: 'lenz_good' },
        outputData: { task_id: 'task_123' },
      });

      expect(result).toHaveProperty('depth');
      expect(result).toHaveProperty('visibility');
      expect(result.depth).toBe('');
      expect(result.visibility).toBe('');
    });

    // The help text promises half price. If that number is ever edited to
    // match the SDK's stale "same quota cost" docstring, this fails.
    it('tells the user Low is cheaper, which is the only reason to offer it', () => {
      const depthField = App.creates.verify_claim.operation.inputFields.find(
        (f) => f.key === 'depth',
      );
      expect(depthField.choices.map((c) => c.value)).toEqual(['standard', 'low']);
      expect(depthField.helpText).toMatch(/5 credits instead of 10/i);
      // And the charge/echo split, without which it reads as a billing bug.
      expect(depthField.helpText).toMatch(/charged for the depth you request/i);
    });

    // Low is NOT "same reasoning, less evidence". That is the phrase
    // lenz/constants.py uses and then qualifies in the next breath:
    // DEBATE_DEPTH_PROFILES[low] is {rebuttals: False}, so the debate stops
    // after the openings — a reasoning step, not an evidence one. The first
    // draft of this help text promised identical reasoning and was wrong.
    it('says the debate is shorter at Low, instead of promising equal reasoning', () => {
      const helpText = App.creates.verify_claim.operation.inputFields.find(
        (f) => f.key === 'depth',
      ).helpText;
      expect(helpText).toMatch(/debate/i);
      expect(helpText).toMatch(/opening/i);
      expect(helpText).not.toMatch(/same reasoning|identical reasoning/i);
    });
  });

  // Lenz stops for input for THREE reasons, each carrying data the user needs
  // to act. Until 1.4.0 every one of them got the same "rephrase and re-run"
  // message and the data was dropped. Shapes here mirror the server
  // (lenz/api/public_authed.py, /verify/status) exactly.
  describe('needs_input, keyed on reason', () => {
    const RESUME = { authData: { apiKey: 'lenz_good' }, outputData: { task_id: 'task_123' } };
    const NEEDS_INPUT_KEYS = [
      'reason',
      'message',
      'claims',
      'candidates',
      'similar_claims',
      'duplicate_verification_id',
      'duplicate_url',
    ];

    async function resumeWith(status) {
      LenzClient.mockImplementation(() => mockClient({ getStatus: jest.fn().mockResolvedValue(status) }));
      return appTester(App.creates.verify_claim.operation.performResume, RESUME);
    }

    it('multi_claim: exposes each claim as a line item and says to fan out, not rephrase', async () => {
      const result = await resumeWith({
        status: 'needs_input',
        reason: 'multi_claim',
        claims: [
          { text: 'The Eiffel Tower is 330 metres tall.', domain: 'Science' },
          { text: 'The Eiffel Tower was completed in 1889.', domain: 'History' },
        ],
      });

      expect(result.claims).toEqual([
        { text: 'The Eiffel Tower is 330 metres tall.', domain: 'Science' },
        { text: 'The Eiffel Tower was completed in 1889.', domain: 'History' },
      ]);
      expect(result.message).toContain('2 separate claims');
      expect(result.message).not.toMatch(/rephrase/i);
      expect(result.candidates).toEqual([]);
      expect(result.similar_claims).toEqual([]);
    });

    it('clarification_required: normalises the string candidates to line items', async () => {
      // The API sends candidates as bare strings; a string array is not
      // mappable per-item in the editor, so they become { text } rows.
      const result = await resumeWith({
        status: 'needs_input',
        reason: 'clarification_required',
        candidates: ['Joe Biden won the 2020 US election.', 'Donald Trump won the 2020 US election.'],
      });

      expect(result.candidates).toEqual([
        { text: 'Joe Biden won the 2020 US election.' },
        { text: 'Donald Trump won the 2020 US election.' },
      ]);
      expect(result.message).toContain('2 ways');
      expect(result.claims).toEqual([]);
    });

    it('duplicate_found: points at the existing verification instead of telling the user to re-run', async () => {
      // The old advice — rephrase and re-run — spent a fresh 10-credit
      // pipeline to reproduce a result that already existed.
      const result = await resumeWith({
        status: 'needs_input',
        reason: 'duplicate_found',
        similar_claims: [
          {
            verification_id: 'dup12345',
            claim: 'The Eiffel Tower is 330 metres tall.',
            verdict: 'True',
            confidence: 'high',
            lenz_score: 9,
            url: 'https://lenz.io/c/eiffel-tower-height-dup12345',
            distance: 0.02,
          },
          { verification_id: 'dup67890', claim: 'A second match.', verdict: 'Mostly True', url: '' },
        ],
      });

      expect(result.duplicate_verification_id).toBe('dup12345');
      expect(result.duplicate_url).toBe('https://lenz.io/c/eiffel-tower-height-dup12345');
      expect(result.similar_claims).toHaveLength(2);
      expect(result.similar_claims[0]).toMatchObject({
        verification_id: 'dup12345',
        verdict: 'True',
        lenz_score: 9,
      });
      // `distance` is internal ranking noise and is deliberately not passed on.
      expect(result.similar_claims[0]).not.toHaveProperty('distance');
      expect(result.message).toContain('dup12345');
      expect(result.message).toMatch(/already been verified/i);
      expect(result.message).not.toMatch(/rephrase/i);
    });

    it('duplicate_found with nothing similar still degrades without throwing', async () => {
      const result = await resumeWith({ status: 'needs_input', reason: 'duplicate_found' });

      expect(result.duplicate_verification_id).toBe('');
      expect(result.duplicate_url).toBe('');
      expect(result.similar_claims).toEqual([]);
      expect(result.message).toMatch(/already been verified/i);
    });

    it('an unknown reason gets a generic message rather than wrong advice', async () => {
      const result = await resumeWith({ status: 'needs_input', reason: 'something_new' });

      expect(result.reason).toBe('something_new');
      expect(result.message).toContain('something_new');
      expect(result.message).not.toMatch(/rephrase/i);
    });

    // Same rule as the failure fields: every branch carries every key, empty
    // when not applicable, because a Filter treats missing and empty as
    // different conditions and the editor builds filters from the sample.
    it.each([
      ['completed', { status: 'completed', result: { verdict: 'True', sources: [] } }],
      ['failed', { status: 'failed', error: 'boom' }],
      ['processing', { status: 'processing' }],
    ])('carries the needs_input keys EMPTY, not missing, on %s', async (_label, body) => {
      const result = await resumeWith(body);
      for (const key of NEEDS_INPUT_KEYS) {
        expect(result).toHaveProperty(key);
      }
      expect(result.claims).toEqual([]);
      expect(result.candidates).toEqual([]);
      expect(result.similar_claims).toEqual([]);
      expect(result.duplicate_verification_id).toBe('');
    });

    it('the kickoff output carries them too, since that is what a Zap sees if the callback never comes', async () => {
      LenzClient.mockImplementation(() =>
        mockClient({ verify: jest.fn().mockResolvedValue({ task_id: 'task_123' }) }),
      );
      const result = await appTester(App.creates.verify_claim.operation.perform, {
        authData: { apiKey: 'lenz_good' },
        inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
      });
      for (const key of [...NEEDS_INPUT_KEYS, 'error', 'failure_reason', 'failure_class', 'retryable']) {
        expect(result).toHaveProperty(key);
      }
    });
  });

  it('performResume surfaces a failed pipeline with the branchable failure fields', async () => {
    const client = mockClient({
      getStatus: jest.fn().mockResolvedValue({
        status: 'failed',
        error: 'Pipeline stopped at: research_empty',
        failure_reason: 'research_empty',
        failure_class: 'upstream_unavailable',
        retryable: true,
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, outputData: { task_id: 'task_123' } };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Pipeline stopped at: research_empty',
      failure_reason: 'research_empty',
      failure_class: 'upstream_unavailable',
      retryable: true,
    });
  });

  it('performResume tolerates a legacy failed body without the 2026-08 fields', async () => {
    const client = mockClient({
      getStatus: jest.fn().mockResolvedValue({ status: 'failed', error: 'boom' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, outputData: { task_id: 'task_123' } };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result).toMatchObject({
      status: 'failed',
      error: 'boom',
      failure_reason: '',
      failure_class: '',
      retryable: null,
    });
  });

  // Zapier's Filter distinguishes "does not exist" from "is empty", and the Zap
  // editor builds those filters from SAMPLE. Any key SAMPLE promises must
  // therefore be PRESENT (empty, not missing) on every branch, or a filter the
  // user tested against the sample behaves differently on a live run.
  it.each([
    ['completed', { status: 'completed', result: { verdict: 'True', sources: [] } }],
    ['needs_input', { status: 'needs_input', reason: 'multi_claim' }],
  ])('performResume returns the failure fields EMPTY, not missing, on %s', async (_label, body) => {
    LenzClient.mockImplementation(() => mockClient({ getStatus: jest.fn().mockResolvedValue(body) }));

    const bundle = { authData: { apiKey: 'lenz_good' }, outputData: { task_id: 'task_123' } };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    for (const key of ['error', 'failure_reason', 'failure_class', 'retryable']) {
      expect(result).toHaveProperty(key);
    }
    expect(result.error).toBe('');
    expect(result.failure_reason).toBe('');
    expect(result.failure_class).toBe('');
    expect(result.retryable).toBeNull();
  });

  it('performResume does not report a still-running verification as failed', async () => {
    // The callback firing before the pipeline settles is not a failure. Calling
    // it one would send retryable: null — "re-running will not help" — about a
    // task that is about to succeed, and a Zap branching on that field would
    // raise a false alarm.
    LenzClient.mockImplementation(() =>
      mockClient({ getStatus: jest.fn().mockResolvedValue({ status: 'processing' }) }),
    );

    const bundle = { authData: { apiKey: 'lenz_good' }, outputData: { task_id: 'task_123' } };
    const result = await appTester(App.creates.verify_claim.operation.performResume, bundle);

    expect(result.status).toBe('processing');
    expect(result.failure_class).toBe('');
    expect(result.retryable).toBeNull();
    expect(result.error).toBe('');
  });
});

describe('creates.assess', () => {
  it('derives passed=true/false per claim', async () => {
    const client = mockClient({
      assess: jest.fn().mockResolvedValue({
        claims: [
          { claim: 'A', verdict: 'True', confidence: 'high', verification_url: null },
          { claim: 'B', verdict: 'False', confidence: 'high', verification_url: null },
        ],
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A and B' } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result.status).toBe('ok');
    expect(result.claims).toEqual([
      expect.objectContaining({ claim: 'A', passed: true }),
      expect.objectContaining({ claim: 'B', passed: false }),
    ]);
  });

  it('surfaces error_code when no claim is found', async () => {
    const client = mockClient({
      assess: jest.fn().mockResolvedValue({ claims: [], error: 'No claim found.', error_code: 'no_claim' }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'huh?' } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result).toMatchObject({ status: 'no_claim', message: 'No claim found.' });
  });

  it('stubs sample data and makes NO real call while loading a sample (no assess credit spent on a test click)', async () => {
    const client = mockClient({ assess: jest.fn() });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A' }, meta: { isLoadingSample: true } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result.status).toBe('ok');
    expect(client.assess).not.toHaveBeenCalled();
  });

  // The API retired `ambiguous` on 2026-09-12 (lenz-io 2.13.0 changelog): a
  // vague input is now assessed on its most likely reading. The old branch
  // mapped `error_code === 'ambiguous'` to a third status value, which a
  // Paths step could be built on and which would then never fire. Whatever
  // code arrives with an empty list, the status is `no_claim`.
  it('reports no_claim for an empty list whatever the error_code — ambiguous is retired', async () => {
    const client = mockClient({
      assess: jest.fn().mockResolvedValue({
        claims: [],
        error: 'Which one?',
        error_code: 'ambiguous',
        candidate_claims: ['Reading A', 'Reading B'],
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'vague' } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result.status).toBe('no_claim');
    // Always empty now, even if an old cached response still carries values:
    // the sample and outputFields say so, and a Zap must not be taught to
    // expect readings that the API no longer produces.
    expect(result.candidate_claims).toEqual([]);
  });

  // #28. Every row carries every key. A verdict row and an Error row are the
  // same shape with different halves filled, so a Filter built against the
  // sample sees the same fields on a live run whichever comes back.
  it('passes error_code, hint and identified_claims through per row, empty on verdict rows', async () => {
    const client = mockClient({
      assess: jest.fn().mockResolvedValue({
        claims: [
          {
            claim: 'The tower is tall and it was built in 1889.',
            verdict: 'True',
            confidence: 'high',
            language: 'en',
            rationale: 'Official figures agree.',
            dissent: null,
            error_code: null,
            hint: 'Also check: it was built in 1889.',
            identified_claims: ['It was built in 1889.'],
          },
          {
            claim: 'hello',
            verdict: 'Error',
            confidence: null,
            language: 'en',
            rationale: null,
            dissent: null,
            error_code: 'no_claim',
            hint: 'Send a statement of fact, not a greeting.',
            identified_claims: [],
          },
        ],
      }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'x' } };
    const result = await appTester(App.creates.assess.operation.perform, bundle);

    expect(result.status).toBe('ok');
    expect(result.claims[0]).toEqual(
      expect.objectContaining({
        passed: true,
        rationale: 'Official figures agree.',
        dissent: '',
        error_code: '',
        hint: 'Also check: it was built in 1889.',
        identified_claims: ['It was built in 1889.'],
      }),
    );
    expect(result.claims[1]).toEqual(
      expect.objectContaining({
        verdict: 'Error',
        passed: false,
        error_code: 'no_claim',
        hint: 'Send a statement of fact, not a greeting.',
        identified_claims: [],
        rationale: '',
      }),
    );
  });

  // #19. A Zapier replay is a fresh process with a fresh SDK client, so the
  // SDK's own random per-invocation key does not survive it — the replayed
  // request looks new to the server and is charged again. The key has to be
  // derived from what the replay shares with its original.
  describe('replay idempotency key', () => {
    const live = (over = {}) => ({
      authData: { apiKey: 'lenz_good' },
      inputData: { text: 'The tower is tall.', language: 'en' },
      meta: { zap: { id: 12345 } },
      ...over,
    });
    const keyOf = (client) => client.assess.mock.calls[0][0].idempotencyKey;

    it('sends a key derived from the Zap, the input and the hour — the same one on a replay', async () => {
      const client = mockClient({ assess: jest.fn().mockResolvedValue({ claims: [] }) });
      LenzClient.mockImplementation(() => client);

      await appTester(App.creates.assess.operation.perform, live());
      const first = keyOf(client);
      expect(first).toMatch(/^[0-9a-f]{64}$/);

      // A replay: same bundle, new process. Modelled as a second call.
      client.assess.mockClear();
      await appTester(App.creates.assess.operation.perform, live());
      expect(keyOf(client)).toBe(first);
    });

    it('differs for a different Zap, input, or language', async () => {
      const client = mockClient({ assess: jest.fn().mockResolvedValue({ claims: [] }) });
      LenzClient.mockImplementation(() => client);

      await appTester(App.creates.assess.operation.perform, live());
      const base = keyOf(client);

      for (const variant of [
        live({ meta: { zap: { id: 99999 } } }),
        live({ inputData: { text: 'A different claim.', language: 'en' } }),
        live({ inputData: { text: 'The tower is tall.', language: 'es' } }),
      ]) {
        client.assess.mockClear();
        await appTester(App.creates.assess.operation.perform, variant);
        expect(keyOf(client)).not.toBe(base);
      }
    });

    // No text ever crosses the wire in the header: the key is a digest.
    it('is a digest, not the input', async () => {
      const client = mockClient({ assess: jest.fn().mockResolvedValue({ claims: [] }) });
      LenzClient.mockImplementation(() => client);

      await appTester(App.creates.assess.operation.perform, live());
      expect(keyOf(client)).not.toContain('tower');
    });

    // `bundle.meta.zap.id` is @deprecated in platform-core and absent from
    // the bundle docs, so it may be missing on a live run. The guard must not
    // silently switch itself off there: without it the key falls back to the
    // input and the hour, which the server already scopes per API key.
    it('still sends a stable key without a zap id, keyed on the input and the hour', async () => {
      const client = mockClient({ assess: jest.fn().mockResolvedValue({ claims: [] }) });
      LenzClient.mockImplementation(() => client);

      await appTester(App.creates.assess.operation.perform, live({ meta: {} }));
      const first = keyOf(client);
      expect(first).toMatch(/^[0-9a-f]{64}$/);

      client.assess.mockClear();
      await appTester(App.creates.assess.operation.perform, live({ meta: {} }));
      expect(keyOf(client)).toBe(first);
    });

    // `z.hash` defaults its input encoding to 'binary' (latin1), which drops
    // the high byte of every UTF-16 unit: U+4E00 and U+4F00 would collide,
    // and two different Chinese claims would share a verdict. Review of #43.
    it('does not collide on non-Latin text that differs only in the high byte', async () => {
      const client = mockClient({ assess: jest.fn().mockResolvedValue({ claims: [] }) });
      LenzClient.mockImplementation(() => client);

      await appTester(
        App.creates.assess.operation.perform,
        live({ inputData: { text: '一', language: 'zh' } }),
      );
      const a = keyOf(client);

      client.assess.mockClear();
      await appTester(
        App.creates.assess.operation.perform,
        live({ inputData: { text: '伀', language: 'zh' } }),
      );
      expect(keyOf(client)).not.toBe(a);
    });
  });

  // A transient failure inside a 200. The same condition thrown as a typed
  // 503 is mapped to ThrottledError and replayed (test/errors.test.js), so a
  // row-shaped one must not quietly read as "checked and did not pass" —
  // which is what `status: ok, passed: false` says to a Filter.
  describe('transient Error rows', () => {
    const transientRow = (code) => ({
      claim: 'A',
      verdict: 'Error',
      confidence: null,
      error_code: code,
      hint: 'Send it again.',
      identified_claims: [],
    });

    it.each(['upstream_unavailable', 'timeout'])(
      'replays with ThrottledError when every row is %s — nothing was charged',
      async (code) => {
        const client = mockClient({
          assess: jest.fn().mockResolvedValue({ claims: [transientRow(code), transientRow(code)] }),
        });
        LenzClient.mockImplementation(() => client);

        const err = await captureCreateError(App.creates.assess.operation.perform, {
          authData: { apiKey: 'lenz_good' },
          inputData: { text: 'A and B' },
        });

        expect(err.name).toBe('ThrottledError');
        expect(err.message).toContain(code);
        expect(err.message).toContain('nothing was charged');
      },
    );

    // The server stores every 200 under its Idempotency-Key for 24h — this
    // all-Error body included. A replay 60s later would carry the same key
    // (same Zap, input, hour) and get the stored rows back, then land here
    // again every 60s until the hour ticked over. So the delay reaches into
    // the NEXT hour bucket, where the key changes and the panel really runs.
    it('delays the replay into the next hour bucket so it gets a fresh key', async () => {
      const { DEFAULT_THROTTLE_DELAY, MAX_THROTTLE_DELAY } = require('../lib/errors');
      const client = mockClient({
        assess: jest.fn().mockResolvedValue({ claims: [transientRow('timeout')] }),
      });
      LenzClient.mockImplementation(() => client);

      const before = Date.now();
      const err = await captureCreateError(App.creates.assess.operation.perform, {
        authData: { apiKey: 'lenz_good' },
        inputData: { text: 'A' },
        meta: { zap: { id: 1 } },
      });

      const HOUR = 60 * 60 * 1000;
      const nextBucketAt = (Math.floor(before / HOUR) + 1) * HOUR;
      // ThrottledError serialises `{ message, delay }` into its message.
      const { delay } = JSON.parse(err.message);
      const replayAt = Date.now() + delay * 1000;

      expect(err.name).toBe('ThrottledError');
      expect(delay).toBeGreaterThanOrEqual(DEFAULT_THROTTLE_DELAY);
      expect(delay).toBeLessThanOrEqual(MAX_THROTTLE_DELAY);
      // The one property that matters: the replay lands in a later bucket.
      expect(replayAt).toBeGreaterThanOrEqual(nextBucketAt);
    });

    // Verdict rows are charged; a replay would charge them again. So a mixed
    // result is returned, and the transient row keeps its error_code so a
    // Zap can still tell it apart from a failed claim.
    it('returns the rows when only some are transient, since the others were charged', async () => {
      const client = mockClient({
        assess: jest.fn().mockResolvedValue({
          claims: [
            { claim: 'A', verdict: 'True', confidence: 'high' },
            transientRow('upstream_unavailable'),
          ],
        }),
      });
      LenzClient.mockImplementation(() => client);

      const result = await appTester(App.creates.assess.operation.perform, {
        authData: { apiKey: 'lenz_good' },
        inputData: { text: 'A and B' },
      });

      expect(result.status).toBe('ok');
      expect(result.claims[0]).toEqual(expect.objectContaining({ passed: true, error_code: '' }));
      expect(result.claims[1]).toEqual(
        expect.objectContaining({ passed: false, error_code: 'upstream_unavailable' }),
      );
    });

    // `no_claim` and `framing_failed` are answers about the input, not the
    // weather. Replaying them spends the run for the same result.
    it.each(['no_claim', 'framing_failed'])('keeps a %s Error row as a row', async (code) => {
      const client = mockClient({
        assess: jest.fn().mockResolvedValue({ claims: [transientRow(code)] }),
      });
      LenzClient.mockImplementation(() => client);

      const result = await appTester(App.creates.assess.operation.perform, {
        authData: { apiKey: 'lenz_good' },
        inputData: { text: 'hello' },
      });

      expect(result.status).toBe('ok');
      expect(result.claims[0]).toEqual(expect.objectContaining({ verdict: 'Error', error_code: code }));
    });
  });

  // Every row key is present on every row — including on a response from a
  // server old enough not to send the new keys at all.
  it('emits every declared row key even when the API omits them', () => {
    const declared = App.creates.assess.operation.outputFields
      .find((f) => f.key === 'claims')
      .children.map((c) => c.key);
    const client = mockClient({
      assess: jest.fn().mockResolvedValue({ claims: [{ claim: 'A', verdict: 'True' }] }),
    });
    LenzClient.mockImplementation(() => client);

    return appTester(App.creates.assess.operation.perform, {
      authData: { apiKey: 'lenz_good' },
      inputData: { text: 'A' },
    }).then((result) => {
      for (const key of declared) {
        expect(result.claims[0]).toHaveProperty(key);
      }
    });
  });

  // lenz-io 2.12.0 gave `assess` a 45s floor: `max(client timeoutMs, 45s)`
  // unless the call passes its own. Left alone, that carries the request
  // past Zapier's ~30s step limit and undoes the budget client.js sets. The
  // pin is invisible in any other test because the client is mocked, so it
  // gets its own.
  it('pins the per-call timeout so the SDK floor cannot exceed the Zapier budget', async () => {
    const { CALL_TIMEOUT_MS } = require('../client');
    const client = mockClient({ assess: jest.fn().mockResolvedValue({ claims: [] }) });
    LenzClient.mockImplementation(() => client);

    await appTester(App.creates.assess.operation.perform, {
      authData: { apiKey: 'lenz_good' },
      inputData: { text: 'A' },
    });

    expect(client.assess).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: CALL_TIMEOUT_MS }));
    expect(CALL_TIMEOUT_MS).toBeLessThan(30000);
  });
});

describe('creates.extract_claims', () => {
  it('passes the raw extraction result through', async () => {
    const client = mockClient({
      extract: jest.fn().mockResolvedValue({ status: 'ready', claim: 'A', identified_claims: ['A'] }),
    });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A' } };
    const result = await appTester(App.creates.extract_claims.operation.perform, bundle);

    expect(result).toMatchObject({ status: 'ready', claim: 'A' });
  });

  it('stubs sample data and makes NO real call while loading a sample (consistent with the other creates)', async () => {
    const client = mockClient({ extract: jest.fn() });
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' }, inputData: { text: 'A' }, meta: { isLoadingSample: true } };
    const result = await appTester(App.creates.extract_claims.operation.perform, bundle);

    expect(result.status).toBe('ready');
    expect(Array.isArray(result.identified_claims)).toBe(true);
    expect(client.extract).not.toHaveBeenCalled();
  });

  // lenz-io 2.13.0 gave `extract` a 90s floor — three times Zapier's step
  // limit. See the matching assess test for why it needs its own assertion.
  it('pins the per-call timeout so the SDK 90s floor cannot exceed the Zapier budget', async () => {
    const { CALL_TIMEOUT_MS } = require('../client');
    const client = mockClient({
      extract: jest.fn().mockResolvedValue({ status: 'ready', claim: 'A', identified_claims: [] }),
    });
    LenzClient.mockImplementation(() => client);

    await appTester(App.creates.extract_claims.operation.perform, {
      authData: { apiKey: 'lenz_good' },
      inputData: { text: 'A' },
    });

    expect(client.extract).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: CALL_TIMEOUT_MS }));
  });

  // The sample IS the contract for filter-building: `perform` passes the API
  // response through untouched, so a sample value the API never sends teaches
  // a filter that silently matches nothing. Three fields shipped that way
  // until 1.3.2 — `status: 'ok'`, `domain: 'science'` and a one-element
  // `identified_claims` — so each gets a ratchet.
  it('samples only status values this integration can receive', () => {
    // `no_match` joined this list when the Focus input shipped. Before that it
    // was excluded on purpose: the API schema allowed it, but it needs a
    // `focus` hint the integration did not send, so accepting it would have
    // let the sample carry a value no user could ever see. Now Focus exists,
    // so all three are genuinely receivable.
    const RECEIVABLE = ['ready', 'not_a_claim', 'no_match'];
    expect(RECEIVABLE).toContain(App.creates.extract_claims.operation.sample.status);
  });

  // Focus (#18). The 300-char cap is the server's, and it 422s rather than
  // truncating — a silently shortened focus would return a subset of the
  // claims with nothing to show it happened.
  describe('focus', () => {
    const AUTH_X = { authData: { apiKey: 'lenz_good' } };

    it('sends the focus when given one', async () => {
      const client = mockClient({
        extract: jest.fn().mockResolvedValue({ status: 'ready', claim: 'A', identified_claims: [] }),
      });
      LenzClient.mockImplementation(() => client);

      await appTester(App.creates.extract_claims.operation.perform, {
        ...AUTH_X,
        inputData: { text: 'some text', focus: 'pricing and headcount' },
      });

      expect(client.extract).toHaveBeenCalledWith(
        expect.objectContaining({ focus: 'pricing and headcount' }),
      );
    });

    it('omits focus entirely when blank, so the wire format is unchanged', async () => {
      const client = mockClient({
        extract: jest.fn().mockResolvedValue({ status: 'ready', claim: 'A', identified_claims: [] }),
      });
      LenzClient.mockImplementation(() => client);

      await appTester(App.creates.extract_claims.operation.perform, {
        ...AUTH_X,
        inputData: { text: 'some text' },
      });

      expect(client.extract.mock.calls[0][0].focus).toBeUndefined();
    });

    // Measured the way the server measures it. A 320-character focus whose
    // runs of whitespace collapse to under 300 is ACCEPTED — checking the raw
    // string would refuse something the API would have taken.
    it('measures the limit after collapsing whitespace, not on the raw string', async () => {
      const client = mockClient({
        extract: jest.fn().mockResolvedValue({ status: 'ready', claim: 'A', identified_claims: [] }),
      });
      LenzClient.mockImplementation(() => client);

      const padded = `${'a'.repeat(290)}${' '.repeat(40)}end`;
      expect(padded.length).toBeGreaterThan(300);

      await appTester(App.creates.extract_claims.operation.perform, {
        ...AUTH_X,
        inputData: { text: 'some text', focus: padded },
      });

      expect(client.extract).toHaveBeenCalledWith(
        expect.objectContaining({ focus: `${'a'.repeat(290)} end` }),
      );
    });

    it('refuses an over-long focus locally, naming the real length', async () => {
      const client = mockClient({ extract: jest.fn() });
      LenzClient.mockImplementation(() => client);

      const err = await captureCreateError(App.creates.extract_claims.operation.perform, {
        ...AUTH_X,
        inputData: { text: 'some text', focus: 'x'.repeat(301) },
      });

      expect(err).toBeTruthy();
      expect(err.message).toContain('301');
      expect(err.message).toContain('300');
      // Refused before the call, so no daily-cap unit is spent on a request
      // the server would have rejected anyway.
      expect(client.extract).not.toHaveBeenCalled();
    });

    // Focus is a static field value, so an over-long one is wrong on every
    // run, for good. A HaltedError stops the run without counting toward the
    // error rate that turns the Zap off; a plain Error would retire the Zap
    // for a typo that retrying can never fix. Same call lib/errors.js makes
    // for a spent balance and verify_claim.js for a missing webhook secret.
    it('halts rather than hard-failing on a live run, so the Zap is not auto-disabled', async () => {
      const client = mockClient({ extract: jest.fn() });
      LenzClient.mockImplementation(() => client);

      const err = await captureCreateError(App.creates.extract_claims.operation.perform, {
        ...AUTH_X,
        inputData: { text: 'some text', focus: 'x'.repeat(301) },
      });

      expect(err.name).toBe('HaltedError');
    });

    // The editor is the one place the hard class is right: it makes Test fail
    // visibly. Checking AFTER the sample return — as this did originally —
    // meant Test passed green and every live run failed instead.
    it('fails the editor test too, instead of returning a green sample', async () => {
      const client = mockClient({ extract: jest.fn() });
      LenzClient.mockImplementation(() => client);

      const err = await captureCreateError(App.creates.extract_claims.operation.perform, {
        ...AUTH_X,
        inputData: { text: 'some text', focus: 'x'.repeat(301) },
        meta: { isLoadingSample: true },
      });

      expect(err).toBeTruthy();
      expect(err.name).not.toBe('HaltedError');
      expect(err.message).toContain('301');
      expect(client.extract).not.toHaveBeenCalled();
    });

    // `.length` counts UTF-16 code units, so 200 emoji measure 400 and would
    // be refused with a number the user cannot reconcile with what they
    // typed — while the server, counting characters, would have accepted it.
    it('counts characters, not UTF-16 code units, so emoji are not double-counted', async () => {
      const client = mockClient({
        extract: jest.fn().mockResolvedValue({ status: 'ready', claim: 'A', identified_claims: [] }),
      });
      LenzClient.mockImplementation(() => client);

      // 200 characters, 400 code units — over the 300 cap by one measure and
      // comfortably under it by the one the server uses.
      const emoji = '🙂'.repeat(200);
      expect(emoji.length).toBeGreaterThan(300);
      expect([...emoji].length).toBeLessThanOrEqual(300);

      await appTester(App.creates.extract_claims.operation.perform, {
        ...AUTH_X,
        inputData: { text: 'some text', focus: emoji },
      });

      expect(client.extract).toHaveBeenCalledWith(expect.objectContaining({ focus: emoji }));
    });

    // no_match is a real answer, not a failure: claims were found and the
    // focus excluded all of them. It became reachable only with Focus.
    it('names no_match instead of leaving an unexplained empty list', async () => {
      const client = mockClient({
        extract: jest
          .fn()
          .mockResolvedValue({ status: 'no_match', claim: '', identified_claims: [] }),
      });
      LenzClient.mockImplementation(() => client);

      const result = await appTester(App.creates.extract_claims.operation.perform, {
        ...AUTH_X,
        inputData: { text: 'some text', focus: 'something absent' },
      });

      expect(result.status).toBe('no_match');
      expect(result.message).toMatch(/none of them fall within your Focus/i);
    });

    // `message` is declared in outputFields, so it has to exist on every path
    // — the missing-vs-empty trap again.
    it('carries message EMPTY, not missing, on the ordinary paths', async () => {
      for (const status of ['ready', 'not_a_claim']) {
        const client = mockClient({
          extract: jest.fn().mockResolvedValue({ status, claim: 'A', identified_claims: [] }),
        });
        LenzClient.mockImplementation(() => client);

        const result = await appTester(App.creates.extract_claims.operation.perform, {
          ...AUTH_X,
          inputData: { text: 'some text' },
        });

        expect(result).toHaveProperty('message');
        expect(result.message).toBe('');
      }
    });
  });

  // `identified_claims` is the COMPLETE ordered list when more than one claim
  // was found and `[]` when only one was: `texts if len(texts) > 1 else []`
  // in lenz/extraction.py. A one-element list is unreachable, so a sample
  // carrying one teaches a shape no live run produces.
  it('never samples an unreachable one-element identified_claims', () => {
    const { identified_claims: list } = App.creates.extract_claims.operation.sample;
    expect(Array.isArray(list)).toBe(true);
    expect(list).not.toHaveLength(1);
  });

  // `presumed_intent` is free text, one sentence — not an enum. A sample of
  // 'informational' looks enumerable and invites an exact-string filter that
  // can never match reliably.
  it('samples presumed_intent as a sentence, not an enum token', () => {
    const intent = App.creates.extract_claims.operation.sample.presumed_intent;
    expect(intent).toMatch(/\s/);
    expect(intent.trim()).toMatch(/\.$/);
  });

  it('samples the domain in the canonical capitalised form', () => {
    const API_DOMAINS = [
      'Health',
      'Science',
      'Politics',
      'Finance',
      'Tech',
      'History',
      'Legal',
      'General',
    ];
    expect(API_DOMAINS).toContain(App.creates.extract_claims.operation.sample.domain);
    expect(API_DOMAINS).toContain(App.triggers.new_verification.operation.sample.domain);
  });
});

describe('creates.ask', () => {
  it('returns the reply content as answer', async () => {
    const client = mockClient({
      ask: { send: jest.fn().mockResolvedValue({ role: 'expert', content: 'Because sources say so.' }) },
    });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { verificationId: 'ab12cd34', question: 'Why?' },
    };
    const result = await appTester(App.creates.ask.operation.perform, bundle);

    expect(result).toEqual({ answer: 'Because sources say so.' });
    expect(client.ask.send).toHaveBeenCalledWith('ab12cd34', expect.objectContaining({ message: 'Why?' }));
  });

  it('stubs sample data and makes NO real call while loading a sample (no ask exchange spent; also handles the chained placeholder ID)', async () => {
    const client = mockClient({ ask: { send: jest.fn() } });
    LenzClient.mockImplementation(() => client);

    const bundle = {
      authData: { apiKey: 'lenz_good' },
      inputData: { verificationId: 'ab12cd34', question: 'Why?' },
      meta: { isLoadingSample: true },
    };
    const result = await appTester(App.creates.ask.operation.perform, bundle);

    expect(result.answer).toBeTruthy();
    expect(client.ask.send).not.toHaveBeenCalled();
  });
});

// #17 — `language` was free text described as "ISO 639-1", but the API
// accepts exactly twelve codes and 422s everything else. A 422 becomes a
// plain z.errors.Error, which counts toward the error rate that turns a Zap
// off, so `English` or `en-US` in that box failed EVERY run with nothing in
// the editor to explain it.
describe('language is a closed set on every action', () => {
  const ACTIONS = ['verify_claim', 'assess', 'extract_claims', 'ask'];

  // Copied from SUPPORTED_LANGUAGES in lenz/languages.py, which that module
  // names as its source of truth — `en` first, then roughly descending
  // expected API demand. Spelled out here rather than imported from
  // lib/languages.js, because a test that reads the same constant it is
  // checking would pass no matter what either one said. If the server ever
  // adds a language, this list and lib/languages.js both move.
  const SERVER_CODES = [
    'en',
    'es',
    'de',
    'fr',
    'it',
    'pt',
    'nl',
    'sv',
    'da',
    'no',
    'fi',
    'bg',
  ];

  const languageFieldOf = (action) =>
    App.creates[action].operation.inputFields.find((f) => f.key === 'language');

  it.each(ACTIONS)('%s offers exactly the codes the server accepts, in order', (action) => {
    expect(languageFieldOf(action).choices.map((c) => c.value)).toEqual(SERVER_CODES);
  });

  it.each(ACTIONS)('%s leaves language optional, because blank is meaningful', (action) => {
    expect(languageFieldOf(action).required).toBe(false);
  });

  it('labels each code with its language name rather than repeating the code', () => {
    const choices = languageFieldOf('verify_claim').choices;
    expect(choices[0]).toEqual({ value: 'en', sample: 'en', label: 'English' });
    expect(choices[11]).toEqual({ value: 'bg', sample: 'bg', label: 'Bulgarian' });
    for (const choice of choices) {
      expect(choice.label).not.toBe(choice.value);
    }
  });

  // The two meanings of blank really do differ, so the help text must too.
  // On ask the server falls back to the CLAIM's stored language
  // (lenz/api/public_authed.py:2996), not English.
  it('tells ask users that blank is not English there', () => {
    const helpText = languageFieldOf('ask').helpText;
    expect(helpText).toMatch(/does NOT mean English/);
    expect(helpText).toMatch(/stored in/i);
  });

  it.each(['verify_claim', 'assess', 'extract_claims'])('%s says blank means English', (action) => {
    expect(languageFieldOf(action).helpText).toMatch(/Leave blank for English/i);
  });

  // The point of the field is the OUTPUT language; reading it as a
  // description of the input is the obvious misreading, and picking it that
  // way silently changes the answer's language. lenz/languages.py principle 1:
  // "We never detect, validate, or warn about the input language."
  it.each(ACTIONS)('%s says the field sets the response, not the input', (action) => {
    expect(languageFieldOf(action).helpText).toMatch(/does not describe your/i);
  });
});

// #22 — the every-branch rule, enforced at RUNTIME.
//
// test/schema.test.js already checks `outputFields` against `sample`, but that
// is a static check on two declarations: both can agree while the code returns
// something else entirely. That is exactly what happened here. `sample` and
// `outputFields` promised the full verdict, and the non-completed branches of
// performResume returned nine fewer keys than that — `passed`, `verdict`,
// `confidence`, `lenz_score`, `key_finding`, `executive_summary`, `sources`,
// `verification_id` and `claim` were simply absent.
//
// Zapier's Filter treats a MISSING field and an EMPTY one as different
// conditions, and the editor builds filters from `sample`. So a filter like
// "Verdict is empty" tested clean against the sample and then never matched on
// a live run that ended in needs_input or failed — silently, with nothing to
// indicate why. The file argued this rule for the failure fields and then did
// not apply it to the verdict ones.
describe('every performResume branch emits every key the sample promises', () => {
  const SAMPLE_KEYS = Object.keys(App.creates.verify_claim.operation.sample);

  const resumeWith = async (status) => {
    LenzClient.mockImplementation(() => mockClient({ getStatus: jest.fn().mockResolvedValue(status) }));
    return appTester(App.creates.verify_claim.operation.performResume, {
      authData: { apiKey: 'lenz_good' },
      outputData: { task_id: 'task_123' },
    });
  };

  it.each([
    ['completed', { status: 'completed', result: { verdict: 'True', sources: [] } }],
    ['needs_input', { status: 'needs_input', reason: 'multi_claim', claims: [] }],
    ['needs_input/duplicate', { status: 'needs_input', reason: 'duplicate_found', similar_claims: [] }],
    ['failed', { status: 'failed', error: 'boom' }],
    ['processing', { status: 'processing' }],
    ['unknown status', { status: 'something_new' }],
  ])('%s', async (_label, status) => {
    const result = await resumeWith(status);
    const missing = SAMPLE_KEYS.filter((k) => !(k in result));
    expect(missing).toEqual([]);
  });

  // The kickoff return is what Zapier parks as outputData and shows the user
  // if the callback never arrives, so it is bound by the same rule.
  it('perform (kickoff)', async () => {
    LenzClient.mockImplementation(() =>
      mockClient({ verify: jest.fn().mockResolvedValue({ task_id: 'task_123' }) }),
    );
    const result = await appTester(App.creates.verify_claim.operation.perform, {
      authData: { apiKey: 'lenz_good' },
      inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
    });
    expect(SAMPLE_KEYS.filter((k) => !(k in result))).toEqual([]);
  });
});

// #22 — fields the API always sends that this action used to drop on the
// floor. Every one of these is unconditionally present in
// build_verification_detail (lenz/api/verification_payload.py:163-207), so
// there is no branch where asking for them is speculative.
describe('the completed verdict carries what the API actually sends', () => {
  const COMPLETED = {
    status: 'completed',
    result: {
      verdict: 'True',
      language: 'es',
      domain: 'Science',
      warnings: ['Sources disagree on the exact figure.'],
      created_at: '2026-07-14T12:00:00Z',
      sources: [
        {
          source_name: 'Tour Eiffel',
          title: 'Official site',
          url: 'https://www.toureiffel.paris',
          snippet: 'The tower stands 330 metres tall.',
          date: '2026-01-15',
        },
      ],
    },
  };

  const resume = async (status) => {
    LenzClient.mockImplementation(() =>
      mockClient({ getStatus: jest.fn().mockResolvedValue(status) }),
    );
    return appTester(App.creates.verify_claim.operation.performResume, {
      authData: { apiKey: 'lenz_good' },
      outputData: { task_id: 'task_123' },
    });
  };

  // snippet is the quotable half of a citation; dropping it meant a Zap could
  // link a source but never quote it.
  it('keeps all five source fields, not just title and url', async () => {
    const result = await resume(COMPLETED);
    expect(result.sources[0]).toEqual({
      source_name: 'Tour Eiffel',
      title: 'Official site',
      url: 'https://www.toureiffel.paris',
      snippet: 'The tower stands 330 metres tall.',
      date: '2026-01-15',
    });
  });

  it('passes through language, domain and created_at', async () => {
    const result = await resume(COMPLETED);
    expect(result.language).toBe('es');
    expect(result.domain).toBe('Science');
    expect(result.created_at).toBe('2026-07-14T12:00:00Z');
  });

  // Bare strings on the wire, wrapped as line items so a Zap can iterate them
  // — the same treatment Candidate Readings gets, and for the same reason.
  it('wraps warnings as line items rather than bare strings', async () => {
    const result = await resume(COMPLETED);
    expect(result.warnings).toEqual([{ text: 'Sources disagree on the exact figure.' }]);
  });

  // An older server, or a claim stored before a field existed, must not
  // produce `undefined` — that is the missing-vs-empty trap again.
  it('falls back to empty rather than undefined when the server omits them', async () => {
    const result = await resume({ status: 'completed', result: { verdict: 'True' } });
    expect(result.language).toBe('');
    expect(result.domain).toBe('');
    expect(result.warnings).toEqual([]);
    expect(result.created_at).toBe('');
    expect(result.sources).toEqual([]);
  });
});

// #22 — assess echoes the language per claim and dropped it.
describe('assess carries the per-claim language echo', () => {
  it('passes language through on each claim', async () => {
    LenzClient.mockImplementation(() =>
      mockClient({
        assess: jest.fn().mockResolvedValue({
          claims: [{ claim: 'x', verdict: 'True', confidence: 'high', language: 'de' }],
        }),
      }),
    );
    const result = await appTester(App.creates.assess.operation.perform, {
      authData: { apiKey: 'lenz_good' },
      inputData: { text: 'x' },
    });
    expect(result.claims[0].language).toBe('de');
  });
});
