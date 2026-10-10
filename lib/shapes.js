'use strict';

// Readers for the Lenz API response shape this app asks for (client.js
// API_VERSION, `2026-10-11`). Every action reads the API's body here or beside
// the read, and builds its output from it.
//
// What an action OUTPUTS keeps the vocabulary it has always had. A saved Zap
// maps and filters on those keys and values, so the output says `no_claim`,
// `not_a_claim` and `Error` wherever the API says something else.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const text = (v) => (typeof v === 'string' ? v : '');

// The code the API uses for "nothing here can be checked".
const NO_CHECKABLE_CLAIM = 'no_checkable_claim';

// A failure code as the output has always spelled it. "Nothing checkable" is
// `not_a_claim` on a verification and an extraction and `no_claim` on an
// assessment and a review; `family` names which word this output uses. Every
// other code passes through.
const outputCode = (code, family) => (code === NO_CHECKABLE_CLAIM ? family : text(code));

// A failure block, `{ code, detail, hint, failure_class, retryable }`, as the
// pieces the actions read. `detail` is the sentence; `code` is the machine
// word, in the API's own spelling. No block, or absent parts, read as '' (and
// `retryable` as null).
const readFailure = (block) => {
  const b = isObject(block) ? block : {};
  const source = isObject(b.failure) ? b.failure : b;
  return {
    code: text(source.code),
    detail: text(source.detail),
    hint: text(source.hint),
    failureClass: text(source.failure_class),
    retryable: typeof source.retryable === 'boolean' ? source.retryable : null,
  };
};

// `passed` for a verdict label: a boolean only for a real verdict. True and
// Mostly True pass; Mixed, Mostly False and False do not. Anything else is
// empty (null): an Error row, a row with no verdict, a label this app does not
// know, and 'No Public Record' (Lenz found no public record of the claim,
// which does not make it false). The README has always said so; a Zap that
// branches on "Passed is false" must not fire for a claim that was never
// checked.
const VERDICT_PASSED = {
  True: true,
  'Mostly True': true,
  Mixed: false,
  'Mostly False': false,
  False: false,
};

const passedFrom = (verdict) =>
  typeof verdict === 'string' && Object.prototype.hasOwnProperty.call(VERDICT_PASSED, verdict)
    ? VERDICT_PASSED[verdict]
    : null;

