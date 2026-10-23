/* globals describe, it, expect, beforeAll, afterAll */

// scripts/announce-release.sh: the one-line note posted to #key-system-events
// when a version is promoted. Nothing is ever sent from a test: the dry run
// prints, and the real path runs against a fake `curl` that records what it was
// given.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { version: VERSION } = require('../package.json');

const script = path.join(__dirname, '..', 'scripts', 'announce-release.sh');
const NOTE = (v) => `🟢 \`zapier-lenz ${v}\` promoted on Zapier — https://zapier.com/apps/lenz/integrations`;
const WEBHOOK = 'https://discord.com/api/webhooks/1234567890/abc_DEF-ghi.123';

let bin;
let log;

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-curl-'));
  log = path.join(bin, 'curl.log');
  // Records its arguments and stdin; exits with FAKE_CURL_EXIT (default 0).
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}.args"\ncat > "${log}.stdin"\nexit \${FAKE_CURL_EXIT:-0}\n`,
    { mode: 0o755 },
  );
});

afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

const run = (args, env = {}) =>
  spawnSync('bash', [script, ...args], {
    encoding: 'utf-8',
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
  });
const sent = () => fs.existsSync(`${log}.args`);
const clean = () => ['.args', '.stdin'].forEach((s) => fs.rmSync(`${log}${s}`, { force: true }));

describe('scripts/announce-release.sh', () => {
  it('words the note like the SDK release notes, with the version and the app link', () => {
    clean();
    const out = run([VERSION], { ANNOUNCE_DRY_RUN: '1' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(NOTE(VERSION));
    expect(sent()).toBe(false);
  });

  it('refuses anything that is not major.minor.patch, even in a dry run', () => {
    for (const bad of ['', '2.3', 'v2.3.1', '2.3.1-beta', '2.3.1"}; rm -rf /', '$(id)', '2.3.1\n']) {
      const out = run(bad === '' ? [] : [bad], { ANNOUNCE_DRY_RUN: '1', ANNOUNCE_FORCE: '1' });
      expect(out.status).toBe(2);
      expect(out.stdout).toBe('');
    }
  });

  it('refuses a version that is not the one in package.json, unless forced', () => {
    const out = run(['9.9.9'], { ANNOUNCE_DRY_RUN: '1' });
    expect(out.status).toBe(3);
    expect(out.stderr).toContain(`package.json says ${VERSION}`);
    expect(run(['9.9.9'], { ANNOUNCE_DRY_RUN: '1', ANNOUNCE_FORCE: '1' }).status).toBe(0);
  });

  it('says so and sends nothing when no webhook is set', () => {
    clean();
    const out = run([VERSION]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('No KEY_SYSTEM_EVENTS_WEBHOOK_URL set; skipping.');
    expect(sent()).toBe(false);
  });

  it.each(['--version', 'https://example.com/hook', `${WEBHOOK}"; x`, 'https://discord.com/api/webhooks/1/{a,b}', 'http://discord.com/api/webhooks/1/abc', `${WEBHOOK}\n`])(
    'does not send to something that is not a Discord webhook URL: %p',
    (webhook) => {
      clean();
      const out = run([VERSION], { KEY_SYSTEM_EVENTS_WEBHOOK_URL: webhook });
      expect(out.status).toBe(2);
      expect(sent()).toBe(false);
      expect(out.stdout + out.stderr).not.toContain(webhook.trim() || 'x');
    },
  );

  it('posts the note, with the webhook on stdin and never in the arguments', () => {
    clean();
    const out = run([VERSION], { KEY_SYSTEM_EVENTS_WEBHOOK_URL: WEBHOOK });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`Posted to #key-system-events: ${NOTE(VERSION)}`);
    expect(out.stdout + out.stderr).not.toContain(WEBHOOK);
    const args = fs.readFileSync(`${log}.args`, 'utf-8');
    expect(args).not.toContain('discord.com');
    expect(args).toContain('--globoff');
    expect(args).toContain('--max-time');
    expect(args.split('\n')[0]).toBe('-q');
    expect(fs.readFileSync(`${log}.stdin`, 'utf-8')).toBe(`url = "${WEBHOOK}"\n`);
    const body = args.split('\n').find((l) => l.startsWith('{'));
    expect(JSON.parse(body)).toEqual({ content: NOTE(VERSION) });
  });

  it('exits non-zero, says it failed and does not leak the webhook when the post fails', () => {
    clean();
    const out = run([VERSION], { KEY_SYSTEM_EVENTS_WEBHOOK_URL: WEBHOOK, FAKE_CURL_EXIT: '22' });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('failed (curl exit 22)');
    expect(out.stdout).not.toContain('Posted');
    expect(out.stdout + out.stderr).not.toContain(WEBHOOK);
  });
});
