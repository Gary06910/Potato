'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readiness } = require('./instance');

const START = '# >>> To Know Codex bootstrap >>>';
const END = '# <<< To Know Codex bootstrap <<<';
const MARKER = '# Managed by To Know Server Agent shell bootstrap';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function coded(code) { const value = new Error(code); value.code = code; return value; }
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function validateName(value) {
  if (typeof value !== 'string' || value.length > 80 || !NAME.test(value)) throw coded('invalid_launcher_name');
  return value;
}

function absoluteLauncher(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.posix.isAbsolute(value));
}

function locations(paths, homeDir = os.homedir()) {
  return {
    shimDir: path.join(paths.dataRoot, 'shims'),
    bootstrap: path.join(paths.configRoot, 'shell', 'bootstrap.sh'),
    registry: path.join(paths.configRoot, 'shell', 'commands.json'),
    bashrc: path.join(homeDir, '.bashrc')
  };
}

function regularText(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw coded('unmanaged_shell_file');
    return fs.readFileSync(filePath, 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
}

function writeManaged(filePath, content, marker = MARKER) {
  const existing = regularText(filePath);
  if (existing !== null && !existing.startsWith(`${marker}\n`)) throw coded('unmanaged_shell_file');
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o700 });
  try { fs.renameSync(temp, filePath); }
  catch (cause) { fs.unlinkSync(temp); throw cause; }
  fs.chmodSync(filePath, 0o700);
}

function managedBlock(bootstrap) {
  return `${START}\nif [ -f ${quote(bootstrap)} ]; then\n  . ${quote(bootstrap)}\nfi\n${END}`;
}

function spliceBlock(content, block) {
  const starts = content.split(START).length - 1;
  const ends = content.split(END).length - 1;
  if (starts !== ends || starts > 1) throw coded('invalid_shell_marker');
  if (!starts) return block === null ? content : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${block}\n`;
  const begin = content.indexOf(START);
  const finish = content.indexOf(END, begin);
  if (finish < begin || content.indexOf(END) !== finish) throw coded('invalid_shell_marker');
  const after = finish + END.length;
  if (content[after] && content[after] !== '\n' && content[after] !== '\r') throw coded('invalid_shell_marker');
  const tail = content.slice(after).replace(/^\r?\n/, '');
  return `${content.slice(0, begin)}${block === null ? '' : `${block}\n`}${tail}`;
}

function updateBashrc(filePath, block) {
  const current = regularText(filePath) || '';
  const next = spliceBlock(current, block);
  if (next === current) return;
  const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : 0o644;
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, next, { flag: 'wx', mode });
  try { fs.renameSync(temp, filePath); }
  catch (cause) { fs.unlinkSync(temp); throw cause; }
}

function bootstrapText(shimDir) {
  return `${MARKER}\nTO_KNOW_SHIM_DIR=${quote(shimDir)}\ncase ":$PATH:" in\n  *":$TO_KNOW_SHIM_DIR:"*) ;;\n  *) PATH="$TO_KNOW_SHIM_DIR:$PATH"; export PATH ;;\nesac\nunset TO_KNOW_SHIM_DIR\n`;
}

function shimText(name, launcher) {
  validateName(name);
  return `#!/bin/bash\n${MARKER}: ${name}\nif ! ${quote(launcher)} ensure --quiet >/dev/null 2>&1; then\n  printf '%s\\n' '[Potato] Agent unavailable; continuing Codex.' >&2\nfi\ncase "$0" in */*) SHIM_PARENT=\${0%/*} ;; *) SHIM_PARENT=. ;; esac\nSHIM_DIR=$(CDPATH= cd -- "$SHIM_PARENT" && pwd -P) || exit 127\nORIGINAL_PATH=\nOLD_IFS=$IFS\nIFS=:\nset -f\nfor ENTRY in $PATH; do\n  [ -n "$ENTRY" ] || ENTRY=.\n  CANONICAL=$(CDPATH= cd -- "$ENTRY" 2>/dev/null && pwd -P) || CANONICAL=\n  [ "$CANONICAL" = "$SHIM_DIR" ] && continue\n  ORIGINAL_PATH=\${ORIGINAL_PATH:+$ORIGINAL_PATH:}$ENTRY\ndone\nIFS=$OLD_IFS\nPATH=$ORIGINAL_PATH\nexport PATH\nIFS=:\nfor ENTRY in $PATH; do\n  [ -n "$ENTRY" ] || ENTRY=.\n  ORIGINAL="$ENTRY/${name}"\n  if [ -f "$ORIGINAL" ] && [ -x "$ORIGINAL" ]; then\n    set +f\n    IS_SHIM=0\n    for OWN in "$SHIM_DIR"/*; do\n      if [ -e "$OWN" ] && [[ "$ORIGINAL" -ef "$OWN" ]]; then IS_SHIM=1; break; fi\n    done\n    set -f\n    [ "$IS_SHIM" -eq 1 ] && continue\n    IFS=$OLD_IFS\n    set +f\n    exec "$ORIGINAL" "$@"\n  fi\ndone\nIFS=$OLD_IFS\nprintf '%s\\n' '[Potato] Original launcher unavailable.' >&2\nexit 127\n`;
}