// `modified_at` for a verification-shaped item, from its `completed_at`: null
// unless the completion falls on a later UTC calendar day than creation, which
// is the rule this output's `modified_at` has always followed. Read as
// instants, so an offset other than UTC still lands on its UTC day.
const utcDay = (iso) => {
  if (typeof iso !== 'string' || !iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
};

const modifiedAtFrom = (item) => {
  const completed = item.completed_at;
  const done = utcDay(completed);
  const made = utcDay(item.created_at);
  return done && made && done > made ? completed : null;
};

// The wording this output has always had for two values the API carries
// differently, so an output keeps the text it has always had:
// - the sentence of an Assess answer that found no claim at all;
// - the hint on an Assess row whose input held more claims than the one
//   assessed (the API lists them in `more_claims` with no hint).
const ASSESS_NO_CLAIM_MESSAGE = 'No verifiable claim detected';
const ASSESS_COMPOUND_HINT =
  'Assessed the main claim only. Send identified_claims as their own items to check the rest.';

// The pages the reviewers looked at (`searched_pages`), as a list of
// `{ title, url }`. An entry is kept only when its title is a non-empty string
// and its url is a string that starts with http:// or https:// (any case), has
// a host, carries no credentials and holds no whitespace or control character.
// Control characters in a title become spaces, runs of whitespace collapse to
// one space and a title is cut at 200 characters. Anything else is dropped, and
// a value that is not a list is no list: an API that does not send the key
// gives []. They are pages to look at, not checked sources.
const MAX_PAGE_TITLE_CHARS = 200;
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_URL = /[\s\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const SPACE_RUNS = /[\s\u0000-\u001f\u007f-\u009f]+/g;
const tidyTitle = (text) => text.replace(SPACE_RUNS, ' ').trim();
const searchedPages = (value) => {
  if (!Array.isArray(value)) return [];
  const pages = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.title !== 'string' || typeof entry.url !== 'string') continue;
    if (UNSAFE_IN_URL.test(entry.url)) continue;
    if (!/^https?:\/\/[^/?#]/i.test(entry.url)) continue;
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch (err) {
      continue;
    }
    if (!parsed.hostname || parsed.username || parsed.password) continue;
    const title = tidyTitle(tidyTitle(entry.title).slice(0, MAX_PAGE_TITLE_CHARS));
    if (!title) continue;
    pages.push({ title, url: entry.url });
  }
  return pages;
};

// Line-item input field for supplied source documents (e.g. paywalled or private text).
const suppliedSourcesField = () => ({
  key: 'supplied_sources',
  label: 'Supplied Sources',
  children: [
    {
      key: 'source_text',
      label: 'Source Text',
      type: 'text',
      helpText: 'Full text or excerpt of a paywalled or private source document.',
    },
    {
      key: 'source_url',
      label: 'Source URL',
      type: 'string',
      helpText: 'Optional HTTP(S) URL of the source.',
    },
    {
      key: 'source_doi',
      label: 'Source DOI',
      type: 'string',
      helpText: 'Optional DOI of the source (e.g. 10.1038/nature12373).',
    },
    {
      key: 'source_cite',
      label: 'Source Citation',
      type: 'string',
      helpText: 'Optional structured legal or academic citation.',
    },
    {
      key: 'source_title',
      label: 'Source Title',
      type: 'string',
      helpText: 'Optional title of the source document.',
    },
    {
      key: 'source_published_date',
      label: 'Source Published Date',
      type: 'string',
      helpText: 'Optional publication date (YYYY-MM-DD).',
    },
  ],
});

// Normalizes input rows into API-ready supplied source objects.
const mapSuppliedSources = (rows) => {
  if (!Array.isArray(rows)) return [];
  const sources = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    const rawText =
      typeof row.source_text === 'string'
        ? row.source_text
        : typeof row.text === 'string'
          ? row.text
          : '';
    if (!rawText.trim()) continue;
    const item = { text: rawText.trim() };
    const rawUrl =
      typeof row.source_url === 'string'
        ? row.source_url
        : typeof row.url === 'string'
          ? row.url
          : '';
    if (rawUrl.trim()) item.url = rawUrl.trim();
    const rawDoi =
      typeof row.source_doi === 'string'
        ? row.source_doi
        : typeof row.doi === 'string'
          ? row.doi
          : '';
    if (rawDoi.trim()) item.doi = rawDoi.trim();
    const rawCite =
      typeof row.source_cite === 'string'
        ? row.source_cite
        : typeof row.cite === 'string'
          ? row.cite
          : '';
    if (rawCite.trim()) item.cite = rawCite.trim();
    const rawTitle =
      typeof row.source_title === 'string'
        ? row.source_title
        : typeof row.title === 'string'
          ? row.title
          : '';
    if (rawTitle.trim()) item.title = rawTitle.trim();
    const rawDate =
      typeof row.source_published_date === 'string'
        ? row.source_published_date
        : typeof row.published_date === 'string'
          ? row.published_date
          : '';
    if (rawDate.trim()) item.published_date = rawDate.trim();
    sources.push(item);
  }
  return sources;
};

module.exports = {
  isObject,
  searchedPages,
  NO_CHECKABLE_CLAIM,
  outputCode,
  readFailure,
  passedFrom,
  modifiedAtFrom,
  ASSESS_NO_CLAIM_MESSAGE,
  ASSESS_COMPOUND_HINT,
  suppliedSourcesField,
  mapSuppliedSources,
};
