// The helper that presses the keys (sendchat.ps1), kept running so that it
// is ready the moment the player's key is: it waits, blocked on its stdin,
// for one word at a time - `copy` or `send` - and answers with one line.
// It ends when the app does (the pipe closes). One that died is started
// again the next time it is needed.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWERSHELL } from './memsource.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SEND_SCRIPT = path.join(HERE, process.platform === 'win32' ? 'sendchat.ps1' : 'sendchat.py').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
export const SEND_EXE = process.platform === 'win32' ? POWERSHELL : (process.env.PYTHON || 'python3');

const NL = String.fromCharCode(10);

export function createKeySender({ spawnImpl = spawn, script = SEND_SCRIPT, timeoutMs = 4000 } = {}) {
  let child = null, buffer = '', waiting = null, stopped = false;

  const settle = (r) => { if (!waiting) return; const w = waiting; waiting = null; clearTimeout(w.timer); w.resolve(r); };

  function onLine(line) {
    if (line === 'copied' || line === 'sent' || line === 'done') settle({ ok: true });
    else if (line.startsWith('NOT DONE: ')) settle({ ok: false, why: line.slice(10) });
  }

  function start() {
    if (child || stopped) return;
    buffer = '';
    try {
      const isWin = process.platform === 'win32';
      const args = isWin
        ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
        : [script];
      const c = spawnImpl(SEND_EXE, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child = c;
      c.stdout.on('data', (d) => {
        buffer += String(d);
        let at;
        while ((at = buffer.indexOf(NL)) >= 0) { onLine(buffer.slice(0, at).trim()); buffer = buffer.slice(at + 1); }
      });
      const gone = () => { if (child === c) child = null; settle({ ok: false, why: 'the helper stopped' }); };
      c.on('error', gone);
      c.on('exit', gone);
      c.stdin.on('error', () => { /* it went while being written to: `exit` says so */ });
    } catch { child = null; }
  }

  const WORDS = ['copy', 'send', 'clear', 'open team', 'open all', 'paste', 'enter'];
  function askNow(word) {
    start();
    if (!child) return Promise.resolve({ ok: false, why: 'the helper did not start' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle({ ok: false, why: 'the helper took too long' }), timeoutMs);
      waiting = { resolve, timer };
      try { child.stdin.write(word + NL); } catch { settle({ ok: false, why: 'the helper stopped' }); }
    });
  }
  // One at a time, in the order asked: a second line's keys wait for the
  // first's (a line can be taken while another is still being said).
  let queue = Promise.resolve();
  /** Answers { ok, why } and never throws. */
  function ask(word) {
    if (!WORDS.includes(word)) return Promise.resolve({ ok: false, why: 'not a command' });
    const run = queue.then(() => askNow(word));
    queue = run.catch(() => {});
    return run;
  }

  return {
    warm: start,
    copy: () => ask('copy'),
    send: () => ask('send'),
    clear: () => ask('clear'),
    open: (channel) => ask(channel === 'all' ? 'open all' : 'open team'),
    paste: () => ask('paste'),
    enter: () => ask('enter'),
    stop() { stopped = true; if (child) { try { child.stdin.end(); } catch { /* gone */ } child = null; } },
  };
}

/**
 * The whole act, with everything it touches handed in, so it can be tested
 * with no game, no clipboard and no model:
 * copy what is in the chat field -> translate -> put it back and send.
 * The player's clipboard is theirs and is put back whatever happens.
 */
