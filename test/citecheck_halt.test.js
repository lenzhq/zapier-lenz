/* globals describe, it, expect, jest */

// Check Citations on a balance that runs out AFTER the check was accepted.
//
// The API takes the check when the account can afford one citation, counts the
// citations, and then fails the job `insufficient_credits` ("This check needs 3
// credits, one per citation it checks. Nothing was charged."). A balance of
// zero is refused at submit (402) and halts the Zap; this is the same state one
// step later, so it halts the Zap too, from the signed callback and from a read
// by id alike. Every other failed job is still returned as data.
//
// The fixtures are the two shapes of the API's own bodies (test/fixtures/
// short_balance, built from the recorded failed-check bodies and the server's
// wording in lenz/review/citations.py and lenz/api/failure_block.py).

const fs = require('fs');
const path = require('path');
const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');
const { signed, loadFixture, AUTH } = require('./helpers/oracle');

const appTester = zapier.createAppTester(App);
const resume = App.creates.check_citations.operation.performResume;

const short = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'short_balance', `${name}.json`), 'utf-8'));

const mockClient = (over = {}) => {
  const client = { getCitecheck: jest.fn(), ...over };
  LenzClient.mockImplementation(() => client);
  return client;
};

const capture = (fn, bundle) =>
  appTester(fn, bundle).then(
    () => null,
    (e) => e,
  );

describe.each(['legacy', 'canonical'])('a short balance, %s shape', (shape) => {
  const hook = () => short(`${shape}__webhook_citecheck_failed_insufficient_credits`);
  const get = () => short(`${shape}__get_failed_insufficient_credits`);

  it('halts from the signed callback, with the API\'s own sentence and where to add credits', async () => {
    mockClient();
    const body = hook();
    const err = await capture(resume, {
      authData: AUTH,
      outputData: { citecheck_id: body.citecheck_id },
      rawRequest: signed(body),
    });
    expect(err).toBeTruthy();
    expect(err.name).toBe('HaltedError');
    expect(err.message).toContain('This check needs 3 credits, one per citation it checks.');
    expect(err.message).toContain('https://lenz.io/plans');
    expect(err.message).toContain('will not retry on its own');
    expect(err.message).toContain(body.citecheck_id);
  });

  it('halts the same way when the check is read by id', async () => {
    const check = get();
    const client = mockClient({ getCitecheck: jest.fn().mockResolvedValue(check) });
    const err = await capture(resume, { authData: AUTH, outputData: { citecheck_id: check.citecheck_id } });
    expect(client.getCitecheck).toHaveBeenCalled();
    expect(err.name).toBe('HaltedError');
    expect(err.message).toContain('This check needs 3 credits');
    expect(err.message).toContain('https://lenz.io/plans');
  });

  it('keeps the server\'s sentence out of the message when it has none, and still halts', async () => {
    const check = get();
    delete check.failure.hint;
    delete check.failure.detail;
    mockClient({ getCitecheck: jest.fn().mockResolvedValue(check) });
    const err = await capture(resume, { authData: AUTH, outputData: { citecheck_id: check.citecheck_id } });
    expect(err.name).toBe('HaltedError');
    expect(err.message).toMatch(/balance ran out/i);
    expect(err.message).not.toMatch(/\d+ credits/);
  });

  it.each(['citecheck__get_failed_no_citations', 'citecheck__get_failed_upstream_unavailable'])(
    'still returns %s as data, as it always has',
    async (name) => {
      const check = loadFixture(shape, name);
      mockClient({ getCitecheck: jest.fn().mockResolvedValue(check) });
      const out = await appTester(resume, { authData: AUTH, outputData: { citecheck_id: check.citecheck_id } });
      expect(out.status).toBe('failed');
      expect(out.failure_reason).not.toBe('insufficient_credits');
    },
  );

  it.each(['completed', 'checking'])(
    'never halts a check whose status is %s, even if a stale failure block is on it',
    async (status) => {
      // Both routes: the status guard is what keeps a stale block from halting.
      const stale = { ...get(), status };
      mockClient({ getCitecheck: jest.fn().mockResolvedValue(stale) });
      const byId = await appTester(resume, { authData: AUTH, outputData: { citecheck_id: stale.citecheck_id } });
      expect(byId.status).toBe(status);

      mockClient();
      const body = hook();
      body.citecheck = { ...body.citecheck, status };
      body.event = 'citecheck.completed';
      body.status = status;
      const viaHook = await appTester(resume, {
        authData: AUTH,
        outputData: { citecheck_id: body.citecheck_id },
        rawRequest: signed(body),
      });
      expect(viaHook.status).toBe(status);
    },
  );

  it('uses the API\'s detail when it sends no hint', async () => {
    const check = get();
    delete check.failure.hint;
    check.failure.detail = 'The account did not have enough credits for this work.';
    check.failure.failure_reason = 'insufficient_credits';
    mockClient({ getCitecheck: jest.fn().mockResolvedValue(check) });
    const err = await capture(resume, { authData: AUTH, outputData: { citecheck_id: check.citecheck_id } });
    expect(err.name).toBe('HaltedError');
    expect(err.message).toContain('The account did not have enough credits for this work.');
  });

  it('does not touch a completed check', async () => {
    const check = loadFixture(shape, 'citecheck__get_completed_clean');
    mockClient({ getCitecheck: jest.fn().mockResolvedValue(check) });
    const out = await appTester(resume, { authData: AUTH, outputData: { citecheck_id: check.citecheck_id } });
    expect(out.status).toBe('completed');
  });
});
