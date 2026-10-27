#!/usr/bin/env node
// Fleet bridge: shows your Claude Code sessions, and anything else that speaks the
// Fleet format, live in the Fleet HUD. No dependencies; needs Node 18 or newer.
//
// With Node 18+ you can run it straight from GitHub: npx github:kdi208/fleet-hud [setup]
//
//   node fleet-bridge.js            start the bridge and open the HUD
//   node fleet-bridge.js setup      add the Claude Code hooks to ~/.claude/settings.json
//   node fleet-bridge.js setup --here   add them to ./.claude/settings.local.json only
//   node fleet-bridge.js remove     take the hooks out again (add --here for this folder)
//   node fleet-bridge.js hook       used by the hooks themselves; reads a hook event on stdin
//
// Options: --port 4545, --budget 50 (dollars), --no-open. Env: FLEET_PORT, FLEET_BUDGET,
// FLEET_APPROVAL_WAIT (seconds the HUD gets to answer a permission prompt, default 300).

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const PORT = +opt('--port', process.env.FLEET_PORT || 4545);
const HOST = '127.0.0.1';
const BUDGET = +opt('--budget', process.env.FLEET_BUDGET || 50);
const APPROVAL_WAIT_MS = 1000 * +(process.env.FLEET_APPROVAL_WAIT || 300);
const PAUSE_MAX_MS = 55 * 60 * 1000;        // the PreToolUse hook timeout is 60 minutes
const HOME_DIR = path.join(os.homedir(), '.fleet-bridge');
const TOKEN_FILE = path.join(HOME_DIR, 'token');
const SELF = path.resolve(__filename);
const HOOK_TAG = 'fleet-bridge.js" hook';
const APP_DIR = path.join(HOME_DIR, 'app');
// How the person ran us, so the tips we print match: npx runs us through the "fleet-hud" bin.
const CMD = path.basename(process.argv[1] || '') === 'fleet-hud' ? 'npx github:kdi208/fleet-hud' : 'node fleet-bridge.js';
// A hosted copy of the HUD (for example on GitHub Pages) that can connect to this bridge.
const HOSTED_HUD = process.env.FLEET_HUD_URL || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).homepage || ''; } catch { return ''; }
})();

// The hooks need a path that stays put, so setup copies the bridge and the HUD into
// ~/.fleet-bridge/app (an npx run lives in a cache folder that can be cleared).
const installApp = () => {
  if (path.resolve(__dirname) === path.resolve(APP_DIR)) return SELF;
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const f of ['fleet-bridge.js', 'index.html', 'package.json']) {
    try { fs.copyFileSync(path.join(__dirname, f), path.join(APP_DIR, f)); } catch {}
  }
  return path.join(APP_DIR, 'fleet-bridge.js');
};

// One token per machine. The HUD and the hooks send it; other web pages can't read it.
const token = () => {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  const t = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
};

// ---------------------------------------------------------------- hook client
// Runs inside every Claude Code hook. It must never break the session, so any
// failure (bridge not running, bad input) prints nothing and exits 0.
const runHookClient = () => {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    let tok;
    try { tok = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { process.exit(0); }
    const req = http.request({
      host: HOST, port: PORT, path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Token': tok, 'Content-Length': Buffer.byteLength(input) },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { if (res.statusCode === 200 && out.trim() && out.trim() !== '{}') process.stdout.write(out); process.exit(0); });
    });
    req.on('error', () => process.exit(0));
    req.setTimeout(PAUSE_MAX_MS + 60000, () => { req.destroy(); process.exit(0); });
    req.end(input);
  });
};

// ---------------------------------------------------------------- setup
const HOOK_EVENTS = {
  SessionStart: 10, UserPromptSubmit: 10, PreToolUse: 3600, PermissionRequest: 3600,
  PostToolUse: 10, Notification: 10, Stop: 10, SubagentStop: 10, PreCompact: 10, SessionEnd: 10,
};
const TOOL_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse'];

