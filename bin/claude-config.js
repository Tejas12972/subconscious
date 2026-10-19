import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  changedKeys,
  changedMcpServers,
  mcpServersOf,
} from './claude-config-drift.js';

// Prepares the isolated Claude Code config dir (CLAUDE_CONFIG_DIR) for a subc
// launch. Isolation exists to stop one leak: a /model pick inside subc landing
// in ~/.claude/settings.json and changing plain `claude`. Everything else the
// user set up in ~/.claude must keep working inside subc, so this dir links
// back to it and rebuilds the files Claude Code keeps per config dir.
//
// The one rule: preparing never writes, moves or deletes anything the user's
// own Claude Code reads. It writes only inside the isolated dir, and refuses a
// dir that resolves to ~/.claude, into it, or to a folder that holds it.

// Folders of ~/.claude that subc sessions share through a link: the user's
// rules, skills and hooks, session history so resume and `subc` session lists
// see one set of sessions, and the editor lock files so /ide finds the editor.
// A missing one is created in ~/.claude first, so something made inside subc
// (a first agent, a first skill) still lands in ~/.claude.
const SHARED_DIRS = [
  'rules',
  'agents',
  'commands',
  'skills',
  'output-styles',
  'hooks',
  'projects',
  'file-history',
  'todos',
  'plans',
  'ide',
];

// Files of ~/.claude shared through a link when the user has them.
const SHARED_FILES = ['CLAUDE.md', 'history.jsonl', 'keybindings.json'];

/** Every entry of ~/.claude that subc sessions share through a link. */
export const SHARED_ENTRIES = Object.freeze([...SHARED_FILES, ...SHARED_DIRS]);

// What the last launch wrote into the subc copies, to find what a session
// changed there before the next rebuild replaces it.
const WRITTEN_FILE = '.subc-written.json';

// Plugin index files copied into the subc plugins dir on each launch. The
// install paths inside still point at ~/.claude/plugins/cache, which Claude
// Code treats as outside its own cache root: a subc session can load those
// plugins but never marks them orphaned or deletes them. The cache itself is
// never linked, so an uninstall or cache sweep in subc cannot reach it.
const PLUGIN_INDEX_FILES = [
  'installed_plugins.json',
  'known_marketplaces.json',
  'blocklist.json',
  'config.json',
];

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
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
}

/** Text of a regular file (links followed), `undefined` when missing. */
function readRegularFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  // A FIFO or device would block or stream forever.
  if (!stat.isFile()) throw new Error('not a regular file');
  return fs.readFileSync(file, 'utf8');
}

/** Parsed JSON object, `undefined` when missing; throws when invalid. */
function readJsonObject(file) {
  const text = readRegularFile(file);
  if (text === undefined) return undefined;
  const value = JSON.parse(text);
  if (!isObject(value)) throw new Error('not a JSON object');
  return value;
}

// The temp name is unguessable and created exclusively, so a planted link at
// that name cannot redirect the write. The rename replaces a link at `file`
// with a regular file instead of writing through it.
function writeAtomic(file, text, mode = 0o644) {
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text, { mode, flag: 'wx' });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

const writeJsonAtomic = (file, value, mode) =>
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);

function lstatOrUndefined(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}