export async function sayTranslated({ keys, clipboard, translate, into = '', explain = (m) => m, learned = () => {}, who = null, note = () => {}, hold = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const before = clipboard.readText();
  const restore = () => clipboard.writeText(before);
  // Emptied first: an empty clipboard afterwards means nothing was copied -
  // the chat was not open, or had nothing in it.
  clipboard.writeText('');
  const copied = await keys.copy();
  const typed = copied.ok ? String(clipboard.readText() || '').trim() : '';
  if (!typed) { restore(); return { said: false, why: copied.ok ? 'nothing typed' : copied.why }; }
  const ARROW = String.fromCharCode(0x2192), DOTS = String.fromCharCode(0x2026);
  const gone = () => note({ kind: 'note', text: '' });
  // `who`: the player's own name, colour and hero, once the app has seen
  // them - so the row is drawn as THEIR chat row, not as a loose line.
  const mine = typeof who === 'function' ? who() : who;
  note({ kind: 'note', text: typed, more: ARROW + ' ' + (into || 'translating') + DOTS, holdMs: 12000, ...(mine && mine.name ? { name: mine.name, slot: mine.slot, hero: mine.hero } : {}) });
  // `hold(true)`: the player's own Enter is kept from the game while the line
  // is away (the user, 2026-09-27: an impatient Enter sent the English and
  // closed the chat, and the app's Enter then opened an empty one that took
  // the keyboard). Let go before any key of ours is pressed.
  const let_go = () => { try { hold(false); } catch { /* nothing held */ } };
  try { hold(true); } catch { /* the check below still guards it */ }
  let out;
  try { out = (await translate(typed)).out; } catch (err) {
    let_go();
    restore();
    gone();
    const why = String((err && err.message) || err);
    // In words when it is Google being slow (`explain` knows): the player
    // needs to hear that it is not them, and that nothing was sent.
    const said = explain(why);
    note({ kind: 'error', text: (said === why ? 'Not translated (' + why + ').' : said.split(' Lines are shown')[0] + ' Not translated.') + ' Your line is still in the chat - Enter sends it as it is.' });
    return { said: false, why };
  }
  // BEFORE the keys, not after: the reader finds a new line in ~0.2s, and
  // this function is still waiting for the paste to settle when it does.
  // SEEN: the line was read at .483 and its meaning handed over after
  // that, so the model was asked anyway ("how often do u shower" came
  // back as "how often do you wash yourself").
  let_go();
  // Is what was typed STILL in the chat? If the chat was sent or closed
  // meanwhile (Enter, Escape, a click), Ctrl+A, Ctrl+V, Enter would land in
  // a closed chat - and that Enter opens an empty one. Nothing is sent then;
  // the translation is left on the clipboard.
  clipboard.writeText('');
  const again = await keys.copy();
  const still = again.ok ? String(clipboard.readText() || '').trim() : '';
  if (still !== typed) {
    clipboard.writeText(out);
    note({ kind: 'note', text: out, more: '- not sent: the chat was closed. Ctrl+V pastes it' });
    return { said: false, why: again.ok ? 'the chat changed while translating' : again.why, out };
  }
  try { learned(out, typed); } catch { /* the line is still said */ }
  clipboard.writeText(out);
  const sent = await keys.send();
  if (!sent.ok) {
    // Left on the clipboard on purpose: the player can still paste it.
    note({ kind: 'note', text: out, more: '- copied: Ctrl+V pastes it' });
    return { said: false, why: sent.why, out };
  }
  gone();
  // The game reads the clipboard when it is given Ctrl+V, not after.
  await wait(400);
  if (clipboard.readText() === out) restore();
  return { said: true, typed, out };
}

// ---- THE DEFAULT WAY: the chat closes at once -------------------------
// The user, 2026-09-27: "it is kind of annoying that the box has to remain
// open after translating". So the key TAKES the line and closes the chat at
// once - the player has their hero back - and the translation is SAID when
// it is ready: the app opens the chat itself (Enter for the team,
// Shift+Enter for all - it cannot see which one the player had open, so the
// key says it), pastes, checks, and presses Enter.

/** Take what is typed in the chat field and close the chat. The clipboard is
 *  given back. Answers { typed } or { why }. */
export async function takeLine({ keys, clipboard }) {
  const before = clipboard.readText();
  clipboard.writeText('');
  const copied = await keys.copy();
  const typed = copied.ok ? String(clipboard.readText() || '').trim() : '';
  clipboard.writeText(before);
  if (!typed) return { why: copied.ok ? 'nothing typed' : copied.why };
  const cleared = await keys.clear();
  if (!cleared.ok) return { why: cleared.why };
  return { typed };
}

/** Say `out` in the chat: opened by the app, pasted, checked, sent.
 *  Waits while the player is typing a line of their own (the chat field is
 *  not empty) or the game is not in front, up to `patienceMs`. Anything
 *  that cannot be done leaves `out` on the clipboard and says so. */
export async function sayLine({ keys, clipboard, out, channel = 'team', note = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)), patienceMs = 15000, now = () => Date.now() }) {
  const before = clipboard.readText();
  const leave = (why) => {
    clipboard.writeText(out);
    note({ kind: 'note', text: out, more: '- not sent (' + why + '). Ctrl+V pastes it' });
    return { said: false, why, out };
  };
  // Is the player typing something of their own? Ctrl+A, Ctrl+C gives it;
  // a closed chat (or an empty one) gives nothing.
  const end = now() + patienceMs;
  for (;;) {
    clipboard.writeText('');
    const r = await keys.copy();
    const theirs = r.ok ? String(clipboard.readText() || '').trim() : '';
    if (r.ok && !theirs) break;
    if (!r.ok && !/not in front|still held/.test(String(r.why))) return leave(r.why);
    if (theirs) clipboard.writeText('');
    if (now() >= end) return leave(r.ok ? 'you were typing' : r.why);
    await wait(400);
  }
  // Twice at most: an EMPTY open chat looks like a closed one, and the
  // app's Enter then closes it - the check below sees that and opens again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = await keys.open(channel);
    if (!opened.ok) return leave(opened.why);
    clipboard.writeText(out);
    const pasted = await keys.paste();
    if (!pasted.ok) return leave(pasted.why);
    clipboard.writeText('');
    const check = await keys.copy();
    const there = check.ok ? String(clipboard.readText() || '').trim() : '';
    // The game's field may keep only the start of a long line: that is it too.
    if (there && String(out).trim().startsWith(there)) {
      const sent = await keys.enter();
      if (!sent.ok) return leave(sent.why);
      await wait(150);
      clipboard.writeText(before);
      return { said: true, out };
    }
    if (!check.ok) return leave(check.why);
    // Something else is in the chat: Enter would SEND it. Stop.
    if (there) return leave('the chat held something else');
  }
  return leave('the chat would not open');
}
