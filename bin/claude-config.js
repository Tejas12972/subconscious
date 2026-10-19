import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Prepares the isolated Claude Code config dir (CLAUDE_CONFIG_DIR) for a subc
// launch. Isolation exists to stop one leak: a /model pick inside subc landing
// in ~/.claude/settings.json and changing plain `claude`. Everything else the
// user set up in ~/.claude must keep working inside subc, so this dir links
// back to it and rebuilds the two files Claude Code keeps per config dir.

/**
 * Entries of ~/.claude that subc sessions share through a link: the user's
 * memory, rules, skills, plugins and hooks, plus session history so resume
 * and `subc` session lists see one set of sessions.
 */
export const SHARED_ENTRIES = Object.freeze([
  'CLAUDE.md',
  'rules',
  'agents',
  'commands',
  'skills',
  'plugins',
  'output-styles',
  'hooks',
  'projects',
  'history.jsonl',
  'file-history',
  'todos',
  'plans',
]);

// Linked even when ~/.claude lacks them, so sessions are shared from the start.
const ALWAYS_SHARED_DIRS = new Set(['projects']);

// User settings keys subc owns inside its sessions. `model` is the leak this
// isolation exists for; the subc value survives each rebuild.
const SUBC_OWNED_SETTINGS = ['model'];
// User settings keys dropped because they would replace the gateway credential.
const DROPPED_SETTINGS = ['apiKeyHelper'];

// ~/.claude.json keys copied in. Login state (oauthAccount, primaryApiKey)
// never is: subc sessions authenticate with the gateway token.
const COPIED_STATE = ['mcpServers', 'hasCompletedOnboarding', 'theme'];
const COPIED_PROJECT_STATE = [
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasTrustDialogAccepted',
  'allowedTools',
];

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function pick(source, keys) {
  return Object.fromEntries(
    keys.filter((key) => key in source).map((key) => [key, source[key]]),
  );
}

/** Parsed JSON object, `undefined` when the file is missing; throws when invalid. */
function readJsonObject(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(text);
  if (!isObject(value)) throw new Error('not a JSON object');
  return value;
}

function writeJsonAtomic(file, value, mode) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
}

function linkEntry(target, link) {
  const isDir = fs.statSync(target).isDirectory();
  try {
    // Junctions need no privilege on Windows; elsewhere the type is ignored.
    fs.symlinkSync(target, link, isDir ? 'junction' : 'file');
  } catch (error) {
    // Windows file symlinks need Developer Mode; a hard link shares the file.
    if (isDir || process.platform !== 'win32') throw error;
    fs.linkSync(target, link);
  }
}

function shareEntries(dir, source, warnings) {
  for (const name of SHARED_ENTRIES) {
    const target = path.join(source, name);
    const link = path.join(dir, name);
    if (ALWAYS_SHARED_DIRS.has(name)) fs.mkdirSync(target, { recursive: true });
    if (!fs.existsSync(target)) continue;
    let existing;
    try {
      existing = fs.lstatSync(link);
    } catch {
      existing = undefined;
    }
    if (existing?.isSymbolicLink()) continue;
    if (existing) {
      warnings.push(
        `${link} is a real ${existing.isDirectory() ? 'directory' : 'file'}, so subc sessions do not share ~/.claude/${name}; move it aside to share it.`,
      );
      continue;
    }
    try {
      linkEntry(target, link);
    } catch (error) {
      warnings.push(`Could not link ${link} to ${target}: ${error.message}`);
    }
  }
}

function rebuildSettings(dir, source, launchEnvNames, warnings) {
  const file = path.join(dir, 'settings.json');
  let user = {};
  try {
    user = readJsonObject(path.join(source, 'settings.json')) ?? {};
  } catch (error) {
    warnings.push(
      `Ignored ~/.claude/settings.json in subc sessions: ${error.message}`,
    );
  }
  let current = {};
  try {
    current = readJsonObject(file) ?? {};
  } catch {
    current = {};
  }
  const settings = { ...user };
  for (const key of [...SUBC_OWNED_SETTINGS, ...DROPPED_SETTINGS]) {
    delete settings[key];
  }
  if (isObject(user.env)) {
    const env = Object.fromEntries(
      Object.entries(user.env).filter(([name]) => !launchEnvNames.has(name)),
    );
    if (Object.keys(env).length) settings.env = env;
    else delete settings.env;
  }
  writeJsonAtomic(file, { ...settings, ...pick(current, SUBC_OWNED_SETTINGS) });
}

function mergeProjects(current, user) {
  const projects = isObject(current) ? { ...current } : {};
  for (const [project, state] of Object.entries(user)) {
    if (!isObject(state)) continue;
    const copied = pick(state, COPIED_PROJECT_STATE);
    if (!Object.keys(copied).length) continue;
    const existing = isObject(projects[project]) ? projects[project] : {};
    projects[project] = { ...existing, ...copied };
  }
  return projects;
}

function syncState(dir, home, warnings) {
  const file = path.join(dir, '.claude.json');
  let user;
  let current;
  try {
    user = readJsonObject(path.join(home, '.claude.json'));
  } catch (error) {
    warnings.push(`Ignored ~/.claude.json in subc sessions: ${error.message}`);
    return;
  }
  if (!user) return;
  try {
    current = readJsonObject(file) ?? {};
  } catch (error) {
    warnings.push(`Left ${file} unchanged: ${error.message}`);
    return;
  }
  const next = { ...current, ...pick(user, COPIED_STATE) };
  if (isObject(user.projects)) {
    next.projects = mergeProjects(current.projects, user.projects);
  }
  writeJsonAtomic(file, next, 0o600);
  fs.chmodSync(file, 0o600);
}

/**
 * Make `dir` a Claude Code config dir that shares the user's ~/.claude setup
 * and keeps only subc's own settings apart. Never writes into ~/.claude except
 * to create ~/.claude/projects, and never deletes anything.
 *
 * @param {{ dir: string, home?: string, launchEnvNames?: Iterable<string> }} options
 * @returns {{ warnings: string[] }}
 */
export function prepareClaudeConfigDir({
  dir,
  home = os.homedir(),
  launchEnvNames = [],
}) {
  const warnings = [];
  const source = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  shareEntries(dir, source, warnings);
  rebuildSettings(dir, source, new Set(launchEnvNames), warnings);
  syncState(dir, home, warnings);
  return { warnings };
}

/**
 * Prepare the isolated dir for a planned Claude Code launch, when subc chose
 * it. A CLAUDE_CONFIG_DIR the user set themselves (in `inputEnv`) and an
 * opted-out launch (no CLAUDE_CONFIG_DIR) are left alone.
 *
 * @param {{ env: { name: string }[] }} agent
 * @param {Record<string, string | undefined>} launchEnv the planned launch env
 * @param {Record<string, string | undefined>} inputEnv the env before planning
 * @param {{ home?: string }} [options]
 * @returns {string[]} warnings for the user
 */
export function prepareClaudeLaunch(agent, launchEnv, inputEnv, options = {}) {
  const dir = launchEnv.CLAUDE_CONFIG_DIR;
  if (!dir || inputEnv.CLAUDE_CONFIG_DIR?.trim()) return [];
  const launchEnvNames = agent.env.map((entry) => entry.name);
  return prepareClaudeConfigDir({ dir, launchEnvNames, ...options }).warnings;
}
