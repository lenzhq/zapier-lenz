/* globals describe, it, expect, jest */

/**
 * Zapier error-taxonomy mapping.
 *
 * These are the only tests in this app with real signal on the change: every
 * other suite mocks the SDK client wholesale, so its assertions pass
 * identically before and after. What matters here is not the message text but
 * WHICH Zapier error class is thrown, because that decides whether the user's
 * Zap keeps running:
 *
 *   HaltedError    → run stops, does NOT count as an error
 *   ThrottledError → Zapier replays after the given delay
 *   ExpiredAuthError → user is prompted to reconnect
 *   Error          → hard failure; enough of these turn the Zap OFF
 */

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const {
  Lenz: LenzClient,
  LenzQuotaExceededError,
  LenzRateLimitError,
  LenzAuthError,
  LenzError,
} = require('lenz-io');
const App = require('../index');

const appTester = zapier.createAppTester(App);

function mockClient(overrides = {}) {
  return {
    verify: jest.fn(),
    getStatus: jest.fn(),
    assess: jest.fn(),
    extract: jest.fn(),
    ask: { send: jest.fn() },
    usage: jest.fn(),
    verifications: { list: jest.fn() },
    ...overrides,
  };
}

function quotaError() {
  const err = new LenzQuotaExceededError({
    message: 'No remaining claim checks.',
    statusCode: 402,
  });
  // Deliberately NOT the hardcoded fallback in lib/errors.js. If this were
  // 'https://lenz.io/plans', deleting the `err.upgradeUrl` read entirely
  // would leave every assertion below green.
  err.upgradeUrl = 'https://example.test/upgrade-sentinel';
  // `remaining` is in the CAPABILITY's unit (verifications); `creditBalance`
  // and `cost` are in credits. The three are deliberately different numbers
  // here so a test cannot pass by reading the wrong one.
  err.remaining = 0;
  err.creditBalance = 4;
  err.cost = 10;
  err.resetsAt = '2026-09-01T00:00:00+00:00';
  return err;
}

async function captureError(performFn, bundle) {
  return appTester(performFn, bundle).then(
    () => null,
    (e) => e,
  );
}

const AUTH = { authData: { apiKey: 'lenz_good' } };