const settingsFile = () => flag('--here')
  ? path.join(process.cwd(), '.claude', 'settings.local.json')
  : path.join(os.homedir(), '.claude', 'settings.json');

const stripOurHooks = (hooks) => {
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(HOOK_TAG)) }))
      .filter((g) => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
};

const editSettings = (install) => {
  const file = settingsFile();
  let settings = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch {
      console.error(`Could not read ${file}: it is not valid JSON. Fix it first, then run this again.`);
      process.exit(1);
    }
    fs.writeFileSync(file + '.before-fleet', raw);
  }
  settings.hooks = settings.hooks || {};
  stripOurHooks(settings.hooks);
  if (install) {
    const command = `node "${installApp().replace(/\\/g, '/')}" hook`;
    for (const [ev, timeout] of Object.entries(HOOK_EVENTS)) {
      const group = { hooks: [{ type: 'command', command, timeout }] };
      if (TOOL_EVENTS.includes(ev)) group.matcher = '*';
      (settings.hooks[ev] = settings.hooks[ev] || []).push(group);
    }
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  token();
  console.log(install
    ? `Added the Fleet hooks to ${file}\nNew Claude Code sessions will show up in the HUD while the bridge runs.\nWhen the bridge is off, the hooks do nothing. Undo with: ${CMD} remove${flag('--here') ? ' --here' : ''}`
    : `Removed the Fleet hooks from ${file}`);
};

// ---------------------------------------------------------------- fleet state
const STATUSES = ['working', 'idle', 'approval', 'blocked', 'failing', 'paused', 'done'];
const ROLES = ['builder', 'reviewer', 'tester', 'scout', 'fixer', 'scribe'];
const agents = new Map();   // id -> public agent record (the Fleet format)
const inner = new Map();    // id -> bridge-only state
const clients = new Set();  // open HUD event streams
const recentAlerts = [];
const actionTimes = [];
const startedAt = Date.now();

const clock = () => new Date().toTimeString().slice(0, 5);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const getInner = (id) => {
  if (!inner.has(id)) inner.set(id, { waiters: [], permission: null, queue: [], commands: [], paused: false, stop: false, offset: 0, partial: '', seen: new Set(), readAt: 0, counts: { edit: 0, read: 0, test: 0, bash: 0 } });
  return inner.get(id);
};

const touch = (a) => { a.updated = Date.now(); };
const addLog = (a, line) => { a.log.push([clock(), clip(line, 70)]); if (a.log.length > 6) a.log.shift(); touch(a); };
const addRun = (a, ok) => { a.runs = (a.runs + (ok ? 'g' : 'r')).slice(-3); };

const snapshot = () => ({
  version: 1,
  source: 'bridge',
  project: { name: os.hostname().split('.')[0], description: 'Live agents on this computer' },
  startedAt,
  budget: BUDGET,
  actionsPerMin: actionTimes.filter((t) => t > Date.now() - 60000).length,
  agents: [...agents.values()],
});

