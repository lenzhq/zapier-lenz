const authentication = require('./authentication');

const newVerification = require('./triggers/new_verification');
const verifyClaim = require('./creates/verify_claim');
const assess = require('./creates/assess');
const extractClaims = require('./creates/extract_claims');
const ask = require('./creates/ask');

module.exports = {
  // This is just shorthand to reference the installed dependencies you have.
  // Zapier will need to know these before we can upload.
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,

  authentication,

  // All Lenz calls go through the lenz-io SDK, which manages its own
  // Authorization header — no z.request-based before/after middleware needed.
  beforeRequest: [],
  afterResponse: [],

  // Opt out of Zapier's automatic input-data cleaning (trimming empty
  // strings/nulls/etc.) globally, rather than leaving it implicit per D028.
  flags: {
    cleanInputData: false,
  },

  triggers: {
    [newVerification.key]: newVerification,
  },

  searches: {},

  creates: {
    [verifyClaim.key]: verifyClaim,
    [assess.key]: assess,
    [extractClaims.key]: extractClaims,
    [ask.key]: ask,
  },

  resources: {},
};