function readRegistry(filePath) {
  const text = regularText(filePath);
  if (text === null) return { commands: [], launcher: null };
  let value;
  try { value = JSON.parse(text); } catch (_) { throw coded('invalid_shell_registry'); }
  if (value?.version !== 1 || !Array.isArray(value.commands) || !absoluteLauncher(value.launcher)
    || value.commands.some((name) => { try { validateName(name); return false; } catch (_) { return true; } })
    || new Set(value.commands).size !== value.commands.length) throw coded('invalid_shell_registry');
  return value;
}

function writeRegistry(filePath, commands, launcher) {
  const value = { version: 1, commands: [...commands].sort(), launcher };
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const existing = regularText(filePath);
  if (existing !== null) readRegistry(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temp, filePath); }
  catch (cause) { fs.unlinkSync(temp); throw cause; }
}

function originalExists(name, shimDir, pathValue) {
  const canonicalShim = fs.realpathSync.native(shimDir);
  return pathValue.split(path.delimiter).some((entry) => {
    const dir = entry || '.';
    try {
      if (fs.realpathSync.native(dir) === canonicalShim) return false;
      const candidate = path.join(dir, name);
      const resolved = fs.realpathSync.native(candidate);
      if (resolved.startsWith(`${canonicalShim}${path.sep}`)) return false;
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_) { return false; }
  });
}

function install({ paths, commands, launcher = path.join(os.homedir(), '.local', 'bin', 'toknow-agent'), homeDir, envPath = process.env.PATH || '' }) {
  if (!Array.isArray(commands) || commands.length === 0) throw coded('missing_launcher_name');
  if (!absoluteLauncher(launcher)) throw coded('invalid_agent_launcher');
  const unique = [...new Set(commands.map(validateName))];
  const where = locations(paths, homeDir);
  fs.mkdirSync(where.shimDir, { recursive: true, mode: 0o700 });
  const old = readRegistry(where.registry);
  if (old.launcher && old.launcher !== launcher) throw coded('launcher_path_conflict');
  for (const name of unique) {
    if (!originalExists(name, where.shimDir, envPath)) throw coded('original_launcher_missing');
    const existing = regularText(path.join(where.shimDir, name));
    if (existing !== null && !existing.startsWith(`#!/bin/bash\n${MARKER}: ${name}\n`)) throw coded('unmanaged_shell_file');
  }
  const currentBashrc = regularText(where.bashrc) || '';
  spliceBlock(currentBashrc, managedBlock(where.bootstrap));
  for (const name of unique) writeManaged(path.join(where.shimDir, name), shimText(name, launcher), `#!/bin/bash\n${MARKER}: ${name}`);
  writeManaged(where.bootstrap, bootstrapText(where.shimDir));
  writeRegistry(where.registry, new Set([...old.commands, ...unique]), launcher);
  updateBashrc(where.bashrc, managedBlock(where.bootstrap));
  return { commands: [...new Set([...old.commands, ...unique])].sort(), shimDirectory: where.shimDir };
}

function remove({ paths, command, homeDir }) {
  const name = validateName(command);
  const where = locations(paths, homeDir);
  const registry = readRegistry(where.registry);
  if (!registry.commands.includes(name)) throw coded('unknown_launcher');
  const bashrc = regularText(where.bashrc) || '';
  if (!bashrc.includes(START) || !bashrc.includes(END)) throw coded('invalid_shell_marker');
  spliceBlock(bashrc, null);
  const shimPath = path.join(where.shimDir, name);
  if (regularText(shimPath) !== shimText(name, registry.launcher)) throw coded('modified_shell_shim');
  const remaining = registry.commands.filter((item) => item !== name);
  if (!remaining.length) {
    const bootstrap = regularText(where.bootstrap);
    if (bootstrap !== bootstrapText(where.shimDir)) throw coded('modified_shell_bootstrap');
    spliceBlock(regularText(where.bashrc) || '', null);
  }
  fs.unlinkSync(shimPath);
  if (remaining.length) writeRegistry(where.registry, remaining, registry.launcher);
  else {
    updateBashrc(where.bashrc, null);
    fs.unlinkSync(where.bootstrap);
    fs.unlinkSync(where.registry);
  }
  return { commands: remaining, shimDirectory: where.shimDir };
}

async function status({ paths, homeDir, envPath = process.env.PATH || '' }) {
  const where = locations(paths, homeDir);
  const registry = readRegistry(where.registry);
  const active = registry.commands.length > 0 && registry.commands.every((name) => {
    const first = envPath.split(path.delimiter).find((entry) => {
      try { return fs.existsSync(path.join(entry || '.', name)); } catch (_) { return false; }
    });
    if (!first) return false;
    try { return fs.realpathSync.native(first) === fs.realpathSync.native(where.shimDir); }
    catch (_) { return false; }
  });
  let agent;
  try { agent = await readiness(paths); }
  catch (_) { agent = { state: 'unknown' }; }
  return { commands: registry.commands, shimActive: active, agentRunning: agent.state === 'ready', agentPid: agent.pid || null };
}

module.exports = { START, END, validateName, locations, spliceBlock, bootstrapText, shimText, install, remove, status };
