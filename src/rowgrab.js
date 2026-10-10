// Keeps rowgrab.ps1 running and asks it one thing: whose portrait stands
// beside the newest row of the game's own chat. Only the GSI source needs
// it - the feed gives a speaker's seat, never their hero.
//
// It is SCREEN CAPTURE: one small rectangle of the player's own game, only
// while the game is in front, compared on this PC with the game's own
// portraits and thrown away. Nothing is saved or sent anywhere.
//
// The portraits to compare with come from the player's install
// (heroface.js: disk, never the process) and are written to a temp folder
// for the helper - never into the repo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POWERSHELL } from './memsource.js';
import { faces, readIndex } from './heroface.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROW_SCRIPT = path.join(HERE, process.platform === 'win32' ? 'rowgrab.ps1' : 'rowgrab.py').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
export const ROW_EXE = process.platform === 'win32' ? POWERSHELL : (process.env.PYTHON || 'python3');

// MEASURED over a whole match and a replay: the right hero 0.89-0.93 beside
// a chat row, the best wrong one 0.51-0.66, a grab of anything else < 0.73.
export const SURE = 0.8;
// And clearly ahead of the next best: every right answer measured won by
// 0.22 or more. A near tie is a guess (the user, 2026-09-27: a teammate's
// line showed Bounty Hunter, who was not even in the game).
export const MARGIN = 0.15;

// Which chat is open, from the bright columns of the chat input's first
// words. MEASURED on the user's 1080p screenshots (2026-09-27): "To" 19 px,
// "(Allies):" 60 px (3.2 x), "(All):" 39 px (2.1 x); letters at most 3 px apart,
// words 6-8 (gaps counted between lit columns). Measured against "To", so the screen size does not matter.
// Anything else - no text, a game in another language, the chat closed -
// is null, and the key decides.
// Russian Dota (the user's screenshots, 2026-09-27): no "To" - the label is
// ONE word, "(Союзникам):" 111 px, "(Всем):" 56 px at 1080p, then the text.
// Spanish is measured too (below); other languages word it differently
// again, and are not guessed at.
export function channelFromRuns(runs, s = 1, lang = 'english') {
  if (!Array.isArray(runs) || !(s > 0)) return null;
  const words = [];
  for (const r of runs) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) return null;
    const last = words[words.length - 1];
    if (last && r[0] - last[1] - 1 < 4.5 * s) last[1] = r[1];
    else words.push([r[0], r[1]]);
  }
  // A speck (a lit pixel of the bar's edge, SEEN in the user's shot) is no word.
  // And nothing that ends before the label begins (12-17 px in, measured):
  // SEEN, a bright bit of the game's scenery at the strip's left edge.
  const real = words.filter(([a, b]) => b - a + 1 >= 4 * s && b >= 11 * s);
  words.length = 0; words.push(...real);
  if (lang === 'russian') {
    if (!words.length) return null;
    const w = (words[0][1] - words[0][0] + 1) / s;
    if (w >= 95 && w <= 130) return 'team';
    if (w >= 45 && w <= 70) return 'all';
    return null;
  }
  // Spanish Dota, both Spains (the user's screenshots, 2026-09-27): "A" 11
  // px, then "(Aliados):" 76 px or "(Todos):" 66 px. Closer than the others,
  // so the middle is left unsure.
  if (lang === 'spanish' || lang === 'latam') {
    if (words.length < 2) return null;
    const a = (words[0][1] - words[0][0] + 1) / s, w = (words[1][1] - words[1][0] + 1) / s;
    if (a < 6 || a > 17) return null;
    if (w >= 72.5 && w <= 84) return 'team';
    if (w >= 59 && w <= 69.5) return 'all';
    return null;
  }
  if (lang !== 'english' && lang !== '') return null;
  if (words.length < 2) return null;
  const to = words[0][1] - words[0][0] + 1, label = words[1][1] - words[1][0] + 1;
  if (to < 12 * s || to > 27 * s) return null;
  const k = label / to;
  if (k >= 2.75 && k <= 3.8) return 'team';
  if (k >= 1.6 && k <= 2.55) return 'all';
  return null;
}

