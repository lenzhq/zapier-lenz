'use strict';

// The languages the Lenz API can return results in, and the ONLY values it
// accepts on `language`. Anything else is a 422 — `validate_language` in
// lenz/languages.py raises, and every endpoint that reads the field turns
// that into `JsonResponse(..., status=422)` before doing any work.
//
// A 422 maps to a plain `z.errors.Error` (lib/errors.js), which counts toward
// the error rate that turns a Zap off. So a user who typed `English`, `en-US`
// or `pl` into this free-text field failed EVERY run, with nothing in the
// editor to suggest why. That is what these choices fix: the editor can only
// offer values the server accepts.
//
// Order and spelling are copied from SUPPORTED_LANGUAGES in
// lenz/languages.py, which is that module's stated source of truth — `en`
// first, the rest in roughly descending expected API demand. Keep it in sync
// with the server rather than alphabetising it.
//
// `sample` duplicates `value` on every entry because
// FieldChoiceWithLabelSchema requires it and says it "should match the
// value"; the editor no longer reads it, but omitting it fails
// `zapier validate`. test/schema.test.js ratchets that for every static
// choice list in the app.
const SUPPORTED_LANGUAGES = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['de', 'German'],
  ['fr', 'French'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
  ['fi', 'Finnish'],
  ['bg', 'Bulgarian'],
];

const LANGUAGE_CHOICES = SUPPORTED_LANGUAGES.map(([value, label]) => ({
  value,
  sample: value,
  label,
}));

// The field is deliberately NOT required and carries no default, on all four
// actions: blank is meaningful and the two meanings differ. On verify, assess
// and extract a blank field is omitted from the request and the server
// applies English. On ask it means "answer in the language the claim is
// stored in" (lenz/api/public_authed.py:2996), which is why `ask` passes its
// own help text rather than sharing the one below.
// "the input language is irrelevant" is the server's own stated contract, not
// a guess: lenz/languages.py, principle 1 — "We never detect, validate, or
// warn about the input language." Worth saying, because the obvious reading
// of a Language field on a text-processing step is that it describes the
// INPUT, and picking it on that basis silently changes the output language.
const LANGUAGE_HELP_TEXT =
  'The language Lenz answers in. Leave blank for English. This does not describe your input — the input language is irrelevant, and this field only sets the language of the response.';

// One builder so the four actions cannot drift apart. `helpText` is the only
// thing that legitimately differs between them.
const languageField = (helpText) => ({
  key: 'language',
  label: 'Language',
  type: 'string',
  required: false,
  choices: LANGUAGE_CHOICES,
  helpText: helpText || LANGUAGE_HELP_TEXT,
});

module.exports = { LANGUAGE_CHOICES, LANGUAGE_HELP_TEXT, SUPPORTED_LANGUAGES, languageField };
