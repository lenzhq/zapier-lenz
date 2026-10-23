/* globals describe, it, expect */

// scripts/announce-release.sh: the one-line note posted to #key-system-events
// when a version is promoted. Only the dry run and the refusals are run here;
// nothing is ever sent from a test.

const { spawnSync } = require('child_process');
const path = require('path');

const script = path.join(__dirname, '..', 'scripts', 'announce-release.sh');
const run = (args, env = {}) =>
  spawnSync('bash', [script, ...args], { encoding: 'utf-8', env: { PATH: process.env.PATH, ...env } });

describe('scripts/announce-release.sh', () => {
  it('words the note like the SDK release notes, with the version and the app link', () => {
    const out = run(['2.3.1'], { ANNOUNCE_DRY_RUN: '1' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(
      '🟢 `zapier-lenz 2.3.1` promoted on Zapier — https://zapier.com/apps/lenz/integrations',
    );
  });

  it('refuses anything that is not major.minor.patch, even in a dry run', () => {
    for (const bad of ['', '2.3', 'v2.3.1', '2.3.1-beta', '2.3.1"}; rm -rf /', '$(id)']) {
      const out = run(bad === '' ? [] : [bad], { ANNOUNCE_DRY_RUN: '1' });
      expect(out.status).toBe(2);
      expect(out.stdout).toBe('');
    }
  });

  it('says so and sends nothing when no webhook is set', () => {
    const out = run(['2.3.1']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('No KEY_SYSTEM_EVENTS_WEBHOOK_URL set; skipping.');
  });
});
