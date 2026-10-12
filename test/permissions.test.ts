import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, requiredAgents } from '../src/agents.ts';
import { excludedName } from '../src/folder.ts';
import {
  buildDenyRules,
  isSecretFileName,
  READ_ALLOW_RULE,
  SECRET_FILE_GLOBS,
  SECRET_HOME_PATHS,
} from '../src/permissions.ts';

test('deny rules anchor every secret glob at the filesystem root and cover home credential stores', () => {
  const rules = buildDenyRules();
  for (const glob of SECRET_FILE_GLOBS) assert.ok(rules.includes(`Read(//**/${glob})`), glob);
  for (const path of SECRET_HOME_PATHS) assert.ok(rules.includes(`Read(${path})`), path);
  // A relative `**/x` rule only matches under cwd (spike 2a); every file rule must use `//`.
  assert.ok(rules.every(rule => /^Read\((\/\/\*\*\/|~\/)/.test(rule)), 'no cwd-relative deny rules');
  assert.equal(new Set(rules).size, rules.length);
});

test('review argv scopes Read to the working directory and injects deny rules next to the hooks', () => {
  for (const [mode, deep] of [['code', false], ['repo', true], ['plan', false], ['spec', true]] as const) {
    const args = buildClaudeArgs('C:/tmp/bundle', 'C:/repo', requiredAgents(mode, deep), deep);
    assert.equal(args[args.indexOf('--allowedTools') + 1], `Agent,${READ_ALLOW_RULE}`);
    assert.equal(READ_ALLOW_RULE, 'Read(./**)');
    assert.equal(args[args.indexOf('--tools') + 1], 'Agent,Read,Grep,Glob');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--add-dir') + 1], 'C:/tmp/bundle');
    for (const flag of ['--add-dir', '--tools', '--allowedTools', '--disallowedTools']) {
      assert.ok(args[args.indexOf(flag) + 2].startsWith('--'), `${flag} must be followed by another flag`);
    }
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.deepEqual(settings.permissions, { deny: buildDenyRules() });
    assert.ok(settings.hooks.Stop && settings.hooks.PostToolUse && settings.hooks.PostToolUseFailure);
    assert.equal(settings.permissions.allow, undefined, 'no blanket allow rules in settings');
  }
});

test('secret file names match case-insensitively and include everything the folder snapshot used to exclude', () => {
  const secrets = [
    '.env', '.env.local', '.env.example', '.ENV', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
    'credentials.json', 'server.pem', 'tls.KEY', 'cert.p12', 'cert.pfx', 'store.jks', 'app.keystore',
    'id_rsa', 'ID_RSA', 'id_rsa.pub', 'id_ed25519', 'id_dsa', 'id_ecdsa',
  ];
  for (const name of secrets) assert.equal(isSecretFileName(name), true, name);
  const ordinary = ['README.md', 'env.ts', 'environment.md', 'key.ts', 'monkey.txt', 'keys.json', 'my.env.ts', 'pemfile.txt', 'credentials.md'];
  for (const name of ordinary) assert.equal(isSecretFileName(name), false, name);
});

test('folder snapshot exclusions are the shared secret list plus lockfiles and minified assets', () => {
  for (const name of ['.env', 'server.pem', 'id_ed25519', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'app.min.js']) {
    assert.equal(excludedName(name), true, name);
  }
  for (const name of ['README.md', 'index.ts', 'package.json']) assert.equal(excludedName(name), false, name);
});