let pending = null;
const broadcast = () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const data = `event: fleet\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(data);
  }, 80);
};
const send = (event, payload) => {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(data);
};
const alert = (a, level, text) => {
  const item = { at: Date.now(), agent: a.id, level, text };
  recentAlerts.push(item); if (recentAlerts.length > 30) recentAlerts.shift();
  send('alert', item);
};

const newAgent = (id, fields) => {
  const a = {
    id, name: id, team: 'agents', role: 'builder', status: 'idle', area: '(root)', task: 'Waiting for a task',
    ctx: 0, ctxMax: 200000, cost: 0, costEstimated: false, tasks: 0, perm: 'Ask', runs: '', log: [],
    waitingOn: '', source: 'api', model: '', updated: Date.now(), ...fields,
  };
  agents.set(id, a);
  return a;
};

// ---------------------------------------------------------------- Claude Code hooks
const PERM_NAMES = { default: 'Ask', acceptEdits: 'Edits', plan: 'Plan', bypassPermissions: 'Auto', dontAsk: 'Auto', auto: 'Auto' };
const PRICES = { opus: [5, 25], sonnet: [3, 15], haiku: [1, 5] }; // dollars per million tokens, input/output

const areaOf = (cwd, file) => {
  if (!file) return null;
  const rel = path.relative(cwd, path.resolve(cwd, String(file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'outside';
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) return '(root)';
  if (['src', 'packages', 'apps', 'lib', 'services'].includes(parts[0]) && parts.length > 2) return parts[0] + '/' + parts[1];
  return parts[0];
};
const relName = (cwd, file) => { const r = path.relative(cwd, path.resolve(cwd, String(file))); return r.startsWith('..') ? path.basename(String(file)) : r; };

const askFor = (cwd, name, input = {}) => {
  const f = input.file_path || input.notebook_path;
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `edit ${relName(cwd, f)}`;
    case 'Write': return `create ${relName(cwd, f)}`;
    case 'Bash': return `run: ${input.command}`;
    case 'WebFetch': try { return `fetch ${new URL(input.url).host}`; } catch { return 'fetch a page'; }
    default: { const m = /^mcp__(.+?)__(.+)$/.exec(name); return m ? `use ${m[1]}: ${m[2]}` : `use ${name}`; }
  }
};
const describeTool = (cwd, name, input = {}) => {
  const f = input.file_path || input.notebook_path;
  switch (name) {
    case 'Read': return `Read ${relName(cwd, f)}`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `Edited ${relName(cwd, f)}`;
    case 'Write': return `Wrote ${relName(cwd, f)}`;
    case 'Bash': return `Ran: ${input.description || input.command}`;
    case 'Grep': return `Searched for "${input.pattern}"`;
    case 'Glob': return `Listed ${input.pattern}`;
    case 'WebFetch': try { return `Fetched ${new URL(input.url).host}`; } catch { return 'Fetched a page'; }
    case 'WebSearch': return `Searched the web: ${input.query}`;
    case 'Task': case 'Agent': return `Started a helper: ${input.description || ''}`;
    case 'TodoWrite': return 'Updated its to-do list';
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      return m ? `Used ${m[1]}: ${m[2]}` : `Used ${name}`;
    }
  }
};
const areaOfTool = (cwd, name, input = {}) => {
  if (['WebFetch', 'WebSearch'].includes(name)) return 'web';
  return areaOf(cwd, input.file_path || input.notebook_path || input.path);
};
const looksLikeTests = (cmd) => /\b(npm|yarn|pnpm|bun)( run)? test\b|\b(jest|vitest|pytest|mocha|rspec|phpunit)\b|\b(go|cargo|deno|dotnet|mix|make) test\b|\bplaywright test\b/.test(cmd || '');
const failed = (resp) => {
  if (!resp) return false;
  if (typeof resp === 'string') return /^error/i.test(resp);
  if (resp.is_error || resp.error || resp.interrupted) return true;
  const out = `${resp.stdout || ''}\n${resp.stderr || ''}`;
  return /\b[1-9]\d* (failed|failing|errors?)\b|\bFAILED\b|\bFAIL\b/.test(out);
};

// Context left and an estimated cost come from the session's transcript file.
const readTranscript = (a, p, file, force) => {
  if (!file || (!force && Date.now() - p.readAt < 2000)) return;
  p.readAt = Date.now();
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < p.offset) { p.offset = 0; p.partial = ''; }
    const len = Math.min(size - p.offset, 8 * 1024 * 1024);
    if (len <= 0) return;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, p.offset);
    p.offset += len;
    const lines = (p.partial + buf.toString('utf8')).split('\n');
    p.partial = lines.pop();
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const m = d.message;
      if (d.type !== 'assistant' || !m || !m.usage || d.isSidechain) continue;
      const u = m.usage;
      const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      a.ctx = inTok + (u.output_tokens || 0);
      if (a.ctx > 200000 || /1m/i.test(m.model || '')) a.ctxMax = 1000000;
      a.model = m.model || a.model;
      if (m.id && !p.seen.has(m.id)) {
        p.seen.add(m.id);
        const fam = Object.keys(PRICES).find((k) => (m.model || '').includes(k)) || 'sonnet';
        const [pin, pout] = PRICES[fam];
        const write1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
        const write5m = (u.cache_creation_input_tokens || 0) - write1h;
        a.cost += ((u.input_tokens || 0) * pin + (u.cache_read_input_tokens || 0) * pin * 0.1
          + write5m * pin * 1.25 + write1h * pin * 2 + (u.output_tokens || 0) * pout) / 1e6;
        a.costEstimated = true;
      }
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
};

// Wait for the HUD: resolves with an order ('resume', 'stop', 'approve', 'deny') or null on timeout.
const waitForOrder = (p, ms) => new Promise((resolve) => {
  const w = { resolve: (v) => { clearTimeout(w.timer); p.waiters = p.waiters.filter((x) => x !== w); resolve(v); } };
  w.timer = setTimeout(() => w.resolve(null), ms);
  p.waiters.push(w);
});
const wake = (p, order) => { for (const w of [...p.waiters]) w.resolve(order); };

const operatorNote = (p) => {
  const msgs = p.queue.splice(0);
  return msgs.length ? `The user queued a follow-up for you in Fleet HUD, their dashboard for Claude Code sessions: ${msgs.join(' Then: ')}` : '';
};

const STOP_OUTPUT = { continue: false, stopReason: 'Stopped from the Fleet HUD.' };

const onHook = async (ev) => {
  const id = String(ev.session_id || '');
  if (!id) return {};
  const name = ev.hook_event_name;
  const cwd = ev.cwd || process.cwd();
  const team = path.basename(cwd) || 'agents';
  let a = agents.get(id);
  if (!a) {
    a = newAgent(id, { name: `${team}-${id.slice(0, 4)}`, team, source: 'claude-code', area: '(root)', task: 'Waiting for a prompt' });
    alert(a, 'info', `${a.name} joined the fleet`);
  }
  const p = getInner(id);
  clearTimeout(p.removeTimer);
  if (ev.permission_mode) a.perm = PERM_NAMES[ev.permission_mode] || ev.permission_mode;
  if (ev.permission_mode === 'plan') a.role = 'scout';
  readTranscript(a, p, ev.transcript_path, name === 'Stop');
  touch(a);
  let out = {};

  switch (name) {
    case 'SessionStart':
      a.status = 'idle';
      addLog(a, ev.source === 'resume' ? 'Resumed the session' : 'Session started');
      break;

    case 'UserPromptSubmit': {
      a.status = p.paused ? 'paused' : 'working';
      a.task = clip(ev.prompt, 90) || a.task;
      a.waitingOn = '';
      addLog(a, 'Got a new prompt');
      const note = operatorNote(p);
      if (note) out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } };
      break;
    }

    case 'PreToolUse': {
      actionTimes.push(Date.now()); while (actionTimes.length > 500) actionTimes.shift();
      const input = ev.tool_input || {};
      const area = areaOfTool(cwd, ev.tool_name, input);
      if (area) a.area = area;
      if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(ev.tool_name)) p.counts.edit++;
      else if (['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(ev.tool_name)) p.counts.read++;
      else if (ev.tool_name === 'Bash') { p.counts.bash++; if (looksLikeTests(input.command)) p.counts.test++; }
      if (ev.permission_mode !== 'plan') {
        const c = p.counts;
        a.role = c.edit ? (c.test > c.edit ? 'tester' : 'builder') : c.test ? 'tester' : 'scout';
      }
      addLog(a, describeTool(cwd, ev.tool_name, input));
      if (p.stop) { p.stop = false; a.status = 'idle'; addLog(a, 'Stopped from the HUD'); out = STOP_OUTPUT; break; }
      if (p.paused) {
        a.status = 'paused';
        broadcast();
        const order = await waitForOrder(p, PAUSE_MAX_MS);
        if (order === 'stop') { a.status = 'idle'; addLog(a, 'Stopped from the HUD'); out = STOP_OUTPUT; break; }
        p.paused = false;
      }
      if (a.status !== 'failing') a.status = 'working';
      a.waitingOn = '';
      break;
    }

    case 'PermissionRequest': {
      const what = askFor(cwd, ev.tool_name, ev.tool_input || {});
      a.status = 'approval';
      a.waitingOn = what;
      if (!clients.size) { a.waitingOn = `${what} (answer in its terminal)`; break; }
      alert(a, 'approval', `${a.name} wants to ${clip(what, 70)}`);
      p.permission = { what };
      broadcast();
      const order = await waitForOrder(p, APPROVAL_WAIT_MS);
      p.permission = null;
      if (order === 'approve') {
        a.status = 'working'; a.waitingOn = ''; addLog(a, 'Approved from the HUD');
        out = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
      } else if (order === 'deny' || order === 'stop') {
        a.status = 'working'; a.waitingOn = ''; addLog(a, 'Denied from the HUD');
        out = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The operator denied this from the Fleet HUD.', interrupt: order === 'stop' } } };
      } else {
        a.waitingOn = `${what} (answer in its terminal)`;
      }
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const input = ev.tool_input || {};
      const bad = name === 'PostToolUseFailure' || failed(ev.tool_response);
      addRun(a, !bad);
      if (ev.tool_name === 'Bash' && looksLikeTests(input.command)) {
        if (bad) { if (a.status !== 'failing') alert(a, 'failing', `${a.name}: tests are failing`); a.status = 'failing'; addLog(a, 'Tests failed'); }
        else { a.status = 'working'; addLog(a, 'Tests passed'); }
      } else if (a.status === 'approval') a.status = 'working';
      break;
    }

    case 'Notification': {
      const msg = String(ev.message || '');
      if (/permission/i.test(msg) && !p.permission) { a.status = 'approval'; a.waitingOn = clip(msg, 80); alert(a, 'approval', `${a.name}: ${clip(msg, 60)}`); }
      else if (/waiting for your input|idle/i.test(msg)) { a.status = 'idle'; }
      else alert(a, 'info', `${a.name}: ${clip(msg, 60)}`);
      break;
    }

    case 'Stop': {
      const note = operatorNote(p);
      if (note && !ev.stop_hook_active) { out = { decision: 'block', reason: note }; a.status = 'working'; addLog(a, 'Picked up your order'); break; }
      a.status = 'idle';
      a.waitingOn = '';
      a.tasks++;
      addLog(a, `Finished: ${ev.last_assistant_message || 'turn complete'}`);
      alert(a, 'idle', `${a.name} finished and is waiting for you`);
      break;
    }

    case 'SubagentStop': addLog(a, 'A helper finished'); break;
    case 'PreCompact': addLog(a, 'Compacting its context'); break;

    case 'SessionEnd':
      a.status = 'done';
      addLog(a, 'Session ended');
      p.removeTimer = setTimeout(() => { agents.delete(id); inner.delete(id); broadcast(); }, 60000);
      break;
  }
  touch(a);
  broadcast();
  return out;
};

// ---------------------------------------------------------------- orders from the HUD
const command = ({ agent, order, text }) => {
  const a = agents.get(agent);
  if (!a) return { ok: false, error: 'No such agent' };
  const p = getInner(agent);

  if (a.source !== 'claude-code') {
    // Other agents fetch their orders from GET /api/commands or the event stream.
    const cmd = { agent, order, text: text || '', at: Date.now() };
    p.commands.push(cmd); if (p.commands.length > 50) p.commands.shift();
    send('command', cmd);
    if (order === 'pause') a.status = 'paused';
    if (['resume', 'approve', 'deny'].includes(order)) { a.status = 'working'; a.waitingOn = ''; }
    if (order === 'redirect') a.task = clip(text, 90);
    addLog(a, `Order sent: ${order}${text ? ' ' + text : ''}`);
    broadcast();
    return { ok: true, note: 'Sent. The agent picks it up from the bridge.' };
  }

  let note = '';
  switch (order) {
    case 'pause':
      p.paused = true; a.status = 'paused'; addLog(a, 'Paused from the HUD');
      note = 'Paused. It holds before its next tool call.'; break;
    case 'resume':
      if (!p.paused && a.status !== 'paused') return { ok: false, error: 'It is not paused. Use Redirect to give it new work.' };
      p.paused = false; wake(p, 'resume'); a.status = 'working'; addLog(a, 'Resumed from the HUD'); note = 'Resumed.'; break;
    case 'stop':
      p.stop = true; p.paused = false; wake(p, 'stop'); addLog(a, 'Stop requested');
      note = 'It stops at its next tool call.'; break;
    case 'approve':
    case 'deny':
      if (!p.permission) return { ok: false, error: 'Nothing is waiting for your approval right now.' };
      wake(p, order); note = order === 'approve' ? 'Approved.' : 'Denied.'; break;
    case 'redirect':
      if (!text) return { ok: false, error: 'Type the new instruction first.' };
      p.queue.push(clip(text, 2000)); addLog(a, `Order queued: ${text}`);
      note = a.status === 'idle' ? 'Queued. It is delivered with your next prompt in that session.' : 'Queued. It picks this up as soon as it finishes its current turn.';
      break;
    default:
      return { ok: false, error: `${order} isn't available for Claude Code sessions yet.` };
  }
  touch(a); broadcast();
  return { ok: true, note };
};

