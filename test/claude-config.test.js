import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { agentById } from '../bin/agent-data.js';
import {
  prepareClaudeConfigDir,
  prepareClaudeLaunch,
  SHARED_ENTRIES,
} from '../bin/claude-config.js';

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A fake home with a populated ~/.claude and ~/.claude.json. */
function fakeHome({ settings, claudeJson } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'subc-claude-config-'));
  roots.push(home);
  const source = path.join(home, '.claude');
  fs.mkdirSync(path.join(source, 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(source, 'skills', 'my-skill', 'SKILL.md'), 'x');
  fs.writeFileSync(path.join(source, 'CLAUDE.md'), '# mine\n');
  fs.writeFileSync(
    path.join(source, 'settings.json'),
    JSON.stringify(
      settings ?? {
        model: 'opus',
        hooks: { Stop: [] },
        enabledPlugins: { 'p@m': true },
      },
    ),
  );
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify(
      claudeJson ?? {
        oauthAccount: { emailAddress: 'me@example.com' },
        primaryApiKey: 'sk-ant-secret',
        hasCompletedOnboarding: true,
        theme: 'dark',
        mcpServers: { linear: { type: 'http', url: 'https://mcp.linear' } },
        projects: {
          '/work/app': {
            mcpServers: { db: { command: 'db-mcp' } },
            hasTrustDialogAccepted: true,
            allowedTools: ['Bash'],
            projectOnboardingSeenCount: 3,
          },
        },
      },
    ),
  );
  return { home, source, dir: path.join(home, '.subconscious', 'claude-code') };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('shared entries link back to ~/.claude, so the user setup and sessions are one copy', () => {
  const { home, source, dir } = fakeHome();
  prepareClaudeConfigDir({ dir, home });

  assert.equal(
    fs.readlinkSync(path.join(dir, 'CLAUDE.md')),
    path.join(source, 'CLAUDE.md'),
  );
  assert.equal(
    fs.readlinkSync(path.join(dir, 'skills')),
    path.join(source, 'skills'),
  );
  // Session history is shared even before plain Claude ever ran.
  assert.equal(
    fs.readlinkSync(path.join(dir, 'projects')),
    path.join(source, 'projects'),
  );
  assert.equal(fs.statSync(path.join(source, 'projects')).isDirectory(), true);
  // An entry the user does not have is not invented.
  assert.equal(fs.existsSync(path.join(dir, 'agents')), false);

  // A session written through the isolated dir lands in ~/.claude.
  fs.writeFileSync(path.join(dir, 'projects', 's.jsonl'), '{}');
  assert.equal(fs.existsSync(path.join(source, 'projects', 's.jsonl')), true);
});

test('settings.json follows the user settings but keeps the subc model pick', () => {
  const { home, source, dir } = fakeHome({
    settings: {
      model: 'opus',
      apiKeyHelper: '/bin/key',
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', FOO: '1' },
      hooks: { Stop: [] },
    },
  });
  const userBytes = fs.readFileSync(path.join(source, 'settings.json'));

  prepareClaudeConfigDir({ dir, home, launchEnvNames: ['ANTHROPIC_BASE_URL'] });
  let settings = readJson(path.join(dir, 'settings.json'));
  assert.equal(
    settings.model,
    undefined,
    'the plain Claude model must not leak in',
  );
  assert.equal(
    settings.apiKeyHelper,
    undefined,
    'a key helper would replace the gateway token',
  );
  assert.deepEqual(
    settings.env,
    { FOO: '1' },
    'subc launch env must not be overridden',
  );
  assert.deepEqual(settings.hooks, { Stop: [] });

  // A /model pick inside subc is written to the isolated settings.
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ ...settings, model: 'subconscious/glm' }),
  );
  // The user then changes their own settings.
  fs.writeFileSync(
    path.join(source, 'settings.json'),
    JSON.stringify({ model: 'sonnet', hooks: { Stop: [{ x: 1 }] } }),
  );
  const changedBytes = fs.readFileSync(path.join(source, 'settings.json'));

  prepareClaudeConfigDir({ dir, home });
  settings = readJson(path.join(dir, 'settings.json'));
  assert.equal(
    settings.model,
    'subconscious/glm',
    'the subc pick survives the next launch',
  );
  assert.deepEqual(
    settings.hooks,
    { Stop: [{ x: 1 }] },
    'user edits reach subc',
  );
  assert.deepEqual(
    fs.readFileSync(path.join(source, 'settings.json')),
    changedBytes,
    '~/.claude/settings.json is never written',
  );
  assert.notDeepEqual(userBytes, changedBytes);
});

