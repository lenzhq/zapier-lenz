/* globals describe, it, expect, beforeEach, afterEach */

'use strict';

// The real lenz-io, never jest.mock'd: these pin what reaches the wire, which
// the mocked create tests cannot see. lenz-io 2.18 silently dropped
// `supplied_sources` from every JSON body while the mocked tests passed.

const zapier = require('zapier-platform-core');
const App = require('../index');
const { lenzClient } = require('../client');

const appTester = zapier.createAppTester(App);
const AUTH = { access_token: 'lat_test', webhook_secret: 'whsec_test' };

// How Zapier hands the Supplied Sources line-item field to perform.
const SOURCES = [
  { source_text: 'The 2024 report says revenue grew 12%.', source_url: 'https://example.com/report' },
];

let originalFetch;
let sent;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = {};
  globalThis.fetch = async (url, init = {}) => {
    const route = new URL(String(url)).pathname.replace('/api/v1/', '');
    if (typeof init.body === 'string') sent[route] = JSON.parse(init.body);
    const receipt = route.startsWith('verify')
      ? { task_id: 'task1234', status: 'queued' }
      : route.startsWith('citecheck')
        ? { citecheck_id: 'cc123456', status: 'queued' }
        : { review_id: 'rev12345', status: 'queued' };
    return new Response(JSON.stringify(receipt), {
      status: 202,
      headers: { 'content-type': 'application/json', 'x-lenz-api-version': '2026-10-11' },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Supplied Sources reach the Lenz API', () => {
  it.each([
    ['verify_claim', 'verify', { claim: 'Revenue grew 12% in 2024.' }],
    ['check_citations', 'citecheck', { text: 'Revenue grew 12% [1].\n\n[1] https://example.com/report' }],
    ['review_draft', 'review', { text: 'Revenue grew 12% in 2024.' }],
  ])('%s sends supplied_sources in the %s body', async (key, route, inputData) => {
    await appTester(App.creates[key].operation.perform, {
      authData: AUTH,
      inputData: { ...inputData, supplied_sources: SOURCES },
    });

    expect(sent[route]).toBeDefined();
    expect(sent[route].supplied_sources).toEqual([
      expect.objectContaining({
        text: 'The 2024 report says revenue grew 12%.',
        url: 'https://example.com/report',
      }),
    ]);
  });

  it('sends no supplied_sources when the field is left empty', async () => {
    await appTester(App.creates.verify_claim.operation.perform, {
      authData: AUTH,
      inputData: { claim: 'Revenue grew 12% in 2024.' },
    });
    expect(sent.verify).toBeDefined();
    expect(sent.verify).not.toHaveProperty('supplied_sources');
  });
});

describe('an input the SDK refuses before sending', () => {
  it.each([
    ['verify_claim', { claim: '   ' }],
    ['assess', { claim: '   ' }],
  ])('%s with a blank claim is a validation error, not a "could not reach Lenz" replay', async (key, inputData) => {
    // lenz-io 3.x refuses a blank claim itself, with statusCode 0. The app read
    // statusCode 0 as "no response" and replayed the run every 60s.
    const err = await appTester(App.creates[key].operation.perform, { authData: AUTH, inputData }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe('ThrottledError');
    expect(err.message).not.toMatch(/Could not reach Lenz/);
    expect(sent).toEqual({});
  });
});

describe('a job cancelled elsewhere ends the step', () => {
  // The 2026-10-11 shape names a live cancellation `status: "cancelled"`; a
  // stored one reads `failed` with a `cancelled` failure block. Either way the
  // step must end, with Status `failed` and Failure Class `cancelled`, never
  // "still running".
  const fs = require('fs');
  const path = require('path');
  const recorded = (name) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'canonical', `${name}.json`), 'utf8'));
  const CANCELLED = {
    code: 'cancelled',
    detail: 'The check was cancelled.',
    hint: null,
    failure_class: 'cancelled',
    retryable: false,
    docs_url: 'https://lenz.io/docs/errors#cancelled',
  };
  const serve = (body) => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-lenz-api-version': '2026-10-11' },
      });
  };
  // A resume with no signed body falls back to reading the job by id.
  const resume = (key, outputData) =>
    appTester(App.creates[key].operation.performResume, { authData: AUTH, outputData, cleanedRequest: {} });

  it('Verify a Claim: a live cancelled status reads exactly like the stored cancellation', async () => {
    const stored = recorded('verify__status_cancelled_durable');
    serve(stored);
    const fromStored = await resume('verify_claim', { task_id: stored.task_id });
    serve({ ...stored, status: 'cancelled' });
    const fromLive = await resume('verify_claim', { task_id: stored.task_id });

    expect(fromLive).toEqual(fromStored);
    expect(fromLive).toMatchObject({ status: 'failed', failure_class: 'cancelled', retryable: false });
  });

  it.each([
    ['review_draft', 'review__get_failed_no_claim_untraced', 'review_id'],
    ['check_citations', 'citecheck__get_failed_no_citations', 'citecheck_id'],
  ])('%s: a cancelled job reads as failed with Failure Class cancelled', async (key, fixture, idKey) => {
    const body = { ...recorded(fixture), status: 'cancelled', failure: CANCELLED };
    serve(body);
    const out = await resume(key, { [idKey]: body[idKey] });

    expect(out).toMatchObject({
      status: 'failed',
      error: 'The check was cancelled.',
      failure_reason: 'cancelled',
      failure_class: 'cancelled',
      retryable: false,
      message: '',
    });
  });
});

describe('the file calls', () => {
  it('a real client uses the app’s own extractFile and reviewFile, not the SDK’s', () => {
    // lenz-io 3.6 has native ones on the prototype, with another signature
    // ((file, options), where the actions pass ({ file, filename, ... }, options)).
    const client = lenzClient({ authData: AUTH });
    expect(Object.prototype.hasOwnProperty.call(client, 'extractFile')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(client, 'reviewFile')).toBe(true);
  });

  it('a file upload through the real client posts multipart to /extract/file with the file name', async () => {
    let form;
    let route;
    globalThis.fetch = async (url, init = {}) => {
      route = new URL(String(url)).pathname;
      form = init.body;
      return new Response(JSON.stringify({ status: 'ready', claims: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-lenz-api-version': '2026-10-11' },
      });
    };
    const client = lenzClient({ authData: AUTH });
    await client.extractFile(
      { file: Buffer.from('%PDF-1.4 x'), filename: 'report.pdf', contentType: 'application/pdf' },
      { timeoutMs: 5000 },
    );
    expect(route).toBe('/api/v1/extract/file');
    expect(form.get('file').name).toBe('report.pdf');
    expect(form.get('file').type).toBe('application/pdf');
  });
});