describe('quota (402) → HaltedError', () => {
  it('halts rather than erroring, so running out of credits cannot disable a Zap', async () => {
    LenzClient.mockImplementation(() =>
      mockClient({ assess: jest.fn().mockRejectedValue(quotaError()) }),
    );

    const err = await captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { text: 'The Great Wall is visible from space.' },
    });

    expect(err).toBeTruthy();
    expect(err.name).toBe('HaltedError');
    expect(err.message).toContain('No remaining claim checks.');
    expect(err.message).toContain('https://example.test/upgrade-sentinel');
    // Must not invite a retry — a 402 never clears on retry.
    expect(err.message).toContain("Retrying won't help");
  });

  it('sizes the shortfall in credits, not in capability units', async () => {
    // "4 credits, this needs 10" is one top-up away; "0 verifications" reads
    // as a plan problem. The user sees this message in the Zap history with
    // no other context, so it has to carry the distinction itself.
    LenzClient.mockImplementation(() =>
      mockClient({ assess: jest.fn().mockRejectedValue(quotaError()) }),
    );

    const err = await captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { text: 'The Great Wall is visible from space.' },
    });

    expect(err.message).toContain('costs 10 credits');
    expect(err.message).toContain('you have 4 left');
  });

  it('omits the balance line rather than printing undefined', async () => {
    // The API omits `cost` / `credits_remaining` when it cannot resolve them,
    // so the SDK leaves them null — the message must degrade to the plain
    // wording rather than saying "costs undefined credits".
    const bare = quotaError();
    bare.creditBalance = null;
    bare.cost = null;
    LenzClient.mockImplementation(() => mockClient({ assess: jest.fn().mockRejectedValue(bare) }));

    const err = await captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { text: 'anything' },
    });

    expect(err.name).toBe('HaltedError');
    expect(err.message).not.toContain('undefined');
    expect(err.message).not.toContain('costs');
    expect(err.message).toContain("Retrying won't help");
  });

  it('degrades the same way when the fields are absent, not null', async () => {
    // `null` is what a CURRENT SDK reports for a field the server omitted.
    // An SDK too old to know the field at all leaves it `undefined` — a
    // different shape, and the one that ships if the dependency floor slips.
    const bare = quotaError();
    delete bare.creditBalance;
    delete bare.cost;
    LenzClient.mockImplementation(() => mockClient({ assess: jest.fn().mockRejectedValue(bare) }));

    const err = await captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { text: 'anything' },
    });

    expect(err.name).toBe('HaltedError');
    expect(err.message).not.toContain('undefined');
    expect(err.message).not.toContain('costs');
  });

  it('still names the cost when only the balance is unreported', async () => {
    // The server resolves `credits_remaining` ONLY when the caller supplied
    // neither `remaining` nor `resets_at`, while `cost` is emitted
    // unconditionally from the weight table — so a real 402 can carry the cost
    // alone. An all-or-nothing guard would throw away the half we do have.
    const partial = quotaError();
    partial.creditBalance = null;
    LenzClient.mockImplementation(() =>
      mockClient({ assess: jest.fn().mockRejectedValue(partial) }),
    );

    const err = await captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { text: 'anything' },
    });

    expect(err.message).toContain('costs 10 credits');
    expect(err.message).not.toContain('left');
  });

  it('says nothing about size when the refused call costs no credits', async () => {
    // /extract is weight 0, so a 402 on it is the plan not covering the call,
    // not a shortfall. "Costs 0 credits and you have 0 left" would send the
    // user to a top-up that cannot fix it.
    const free = quotaError();
    free.cost = 0;
    free.creditBalance = 0;
    LenzClient.mockImplementation(() => mockClient({ extract: jest.fn().mockRejectedValue(free) }));

    const err = await captureError(App.creates.extract_claims.operation.perform, {
      ...AUTH,
      inputData: { text: 'some text' },
    });

    expect(err.name).toBe('HaltedError');
    expect(err.message).not.toContain('costs 0 credits');
    expect(err.message).not.toContain('0 left');
  });

  it('states the reset once, not twice', async () => {
    // The advice used to appear as "wait for the monthly reset." immediately
    // followed by "Credits reset <timestamp>." — the same sentence twice.
    LenzClient.mockImplementation(() =>
      mockClient({ assess: jest.fn().mockRejectedValue(quotaError()) }),
    );

    const err = await captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { text: 'anything' },
    });

    expect(err.message).toContain('2026-09-01');
    expect(err.message).not.toContain('monthly reset');
    // Counting occurrences would be unreliable: Zapier's app tester appends a
    // diagnostic envelope that repeats the thrown message. Assert on the two
    // wordings that used to sit side by side instead.
    expect(err.message).not.toContain('monthly reset');
    expect(err.message).not.toContain('Credits reset');
  });

  it('does not read the deprecated creditsRemaining alias', async () => {
    // `creditsRemaining` aliases `remaining` (a verification count, 0 here)
    // while `creditBalance` is the pool (4). Reading the alias would print the
    // wrong unit AND touch a deprecated accessor.
    //
    // The VALUE assertions are the load-bearing ones. The warning check is
    // secondary on purpose: the SDK gates it behind a process-wide one-shot
    // latch, so any earlier read anywhere in the worker makes it vacuous.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      LenzClient.mockImplementation(() =>
        mockClient({ assess: jest.fn().mockRejectedValue(quotaError()) }),
      );

      const err = await captureError(App.creates.assess.operation.perform, {
        ...AUTH,
        inputData: { text: 'anything' },
      });

      expect(err.message).toContain('you have 4 left');
      expect(err.message).not.toContain('you have 0 left');

      const said = warn.mock.calls.flat().join(' ');
      expect(said).not.toContain('creditsRemaining is deprecated');
    } finally {
      // NOT after the assertions: a failing expect throws, and an unrestored
      // spy would silence console.warn for every test after this one.
      warn.mockRestore();
    }
  });

  it('is built against an SDK that actually reports the credit pool', () => {
    // The ratchet for the defect this feature shipped with: every other test
    // here ASSIGNS creditBalance/cost onto the error by hand, so they pass
    // against an SDK that never populates them. lenz-io declares both as
    // class fields (null when unreported) from 2.9.0; on 2.7.0 and 2.8.0 they
    // are absent entirely and the whole feature is a silent no-op.
    const err = new LenzQuotaExceededError({ message: 'x', statusCode: 402 });
    expect(err).toHaveProperty('creditBalance');
    expect(err).toHaveProperty('cost');
  });

  it('surfaces the reset time when the server states one', async () => {
    LenzClient.mockImplementation(() =>
      mockClient({ extract: jest.fn().mockRejectedValue(quotaError()) }),
    );

    const err = await captureError(App.creates.extract_claims.operation.perform, {
      ...AUTH,
      inputData: { text: 'some text' },
    });

    expect(err.name).toBe('HaltedError');
    expect(err.message).toContain('2026-09-01');
  });

  it('applies on the Ask action too', async () => {
    LenzClient.mockImplementation(() =>
      mockClient({ ask: { send: jest.fn().mockRejectedValue(quotaError()) } }),
    );

    const err = await captureError(App.creates.ask.operation.perform, {
      ...AUTH,
      inputData: { verificationId: 'ab12cd34', question: 'Which source is strongest?' },
    });

    expect(err.name).toBe('HaltedError');
  });

  it('applies on the polling trigger, which fires on every Zap', async () => {
    LenzClient.mockImplementation(() =>
      mockClient({ verifications: { list: jest.fn().mockRejectedValue(quotaError()) } }),
    );

    const err = await captureError(App.triggers.new_verification.operation.perform, AUTH);

    expect(err.name).toBe('HaltedError');
  });

  it('applies on Verify a Claim without losing the webhook-secret branch', async () => {
    LenzClient.mockImplementation(() =>
      mockClient({ verify: jest.fn().mockRejectedValue(quotaError()) }),
    );

    const err = await captureError(App.creates.verify_claim.operation.perform, {
      ...AUTH,
      inputData: { claim: 'The Eiffel Tower is 330 metres tall.' },
    });

    expect(err.name).toBe('HaltedError');
  });

  it('still maps webhook_secret_missing to its own precise error', async () => {
    const err422 = new LenzError({ message: 'Webhook secret missing', statusCode: 422 });
    err422.body = { code: 'webhook_secret_missing' };
    LenzClient.mockImplementation(() =>
      mockClient({ verify: jest.fn().mockRejectedValue(err422) }),
    );

    const err = await captureError(App.creates.verify_claim.operation.perform, {
      ...AUTH,
      inputData: { claim: 'x' },
    });

    expect(err.name).not.toBe('HaltedError');
    expect(err.message).toContain('webhook secret');
  });
});