test('.claude.json gets MCP servers, trust and onboarding but never login state', () => {
  const { home, dir } = fakeHome();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({
      numStartups: 7,
      projects: { '/work/app': { lastCost: 2 } },
    }),
  );

  prepareClaudeConfigDir({ dir, home });
  const file = path.join(dir, '.claude.json');
  const state = readJson(file);
  assert.deepEqual(state.mcpServers, {
    linear: { type: 'http', url: 'https://mcp.linear' },
  });
  assert.equal(state.hasCompletedOnboarding, true);
  assert.equal(state.theme, 'dark');
  assert.equal(state.oauthAccount, undefined);
  assert.equal(state.primaryApiKey, undefined);
  assert.equal(
    state.numStartups,
    7,
    'Claude Code state in the isolated file is kept',
  );
  assert.deepEqual(state.projects['/work/app'], {
    lastCost: 2,
    mcpServers: { db: { command: 'db-mcp' } },
    hasTrustDialogAccepted: true,
    allowedTools: ['Bash'],
  });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('existing files in the isolated dir are never replaced or deleted', () => {
  const { home, dir } = fakeHome();
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'old.jsonl'), '{}');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# local\n');

  const { warnings } = prepareClaudeConfigDir({ dir, home });
  assert.equal(
    fs.readFileSync(path.join(dir, 'projects', 'old.jsonl'), 'utf8'),
    '{}',
  );
  assert.equal(
    fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'),
    '# local\n',
  );
  assert.equal(
    warnings.some((w) => w.includes('projects')),
    true,
    'a real dir where a link belongs is reported',
  );
});

test('a second launch is a no-op for links and keeps them pointed at ~/.claude', () => {
  const { home, source, dir } = fakeHome();
  prepareClaudeConfigDir({ dir, home });
  const { warnings } = prepareClaudeConfigDir({ dir, home });
  assert.deepEqual(warnings, []);
  assert.equal(
    fs.readlinkSync(path.join(dir, 'skills')),
    path.join(source, 'skills'),
  );
});

test('unreadable user files warn instead of blocking the launch', () => {
  const { home, source, dir } = fakeHome();
  fs.writeFileSync(path.join(source, 'settings.json'), '{ not json');
  fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');

  const { warnings } = prepareClaudeConfigDir({ dir, home });
  assert.equal(warnings.length, 2);
  assert.deepEqual(readJson(path.join(dir, 'settings.json')), {});
  assert.equal(fs.existsSync(path.join(dir, '.claude.json')), false);
});

test('a home with no ~/.claude still gets a working isolated dir', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'subc-claude-empty-'));
  roots.push(home);
  const dir = path.join(home, '.subconscious', 'claude-code');
  const { warnings } = prepareClaudeConfigDir({ dir, home });
  assert.deepEqual(warnings, []);
  assert.deepEqual(readJson(path.join(dir, 'settings.json')), {});
  assert.equal(
    fs.readlinkSync(path.join(dir, 'projects')),
    path.join(home, '.claude', 'projects'),
  );
});

test('SHARED_ENTRIES never includes the files subc rebuilds', () => {
  for (const owned of ['settings.json', '.claude.json', '.credentials.json']) {
    assert.equal(SHARED_ENTRIES.includes(owned), false, owned);
  }
});

test('a launch prepares only the dir subc chose', () => {
  const agent = agentById('claude-code');
  const { home, dir } = fakeHome();

  prepareClaudeLaunch(agent, {}, {}, { home });
  assert.equal(fs.existsSync(dir), false, 'opted out: nothing to prepare');

  prepareClaudeLaunch(
    agent,
    { CLAUDE_CONFIG_DIR: dir },
    { CLAUDE_CONFIG_DIR: dir },
    { home },
  );
  assert.equal(fs.existsSync(dir), false, "a user-set dir is the user's own");

  prepareClaudeLaunch(agent, { CLAUDE_CONFIG_DIR: dir }, {}, { home });
  assert.equal(fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink(), true);
});

test('the launch env subc sets wins over the user settings env', () => {
  const agent = agentById('claude-code');
  const { home, dir } = fakeHome({
    settings: {
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', OTHER: 'x' },
    },
  });
  prepareClaudeLaunch(agent, { CLAUDE_CONFIG_DIR: dir }, {}, { home });
  assert.deepEqual(readJson(path.join(dir, 'settings.json')).env, {
    OTHER: 'x',
  });
});
