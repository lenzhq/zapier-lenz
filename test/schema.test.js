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


// Static dropdown choices are the same class of trap as the output-field
// allow-list above: `FieldChoiceWithLabelSchema` requires `value`, `sample`
// AND `label`, and says `sample` "should match the value". `sample` is a
// legacy key the editor no longer reads, so it looks redundant and reads like
// a copy-paste artefact — but dropping it fails `zapier validate`, which CI
// does not run (the workflow runs `npm test` only). Without this, a removed
// `sample` passes CI and every review, and only surfaces at the push.
//
// The Depth and Visibility choices added in 1.4.0 are the first static choices
// in this app; this ratchet covers whatever comes next too.
describe('static dropdown choices stay schema-legal', () => {
  const inputOperations = [
    ...Object.entries(App.creates || {}).map(([k, v]) => [`creates.${k}`, v.operation]),
    ...Object.entries(App.triggers || {}).map(([k, v]) => [`triggers.${k}`, v.operation]),
    ...Object.entries(App.searches || {}).map(([k, v]) => [`searches.${k}`, v.operation]),
  ].filter(([, op]) => op && Array.isArray(op.inputFields));

  const withChoices = inputOperations.flatMap(([name, op]) =>
    op.inputFields
      .filter((f) => typeof f !== 'function' && Array.isArray(f.choices))
      .map((f) => [`${name}.${f.key}`, f]),
  );

  it('finds the static choices this app declares', () => {
    expect(withChoices.length).toBeGreaterThan(0);
  });

  it.each(withChoices)('%s gives every choice value, sample and label', (_name, field) => {
    for (const choice of field.choices) {
      // The string shorthand is legal too, and carries no keys to get wrong.
      if (typeof choice === 'string') continue;
      expect(Object.keys(choice).sort()).toEqual(['label', 'sample', 'value']);
      expect(choice.sample).toBe(choice.value);
      expect(choice.label.length).toBeGreaterThan(0);
    }
  });
});


// The list-children counterpart to the parity ratchet above. Declaring a list
// field is not enough to make its per-item values mappable in the editor —
// each child has to be declared too. creates/assess.js declared `claims` not
// at all while returning five values per claim, so the verdicts themselves
// were undiscoverable (#22).
//
// Only lists with a NON-EMPTY sample array can be checked: an empty sample
// list has no entry to compare against. creates/verify_claim.js samples its
// three needs_input lists as `[]` (they are populated only on that branch), so
// they are skipped here and rely on the shapeNeedsInput tests instead.
describe('list output fields declare the children their sample carries', () => {
  const listFields = operations.flatMap(([name, op]) =>
    (op.sample && typeof op.sample === 'object' ? op.outputFields : [])
      .filter((f) => typeof f !== 'function' && f.list && Array.isArray(f.children))
      .map((f) => [`${name}.${f.key}`, f, op.sample[f.key]])
      .filter(([, , sampleValue]) => Array.isArray(sampleValue) && sampleValue.length > 0),
  );

  it('finds at least one sampled list to check', () => {
    expect(listFields.length).toBeGreaterThan(0);
  });

  it.each(listFields)('%s declares every key its sample entry carries', (_name, field, sampleValue) => {
    const declared = field.children.map((c) => c.key);
    const undeclared = Object.keys(sampleValue[0]).filter((k) => !declared.includes(k));
    expect(undeclared).toEqual([]);
  });

  it.each(listFields)('%s samples every child it declares', (_name, field, sampleValue) => {
    const missing = field.children.map((c) => c.key).filter((k) => !(k in sampleValue[0]));
    expect(missing).toEqual([]);
  });
});