// ---------------------------------------------------------------- the open format, for any agent
const FIELDS = ['name', 'team', 'role', 'status', 'area', 'task', 'ctx', 'ctxMax', 'cost', 'tasks', 'perm', 'runs', 'waitingOn', 'model'];
const upsert = (body) => {
  if (!body || typeof body.id !== 'string' || !body.id.trim()) throw new Error('Each agent needs an "id" string');
  const id = body.id.trim().slice(0, 80);
  let a = agents.get(id);
  if (!a) {
    if (agents.size >= 64) throw new Error('The fleet is full (64 agents)');
    a = newAgent(id, { source: 'api' });
    alert(a, 'info', `${body.name || id} joined the fleet`);
  }
  const was = a.status;
  for (const k of FIELDS) {
    if (body[k] === undefined) continue;
    const v = body[k];
    if (['ctx', 'ctxMax', 'cost', 'tasks'].includes(k)) { if (Number.isFinite(+v)) a[k] = +v; }
    else a[k] = clip(v, k === 'task' ? 120 : 80);
  }
  if (!STATUSES.includes(a.status)) a.status = 'working';
  if (!ROLES.includes(a.role)) a.role = 'builder';
  if (typeof body.log === 'string') addLog(a, body.log);
  else if (Array.isArray(body.log)) a.log = body.log.slice(-6).map((l) => Array.isArray(l) ? [clip(l[0], 8), clip(l[1], 70)] : [clock(), clip(l, 70)]);
  if (a.status !== was && ['approval', 'blocked', 'failing'].includes(a.status)) {
    alert(a, a.status, `${a.name}: ${{ approval: 'needs your approval', blocked: 'is blocked', failing: 'is failing' }[a.status]}${a.waitingOn ? ' (' + a.waitingOn + ')' : ''}`);
  }
  if (typeof body.alert === 'string') alert(a, 'info', `${a.name}: ${clip(body.alert, 80)}`);
  touch(a);
  return a;
};

