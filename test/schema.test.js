/* globals describe, it, expect */

const App = require('../index');

// `zapier validate` is the only thing that catches an illegal property on a
// field definition, it runs on Linux via Docker, and `zapier push` refuses the
// upload when it fails — so a bad definition is invisible to `npm test`, passes
// review of the diff, and only surfaces at the moment someone tries to ship.
// 1.2.2 shipped four output fields carrying `helpText` and was blocked at the
// push for exactly this. These ratchets put that failure in the local suite.
const operations = [
  ...Object.entries(App.creates || {}).map(([k, v]) => [`creates.${k}`, v.operation]),
  ...Object.entries(App.triggers || {}).map(([k, v]) => [`triggers.${k}`, v.operation]),
  ...Object.entries(App.searches || {}).map(([k, v]) => [`searches.${k}`, v.operation]),
].filter(([, op]) => op && Array.isArray(op.outputFields));

describe('output field definitions stay schema-legal', () => {
  it('covers every operation that declares outputFields', () => {
    expect(operations.length).toBeGreaterThan(0);
  });

  // PlainOutputFieldSchema's allow-list. `helpText`, `required`, `placeholder`,
  // `altersDynamicFields` and friends are INPUT-field properties; an output
  // field carrying one is rejected outright, not ignored.
  const ALLOWED = new Set(['key', 'label', 'type', 'list', 'dict', 'primary', 'children']);

  it.each(operations)('%s declares no illegal output-field property', (_name, operation) => {
    for (const field of operation.outputFields) {
      // A function is a dynamic-outputFields callback, not a plain field.
      if (typeof field === 'function') continue;
      const illegal = Object.keys(field).filter((k) => !ALLOWED.has(k));
      expect({ key: field.key, illegal }).toEqual({ key: field.key, illegal: [] });
    }
  });
});

// A key in `outputFields` but absent from `sample` is the missing-vs-empty
// trap. `outputFields` is what makes a field offerable in the editor at all,
// while the Filter step the user then builds is populated from `sample` — and
// Zapier treats "does not exist" and "is empty" as different conditions. So a
// declared-but-unsampled field yields a filter that tests clean in the editor
// and behaves differently on a live run.
//
// creates.assess declared `message` and sampled only `status` and `claims`,
// which is how this got noticed. creates/verify_claim.js had already hit it
// and documents the guard as NO_FAILURE; assess now uses NO_ERROR the same
// way. This ratchet applies the rule to every operation instead of leaving it
// to whoever remembers.
describe('every declared output field is present in the sample', () => {
  const sampled = operations.filter(([, op]) => op.sample && typeof op.sample === 'object');

  it('covers every operation that declares a sample', () => {
    expect(sampled.length).toBeGreaterThan(0);
  });

  it.each(sampled)('%s samples every field it declares', (_name, operation) => {
    const declared = operation.outputFields
      .filter((field) => typeof field !== 'function')
      .map((field) => field.key)
      .filter(Boolean);
    const missing = declared.filter((key) => !(key in operation.sample));
    expect(missing).toEqual([]);
  });
});