/** The real path, resolving the nearest existing ancestor of a missing one. */
function realPath(file) {
  const missing = [];
  let current = path.resolve(file);
  for (;;) {
    try {
      // .native returns the on-disk case, so ~/.CLAUDE resolves to ~/.claude.
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(file);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Device and inode of `file` (links followed), `undefined` when missing. */
function identity(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/** Identities of `file` and every folder above it. */
function selfAndAncestors(file) {
  const ids = new Set();
  let current = realPath(file);
  for (;;) {
    const id = identity(current);
    if (id) ids.add(id);
    const parent = path.dirname(current);
    if (parent === current) return ids;
    current = parent;
  }
}

// Files of the user's own config that prepare must never replace, paired
// with the path in the subc dir that prepare writes.
// A plugins link from an earlier build is unlinked, never written through,
// before the plugin files are written, so its target needs no check.
function guardedWrites(dir, home, source) {
  const pluginsLink = lstatOrUndefined(path.join(dir, 'plugins'));
  const plugins = pluginsLink?.isSymbolicLink() ? [] : PLUGIN_INDEX_FILES;
  return [
    [path.join(source, 'settings.json'), path.join(dir, 'settings.json')],
    [path.join(home, '.claude.json'), path.join(dir, '.claude.json')],
    ...plugins.map((name) => [
      path.join(source, 'plugins', name),
      path.join(dir, 'plugins', name),
    ]),
  ];
}

/**
 * Why `dir` must not be prepared, or `undefined` when it is safe. Compares
 * file identities, not path text, so no spelling, case or link can alias the
 * user's config into the dir.
 */
function unsafeDirReason(dir, home, source) {
  if (!path.isAbsolute(dir)) return `${dir} is not an absolute path`;
  const sourceId = identity(source);
  if (sourceId && selfAndAncestors(dir).has(sourceId)) {
    return `${dir} resolves into ~/.claude`;
  }
  const dirIds = selfAndAncestors(dir);
  for (const name of [...SHARED_ENTRIES, 'plugins']) {
    const targetId = identity(path.join(source, name));
    if (targetId && dirIds.has(targetId)) {
      return `${dir} resolves into the folder behind ~/.claude/${name}`;
    }
  }
  const dirId = identity(dir);
  const homeJson = identity(
    path.dirname(realPath(path.join(home, '.claude.json'))),
  );
  if (dirId && (selfAndAncestors(source).has(dirId) || dirId === homeJson)) {
    return `${dir} resolves to a folder that holds your Claude config`;
  }
  for (const [user, own] of guardedWrites(dir, home, source)) {
    const userId = identity(user);
    // A link at `own` is replaced by the rename, never written through.
    if (lstatOrUndefined(own)?.isSymbolicLink()) continue;
    if (userId && userId === identity(own)) {
      return `${own} is your own ${path.basename(user)}`;
    }
  }
  return undefined;
}

function sameFile(a, b) {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
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

function shareEntry(dir, source, name, warnings) {
  const target = path.join(source, name);
  const link = path.join(dir, name);
  if (SHARED_DIRS.includes(name) && !fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  if (!fs.existsSync(target)) return;
  const existing = lstatOrUndefined(link);
  if (existing?.isSymbolicLink() || (existing && sameFile(link, target))) {
    return;
  }
  if (existing) {
    warnings.push(
      `${link} is a real ${existing.isDirectory() ? 'directory' : 'file'}, so subc sessions do not share ~/.claude/${name}; move it aside to share it.`,
    );
    return;
  }
  linkEntry(target, link);
}

function shareEntries(dir, source, warnings) {
  for (const name of SHARED_ENTRIES) {
    try {
      shareEntry(dir, source, name, warnings);
    } catch (error) {
      warnings.push(`Could not share ~/.claude/${name}: ${error.message}`);
    }
  }
}

function copyPluginIndex(dir, source, warnings) {
  const own = path.join(dir, 'plugins');
  const existing = lstatOrUndefined(own);
  // An earlier build linked the whole folder. Removing a link never touches
  // its target.
  if (existing?.isSymbolicLink()) fs.unlinkSync(own);
  else if (existing && !existing.isDirectory()) {
    warnings.push(`${own} is not a directory, so plugins are not shared.`);
    return;
  }
  fs.mkdirSync(own, { recursive: true });
  for (const name of PLUGIN_INDEX_FILES) {
    try {
      const text = readRegularFile(path.join(source, 'plugins', name));
      if (text !== undefined) writeAtomic(path.join(own, name), text, 0o600);
    } catch (error) {
      warnings.push(
        `Could not copy ~/.claude/plugins/${name}: ${error.message}`,
      );
    }
  }
}

function rebuildSettings(dir, source, launchEnvNames, written, warnings) {
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
  const lost = written
    ? changedKeys(written, current, SUBC_OWNED_SETTINGS)
    : [];
  if (lost.length) {
    const saved = path.join(dir, 'settings.discarded.json');
    writeJsonAtomic(saved, current, 0o600);
    warnings.push(
      `Settings changed inside your last subc session are not kept: ${lost.join(', ')}. They are saved in ${saved}. To keep them, add them in plain claude or ~/.claude/settings.json.`,
    );
  }
  const next = { ...settings, ...pick(current, SUBC_OWNED_SETTINGS) };
  writeJsonAtomic(file, next);
  return next;
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

function syncState(dir, home, written, warnings) {
  const file = path.join(dir, '.claude.json');
  let user;
  let current;
  try {
    user = readJsonObject(path.join(home, '.claude.json'));
  } catch (error) {
    warnings.push(`Ignored ~/.claude.json in subc sessions: ${error.message}`);
    return undefined;
  }
  if (!user) return undefined;
  try {
    current = readJsonObject(file) ?? {};
  } catch (error) {
    warnings.push(`Left ${file} unchanged: ${error.message}`);
    return undefined;
  }
  const lost = written ? changedMcpServers(written, mcpServersOf(current)) : [];
  if (lost.length) {
    const saved = path.join(dir, 'mcp.discarded.json');
    writeJsonAtomic(saved, mcpServersOf(current), 0o600);
    warnings.push(
      `MCP servers added inside your last subc session are not kept: ${lost.join(', ')}. They are saved in ${saved}. To keep them, add them in plain claude.`,
    );
  }
  const next = { ...current, ...pick(user, COPIED_STATE) };
  if (isObject(user.projects)) {
    next.projects = mergeProjects(current.projects, user.projects);
  }
  writeJsonAtomic(file, next, 0o600);
  return mcpServersOf(next);
}

function readWritten(dir) {
  try {
    return readJsonObject(path.join(dir, WRITTEN_FILE)) ?? {};
  } catch {
    return {};
  }
}

/**
 * Make `dir` a Claude Code config dir that shares the user's ~/.claude setup
 * and keeps only subc's own settings apart. Never writes into ~/.claude except
 * to create ~/.claude/projects, and never deletes anything there. Problems
 * come back as warnings; preparing never throws, so a launch always proceeds.
 *
 * @param {{ dir: string, home?: string, launchEnvNames?: Iterable<string> }} options
 * @returns {{ warnings: string[], refused: boolean }} `refused` means the
 *   dir aliases the user's own config; the launch must not run on it.
 */
export function prepareClaudeConfigDir({
  dir,
  home = os.homedir(),
  launchEnvNames = [],
}) {
  const warnings = [];
  const source = path.join(home, '.claude');
  const unsafe = unsafeDirReason(dir, home, source);
  if (unsafe) {
    warnings.push(
      `Refused to use ${dir} as the subc Claude config dir: ${unsafe}. Claude Code would write into your own config there. Point SUBC_CONFIG_DIR somewhere else, or run subc claude --no-isolate.`,
    );
    return { warnings, refused: true };
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    shareEntries(dir, source, warnings);
    copyPluginIndex(dir, source, warnings);
    const written = readWritten(dir);
    const settings = rebuildSettings(
      dir,
      source,
      new Set(launchEnvNames),
      written.settings,
      warnings,
    );
    const mcp = syncState(dir, home, written.mcp, warnings);
    writeJsonAtomic(path.join(dir, WRITTEN_FILE), { settings, mcp }, 0o600);
  } catch (error) {
    warnings.push(
      `Could not prepare the subc Claude config dir ${dir}: ${error.message}`,
    );
  }
  return { warnings, refused: false };
}

/**
 * Prepare the isolated dir for a planned Claude Code launch, when subc chose
 * it. A CLAUDE_CONFIG_DIR the user set themselves (in `inputEnv`, even blank)
 * and an opted-out launch (no CLAUDE_CONFIG_DIR) are left alone.
 *
 * @param {{ env: { name: string }[] }} agent
 * @param {Record<string, string | undefined>} launchEnv the planned launch env
 * @param {Record<string, string | undefined>} inputEnv the env before planning
 * @param {{ home?: string }} [options]
 * @returns {{ warnings: string[], refused: boolean }}
 */
export function prepareClaudeLaunch(agent, launchEnv, inputEnv, options = {}) {
  const dir = launchEnv.CLAUDE_CONFIG_DIR;
  const own = inputEnv.CLAUDE_CONFIG_DIR;
  if (!dir || (own !== undefined && own !== '')) {
    return { warnings: [], refused: false };
  }
  const launchEnvNames = agent.env.map((entry) => entry.name);
  return prepareClaudeConfigDir({ dir, launchEnvNames, ...options });
}