describe('capacity / provider outage (503) → ThrottledError', () => {
  // Admission control and provider-exhaustion 503s carry a typed body code
  // and a stated wait. Like 402, the condition resolves itself — it must not
  // count against the Zap's error budget.
  function capacityError({ code = 'capacity', body } = {}) {
    return new LenzError({
      message: 'Server error',
      statusCode: 503,
      code,
      body,
    });
  }

  async function capture503(err503) {
    LenzClient.mockImplementation(() =>
      mockClient({ assess: jest.fn().mockRejectedValue(err503) }),
    );
    return captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { claim: 'x' },
    });
  }

  it('replays a capacity 503 after the stated body retry_after', async () => {
    const err = await capture503(capacityError({ body: { retry_after: 100 } }));
    expect(err.name).toBe('ThrottledError');
    expect(JSON.parse(err.message).delay).toBe(100);
    expect(JSON.parse(err.message).message).toContain('at capacity');
  });

  it('handles upstream_unavailable the same way', async () => {
    const err = await capture503(
      capacityError({ code: 'upstream_unavailable', body: { retry_after: 90 } }),
    );
    expect(err.name).toBe('ThrottledError');
    expect(JSON.parse(err.message).delay).toBe(90);
    expect(JSON.parse(err.message).message).toContain('providers');
  });

  it('defaults the wait when the body states none', async () => {
    const err = await capture503(capacityError({ body: {} }));
    expect(err.name).toBe('ThrottledError');
    expect(JSON.parse(err.message).delay).toBe(60);
  });

  it('clamps an implausibly long stated wait', async () => {
    const err = await capture503(capacityError({ body: { retry_after: 86400 } }));
    expect(JSON.parse(err.message).delay).toBe(3600);
  });

  it('floors malformed waits instead of hot-looping', async () => {
    for (const bad of [-5, 0, NaN, 'abc']) {
      const err = await capture503(capacityError({ body: { retry_after: bad } }));
      expect(err.name).toBe('ThrottledError');
      expect(JSON.parse(err.message).delay).toBe(60);
    }
  });

  it('leaves a plain 503 without a typed code on the hard-error path', async () => {
    // Regression pin: only the two typed codes throttle. An untyped 503 keeps
    // today's behaviour (rethrown unchanged, surfaces as a real failure).
    const err = await capture503(new LenzError({ message: 'Server error', statusCode: 503 }));
    expect(err.name).not.toBe('ThrottledError');
    expect(err.message).toContain('Server error');
  });
});

