/* globals describe, it, expect, jest */

// searched_pages: the pages the reviewers looked at, on each Assess row and on
// each Review a Draft issue. The API sends them on `/assess` rows and on a
// review claim's `assessment`; this app lists only the entries that pass one
// filter (lib/shapes.js searchedPages) and never invents the key for an API
// that does not send it.

const crypto = require('crypto');
const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');
const { searchedPages } = require('../lib/shapes');

const appTester = zapier.createAppTester(App);

const PAGE = { title: 'A page', url: 'https://example.org/a' };

describe('searchedPages filter', () => {
  it('keeps title and url only, in the order sent', () => {
    expect(
      searchedPages([
        { title: 'First', url: 'https://example.org/1', extra: 'dropped' },
        { title: 'Second', url: 'http://example.com/2?q=1#f' },
      ]),
    ).toEqual([
      { title: 'First', url: 'https://example.org/1' },
      { title: 'Second', url: 'http://example.com/2?q=1#f' },
    ]);
  });

  it('is an empty list for anything that is not a list', () => {
    for (const bad of [undefined, null, 'https://example.org', PAGE, 7, true]) {
      expect(searchedPages(bad)).toEqual([]);
    }
  });

  it('drops entries without a text title or a safe address', () => {
    const kept = searchedPages([
      { title: 'Kept', url: 'HTTPS://Example.org/x' },
      { title: '', url: 'https://example.org/empty' },
      { title: '   ', url: 'https://example.org/blank' },
      { title: 42, url: 'https://example.org/number' },
      { url: 'https://example.org/no-title' },
      { title: 'No url' },
      { title: 'Number url', url: 7 },
      { title: 'Script', url: 'javascript:alert(1)' },
      { title: 'Data', url: 'data:text/html,x' },
      { title: 'File', url: 'file:///etc/passwd' },
      { title: 'Ftp', url: 'ftp://example.org/x' },
      { title: 'Relative', url: '/path' },
      { title: 'Scheme only', url: 'https://' },
      { title: 'No host', url: 'https:///path' },
      { title: 'Credentials', url: 'https://user:pass@example.org/x' },
      { title: 'User only', url: 'https://user@example.org/x' },
      'https://example.org/string',
      null,
      7,
      [PAGE],
    ]);
    expect(kept).toEqual([{ title: 'Kept', url: 'HTTPS://Example.org/x' }]);
  });

  it('turns control characters in a title into spaces and caps it at 200 characters', () => {
    const [a, b] = searchedPages([
      { title: 'One\ntwo\ttab\u0000nul\u001b[0m', url: 'https://example.org/a' },
      { title: 'x'.repeat(250), url: 'https://example.org/b' },
    ]);
    expect(a.title).toBe('One two tab nul [0m');
    expect(b.title).toHaveLength(200);
  });

  it('drops an entry whose url holds a space, newline, tab or other control character', () => {
    expect(
      searchedPages([
        { title: 'Space', url: 'https://example.org/a b' },
        { title: 'Newline', url: 'https://example.org/a\nb' },
        { title: 'Tab', url: 'https://example.org/a\tb' },
        { title: 'Nul', url: 'https://example.org/a\u0000b' },
        { title: 'Trailing', url: 'https://example.org/a ' },
        { title: 'Line separator', url: 'https://example.org/a b' },
        { title: 'Kept', url: 'https://example.org/ab' },
      ]),
    ).toEqual([{ title: 'Kept', url: 'https://example.org/ab' }]);
  });

  it('drops a title that is only whitespace or control characters, and collapses runs inside one', () => {
    expect(
      searchedPages([
        { title: ' \n\t\u0000\u001b ', url: 'https://example.org/a' },
        { title: 'One \n\n two\t\tthree', url: 'https://example.org/b' },
        { title: `${'x'.repeat(199)} y`, url: 'https://example.org/c' },
      ]),
    ).toEqual([
      { title: 'One two three', url: 'https://example.org/b' },
      { title: 'x'.repeat(199), url: 'https://example.org/c' },
    ]);
  });

  it('leaves markup in a title as text', () => {
    expect(searchedPages([{ title: '<b onclick=x>t</b>', url: 'https://example.org/a' }])).toEqual([
      { title: '<b onclick=x>t</b>', url: 'https://example.org/a' },
    ]);
  });
});

