/* globals beforeEach, afterAll, jest */

// zapier-platform-core ends the PROCESS (process.exit(1)) once it has made 250
// runs in it AND its memory passes 450 MB (tools/memory-checker.js): a guard
// for long-lived production workers. Jest reuses one worker process for
// several test files, so the run count carries over between files, and which
// file lands where depends on how Jest balances them. Adding unrelated tests
// once moved test/outputs.test.js in behind test/api_version.test.js (~300
// runs) and the whole suite died mid-file. The guard is shown a small figure
// in every test file.
//
// Before EACH test, not once per file: a file that calls
// jest.restoreAllMocks() (test/upload.test.js) would otherwise lift it for the
// rest of that file.
const realMemoryUsage = process.memoryUsage.bind(process);

beforeEach(() => {
  if (!jest.isMockFunction(process.memoryUsage)) {
    jest.spyOn(process, 'memoryUsage').mockImplementation(() => ({ ...realMemoryUsage(), rss: 1 }));
  }
});

afterAll(() => {
  if (jest.isMockFunction(process.memoryUsage)) process.memoryUsage.mockRestore();
});