/** The game's portraits as files, once per install. Returns the folder or null. */
export function writeRefs(dotaDir, dir = path.join(os.tmpdir(), 'dota-translator-faces')) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).length >= 100) return dir;
    const face = faces(dotaDir);
    let n = 0;
    for (const hero of readIndex(path.join(dotaDir, 'pak01_dir.vpk')).keys()) {
      const m = /^data:image\/(png|bmp);base64,(.*)$/.exec(face(hero) || '');
      if (m) { fs.writeFileSync(path.join(dir, hero + '.' + m[1]), Buffer.from(m[2], 'base64')); n++; }
    }
    return n ? dir : null;
  } catch { return null; }
}

/**
 * startRowGrab({dotaDir}) -> { identify(): Promise<{hero, score}|null>, stop() }
 * identify never rejects and never takes longer than `timeoutMs`: a line is
 * waiting on it.
 */
const DEBUG = Boolean(process.env.DT_DEBUG);

export function startRowGrab({ dotaDir, refs, spawnImpl = spawn, parentPid = process.pid, timeoutMs = 700, restartMs = 5000, sure = SURE } = {}) {
  const folder = refs || (dotaDir ? writeRefs(dotaDir) : null);
  if (!folder) return { identify: async () => null, channel: async () => null, stop() {} };

  let child = null, ready = false, stopped = false, buffer = '', nextId = 1;
  const waiting = new Map();
  const settle = (id, value) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id); clearTimeout(w.timer); w.resolve(value);
  };

  function start() {
    if (stopped) return;
    const isWin = process.platform === 'win32';
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ROW_SCRIPT, '-ParentPid', String(parentPid), '-Refs', folder]
      : [ROW_SCRIPT, '-ParentPid', String(parentPid), '-Refs', folder];
    child = spawnImpl(ROW_EXE, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      for (const p of parts) {
        let o = null;
        try { o = JSON.parse(p); } catch { continue; }
        if (o && o.t === 'ready') ready = o.refs > 0;
        else if (o && o.t === 'chan') {
          if (DEBUG) console.log(new Date().toISOString().slice(11, 23), 'chan', p);
          // Raw: which words mean which chat depends on the game's language.
          settle(o.id, o.ok === 1 && Array.isArray(o.runs) ? { runs: o.runs, s: o.s } : null);
        }
        else if (o && o.t === 'row') {
          // DT_DEBUG: every answer as the helper gave it - a whole game went
          // by (2026-09-22) with no way to tell which lines had been looked at.
          if (DEBUG) console.log(new Date().toISOString().slice(11, 23), 'grab', p);
          const clear = typeof o.score2 !== 'number' || o.score - o.score2 >= MARGIN;
          const good = o.ok === 1 && typeof o.hero === 'string' && /^[a-z_]+$/.test(o.hero) && o.score >= sure && clear;
          settle(o.id, good ? { hero: o.hero, score: o.score } : null);
        }
      }
    });
    child.stdin.on('error', () => { /* the helper went away mid-write */ });
    child.on('error', () => { /* no PowerShell: speakers stay unnamed */ });
    child.on('exit', () => {
      child = null; ready = false;
      for (const id of [...waiting.keys()]) settle(id, null);
      if (!stopped) setTimeout(start, restartMs).unref?.();
    });
  }

  const ask = (what) => {
    if (!child || !ready) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, null), timeoutMs);
      waiting.set(id, { resolve, timer });
      try { child.stdin.write(what(id) + '\n'); } catch { settle(id, null); }
    });
  };

  start();
  return {
    // The chat row names the speaker whatever the feed's number means, and
    // was never wrong (34 of 34 grabs). When it is not sure - a wrapped
    // line, a row already gone, something drawn over it - the top bar's tile
    // for that SEAT is the fallback: the feed's player_id IS the seat in a
    // real game (SEEN, matchmade; NOT in a lobby with bots). A dead hero's
    // tile is grey and scores low: then nobody is named, and the speaker's
    // next line tries again.
    async identify(seat) {
      const row = await ask((id) => 'row ' + id);
      if (row || !Number.isInteger(seat) || seat < 0 || seat > 9) return row;
      const top = await ask((id) => 'seat ' + id + ' ' + seat);
      return top ? { ...top, from: 'top' } : null;
    },
    /** {runs, s} | null: the chat input's bright columns (channelFromRuns reads them). */
    channel: () => ask((id) => 'chan ' + id),
    stop() {
      stopped = true;
      for (const id of [...waiting.keys()]) settle(id, null);
      if (child) { try { child.kill(); } catch { /* already gone */ } }
      child = null;
    },
  };
}