describe('creates.assess searched_pages', () => {
  const assess = App.creates.assess.operation;
  const run = (row) => {
    LenzClient.mockImplementation(() => ({
      assess: jest.fn().mockResolvedValue({ claims: [{ claim: 'A', verdict: 'True', confidence: 'high', ...row }] }),
    }));
    return appTester(assess.perform, { authData: { access_token: 'lenz_good' }, inputData: { text: 'A' } }).then(
      (r) => r.claims[0],
    );
  };

  it('lists the pages on the row, filtered', async () => {
    const row = await run({ searched_pages: [PAGE, { title: 'Bad', url: 'javascript:alert(1)' }] });
    expect(row.searched_pages).toEqual([PAGE]);
  });

  it('is [] when the API sends none, or an API that predates the field', async () => {
    expect((await run({ searched_pages: [] })).searched_pages).toEqual([]);
    expect((await run({})).searched_pages).toEqual([]);
  });

  it('declares the field as a list of titles and links, and samples it', () => {
    const claims = assess.outputFields.find((f) => f.key === 'claims');
    const field = claims.children.find((f) => f.key === 'searched_pages');
    expect(field).toEqual({
      key: 'searched_pages',
      label: 'Pages the Reviewers Looked At',
      list: true,
      children: [
        { key: 'title', label: 'Title' },
        { key: 'url', label: 'URL' },
      ],
    });
    expect(Object.keys(assess.sample.claims[0].searched_pages[0]).sort()).toEqual(['title', 'url']);
  });
});

describe('creates.review_draft searched_pages', () => {
  const review = App.creates.review_draft.operation;
  const SECRET = 'whsec_test';
  const AUTH = { access_token: 'lat_good', webhook_secret: SECRET };

  const issue = (claimIndex) => ({
    claim_index: claimIndex,
    claim: `Claim ${claimIndex}`,
    verdict: 'False',
    confidence: 'high',
    source: 'assessment',
    verification_id: null,
    url: null,
    key_finding: null,
    rationale: 'Reviewers disagree.',
    suggested_rewrite: null,
    failure: null,
  });

  const claim = (index, pages) => ({ index, claim: `Claim ${index}`, assessment: { status: 'completed', searched_pages: pages } });

  const REVIEW = {
    review_id: 'rev12345',
    status: 'completed',
    outcome: 'issues_found',
    summary: { assessments: { completed: 3, failed: 0 }, verifications: { completed: 0 } },
    credits: { charged: 3 },
    issues: [issue(2), issue(0), issue(7)],
    failures: [],
    citation_issues: [],
    claims: [
      claim(0, [PAGE, { title: 'Bad', url: 'https://u:p@example.org' }]),
      claim(1, [{ title: 'Other', url: 'https://example.org/o' }]),
      claim(2, undefined),
    ],
  };

  const signed = (r) => {
    const content = JSON.stringify({
      event: 'review.completed',
      event_id: 'evt_1',
      review_id: r.review_id,
      status: 'completed',
      review: r,
      attempt: 1,
      delivered_at: new Date().toISOString(),
    });
    const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(content, 'utf-8')).digest('hex')}`;
    return { content, headers: { 'Http-Content-Type': 'application/json', 'Http-X-Lenz-Signature': sig } };
  };

  it('joins each issue to its claim by claim_index (signed callback)', async () => {
    LenzClient.mockImplementation(() => ({ getReview: jest.fn() }));
    const out = await appTester(review.performResume, {
      authData: AUTH,
      outputData: { review_id: 'rev12345' },
      rawRequest: signed(REVIEW),
    });
    // The issue order is the API's; each issue reads ITS claim's pages.
    expect(out.issues.map((i) => i.searched_pages)).toEqual([
      [], // claim 2: the claim carries no key
      [PAGE], // claim 0: the unsafe entry is filtered out
      [], // claim 7: no such claim
    ]);
  });

  it('joins on a review read by id too', async () => {
    LenzClient.mockImplementation(() => ({ getReview: jest.fn().mockResolvedValue(REVIEW) }));
    const out = await appTester(review.performResume, { authData: AUTH, outputData: { review_id: 'rev12345' } });
    expect(out.issues[1].searched_pages).toEqual([PAGE]);
  });

  it('is [] on every issue when the review has no claims list (an older API)', async () => {
    const old = { ...REVIEW, claims: undefined };
    LenzClient.mockImplementation(() => ({ getReview: jest.fn().mockResolvedValue(old) }));
    const out = await appTester(review.performResume, { authData: AUTH, outputData: { review_id: 'rev12345' } });
    expect(out.issues.map((i) => i.searched_pages)).toEqual([[], [], []]);
  });

  it('declares the field on Issues and samples it', () => {
    const issues = review.outputFields.find((f) => f.key === 'issues');
    const field = issues.children.find((f) => f.key === 'searched_pages');
    expect(field).toMatchObject({ label: 'Pages the Reviewers Looked At', list: true });
    expect(field.children.map((c) => c.key)).toEqual(['title', 'url']);
    expect(Object.keys(review.sample.issues[0].searched_pages[0]).sort()).toEqual(['title', 'url']);
  });
});
