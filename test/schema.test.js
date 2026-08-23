/* globals describe, it, expect */

const App = require('../index');

// `zapier validate` is the only thing that catches an illegal property on a
// field definition, it runs on Linux via Docker, and `zapier push` refuses the
// upload when it fails — so a bad definition is invisible to `npm test`, passes
// review of the diff, and only surfaces at the moment someone tries to ship.
// 1.2.2 shipped four output fields carrying `helpText` and was blocked at the
// push for exactly this. These ratchets put that failure in the local suite.
describe('output field definitions stay schema-legal', () => {
  const operations = [
    ...Object.entries(App.creates || {}).map(([k, v]) => [`creates.${k}`, v.operation]),
    ...Object.entries(App.triggers || {}).map(([k, v]) => [`triggers.${k}`, v.operation]),
    ...Object.entries(App.searches || {}).map(([k, v]) => [`searches.${k}`, v.operation]),
  ].filter(([, op]) => op && Array.isArray(op.outputFields));

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