// ---------------------------------------------------------------- http server
const serve = () => {
  const TOKEN = token();
  const hudFile = path.join(__dirname, 'index.html');
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const origin = req.headers.origin;
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    // Refuse other host names, so a web page can't reach the bridge by DNS tricks.
    if (!allowedHosts.includes(req.headers.host)) { res.writeHead(403); return res.end('Wrong host'); }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, X-Fleet-Token',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let html;
      try { html = fs.readFileSync(hudFile, 'utf8'); } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('index.html was not found next to fleet-bridge.js. Keep both files in the same folder.');
      }
      if (!/^\s*<!doctype/i.test(html)) html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + html;
      html = html.replace('<!--FLEET-BRIDGE-->', `<script>window.FLEET_BRIDGE = ${JSON.stringify({ url: '', token: TOKEN })};</script>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // Everything else needs the token, sent as a header or (for the event stream) in the URL.
    const given = req.headers['x-fleet-token'] || url.searchParams.get('token');
    if (given !== TOKEN) return json(401, { error: 'Missing or wrong token. It is printed when the bridge starts.' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }

    const body = async () => {
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 2e6) throw new Error('Too large'); }
      return raw ? JSON.parse(raw) : {};
    };

    try {
      if (req.method === 'POST' && url.pathname === '/hook') {
        const out = await onHook(await body());
        return json(200, out);
      }
      if (req.method === 'GET' && url.pathname === '/api/fleet') return json(200, snapshot());
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`retry: 2000\nevent: fleet\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          clearInterval(ping); clients.delete(res);
          // With no HUD open, permission prompts go back to the terminal.
          if (!clients.size) for (const p of inner.values()) if (p.permission) wake(p, null);
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/agents') {
        const b = await body();
        const list = Array.isArray(b) ? b : Array.isArray(b.agents) ? b.agents : [b];
        const saved = list.map(upsert);
        broadcast();
        return json(200, { ok: true, agents: saved.map((a) => a.id) });
      }
      const del = /^\/api\/agents\/(.+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && del) {
        const id = decodeURIComponent(del[1]);
        const ok = agents.delete(id); inner.delete(id); broadcast();
        return json(ok ? 200 : 404, { ok });
      }
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const r = command(await body());
        return json(r.ok ? 200 : 400, r);
      }
      if (req.method === 'GET' && url.pathname === '/api/commands') {
        const id = url.searchParams.get('agent');
        const p = inner.get(id);
        return json(200, { commands: p ? p.commands.splice(0) : [] });
      }
      return json(404, { error: 'Not found' });
    } catch (e) {
      return json(400, { error: String(e.message || e) });
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is the bridge already running? Try --port 4546.`);
    else console.error(e.message);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const link = `http://${HOST}:${PORT}`;
    const hooked = [path.join(os.homedir(), '.claude', 'settings.json'), path.join(process.cwd(), '.claude', 'settings.local.json')]
      .some((f) => { try { return fs.readFileSync(f, 'utf8').replace(/\\/g, '').includes(HOOK_TAG); } catch { return false; } });
    console.log(`
  Fleet bridge is running.

  Open the HUD:    ${link}
  Token:           ${TOKEN}
${HOSTED_HUD ? `  Or use the hosted HUD:  ${HOSTED_HUD.replace(/\/?$/, '/')}#bridge=${encodeURIComponent(link)}&token=${TOKEN}\n` : ''}${hooked ? '  Claude Code:     hooks found. Start or continue a session and it appears.' : `  Claude Code:     not connected yet. Run  ${CMD} setup  once, then start a session.`}

  Any other agent can report in with one request:
    curl -X POST ${link}/api/agents -H "X-Fleet-Token: ${TOKEN}" \\
      -H "Content-Type: application/json" -d '{"id":"my-bot","status":"working","area":"src","task":"Hello"}'

  Ctrl+C stops the bridge. Your sessions keep running without it.
`);
    if (!flag('--no-open')) {
      const { exec } = require('child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
      exec(`${cmd} "${link}"`, () => {});
    }
  });
};

// ---------------------------------------------------------------- main
const sub = argv[0];
if (sub === 'hook') runHookClient();
else if (sub === 'setup' || sub === 'install') editSettings(true);
else if (sub === 'remove' || sub === 'uninstall') editSettings(false);
else serve();