describe('rate limit (429) → ThrottledError', () => {
  it('hands Zapier the wait so it replays instead of burning the run', async () => {
    const err429 = new LenzRateLimitError({
      message: 'Daily /extract limit of 1000 reached.',
      statusCode: 429,
    });
    err429.retryAfter = 300;
    LenzClient.mockImplementation(() =>
      mockClient({ extract: jest.fn().mockRejectedValue(err429) }),
    );

    const err = await captureError(App.creates.extract_claims.operation.perform, {
      ...AUTH,
      inputData: { text: 'some text' },
    });

    expect(err.name).toBe('ThrottledError');
    // The delay ARGUMENT is the entire point of ThrottledError — asserting
    // only the interpolated message text passes even if it's never passed.
    // Core stores it as JSON.stringify({ message, delay }).
    expect(JSON.parse(err.message).delay).toBe(300);
  });

  it('clamps an implausibly long wait to something Zapier will schedule', async () => {
    const err429 = new LenzRateLimitError({ message: 'capped', statusCode: 429 });
    err429.retryAfter = 86400; // seconds-until-UTC-midnight from the /extract cap
    LenzClient.mockImplementation(() =>
      mockClient({ extract: jest.fn().mockRejectedValue(err429) }),
    );

    const err = await captureError(App.creates.extract_claims.operation.perform, {
      ...AUTH,
      inputData: { text: 'some text' },
    });

    expect(err.name).toBe('ThrottledError');
    expect(JSON.parse(err.message).delay).toBe(3600);
  });

  it('floors a malformed wait instead of hot-looping', async () => {
    // A negative retryAfter is truthy, so `|| DEFAULT` does not catch it. Left
    // unhandled it clamps to a 1-second replay — a hot retry loop against a
    // server that just throttled us.
    for (const bad of [-5, 0, NaN, undefined, 'abc']) {
      const err429 = new LenzRateLimitError({ message: 'slow', statusCode: 429 });
      err429.retryAfter = bad;
      LenzClient.mockImplementation(() =>
        mockClient({ extract: jest.fn().mockRejectedValue(err429) }),
      );

      const err = await captureError(App.creates.extract_claims.operation.perform, {
        ...AUTH,
        inputData: { text: 'x' },
      });

      expect(err.name).toBe('ThrottledError');
      expect(JSON.parse(err.message).delay).toBe(60);
    }
  });

  it('hands the platform whole seconds', async () => {
    const err429 = new LenzRateLimitError({ message: 'slow', statusCode: 429 });
    err429.retryAfter = 1.5;
    LenzClient.mockImplementation(() =>
      mockClient({ extract: jest.fn().mockRejectedValue(err429) }),
    );

    const err = await captureError(App.creates.extract_claims.operation.perform, {
      ...AUTH,
      inputData: { text: 'x' },
    });

    expect(Number.isInteger(JSON.parse(err.message).delay)).toBe(true);
  });
});

describe('quota fallbacks when the server omits fields', () => {
  it('falls back to the plans page when upgrade_url is absent', async () => {
    // Older SDKs don't populate upgradeUrl at all, so the fallback is the live
    // path until 2.7.0 is installed everywhere.
    const bare = new LenzQuotaExceededError({
      message: 'No remaining claim checks.',
      statusCode: 402,
    });
    LenzClient.mockImplementation(() =>
      mockClient({ assess: jest.fn().mockRejectedValue(bare) }),
    );

    const err = await captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { text: 'x' },
    });

    expect(err.name).toBe('HaltedError');
    expect(err.message).toContain('https://lenz.io/plans');
    // No reset clause when the server didn't state one.
    expect(err.message).not.toContain('Quota resets');
  });
});

describe('editor-test path (isLoadingSample)', () => {
  it('maps a rejected key on the Test click, not just on a live run', async () => {
    // verify_claim probes /me/usage while the user is building the Zap. That
    // is the FIRST place a revoked key surfaces, so it must produce the same
    // ExpiredAuthError a live run would.
    const err401 = new LenzAuthError({ message: 'Unauthorized', statusCode: 401 });
    LenzClient.mockImplementation(() =>
      mockClient({ usage: jest.fn().mockRejectedValue(err401) }),
    );

    const err = await captureError(App.creates.verify_claim.operation.perform, {
      ...AUTH,
      inputData: { claim: 'x' },
      meta: { isLoadingSample: true },
    });

    expect(err.name).toBe('ExpiredAuthError');
  });
});

describe('bad key (401) → ExpiredAuthError', () => {
  it('prompts a reconnect rather than leaving the user to decode a 401', async () => {
    const err401 = new LenzAuthError({ message: 'Unauthorized', statusCode: 401 });
    LenzClient.mockImplementation(() =>
      mockClient({ assess: jest.fn().mockRejectedValue(err401) }),
    );

    const err = await captureError(App.creates.assess.operation.perform, {
      ...AUTH,
      inputData: { text: 'x' },
    });

    expect(err.name).toBe('ExpiredAuthError');
  });
});

describe('non-quota 403 stays a hard error', () => {
  it('a private verification is a real failure, not a billing state', async () => {
    const err403 = new LenzError({ message: 'This report is private.', statusCode: 403 });
    LenzClient.mockImplementation(() =>
      mockClient({ ask: { send: jest.fn().mockRejectedValue(err403) } }),
    );

    const err = await captureError(App.creates.ask.operation.perform, {
      ...AUTH,
      inputData: { verificationId: 'ab12cd34', question: 'q' },
    });

    expect(err.name).not.toBe('HaltedError');
    expect(err.message).toContain('private');
  });
});
