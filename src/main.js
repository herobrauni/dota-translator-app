// The overlay. A transparent, always on top, click-through window laid
// over the game. Dota must run in borderless windowed for anything to
// show above it: an exclusive fullscreen game owns the screen and no
// window can sit on it.

import { app, BrowserWindow, screen, ipcMain, globalShortcut, safeStorage, shell, Tray, Menu, nativeImage, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// On Linux under Wayland, Chromium's native Wayland backend forbids global shortcuts
// and absolute window positioning. Running via Xwayland (ozone platform x11) enables
// both. Re-launch with the flag if started without it.
if (process.platform === 'linux' &&
    process.env.DISPLAY &&
    process.env.ELECTRON_OZONE_PLATFORM_HINT !== 'x11' &&
    !process.argv.includes('--ozone-platform=x11')) {
  const binary = process.env.APPIMAGE || process.execPath;
  const child = spawn(binary, ['--ozone-platform=x11', ...process.argv.slice(1)], {
    env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: 'x11' },
    detached: true,
    stdio: 'inherit'
  });
  child.unref();
  process.exit(0);
}
import { loadConfig, saveConfig, onDisk, CONFIG_PATH, DATA_DIR, NO_KEY } from './config.js';
import { faces } from './heroface.js';
import { createPatchWatch, SLOW_TEXT } from './patchwatch.js';
import { uiSettings, settingsPatch, LANGUAGES, THEIRS } from './settings.js';
import { checkKey, tidyKey } from './keycheck.js';
import updater from 'electron-updater';
import { startWatching } from './watcher.js';
import { explainModelError } from './memwatcher.js';
import { startWatchingGsi } from './gsiwatcher.js';
import { loadOffsets, bundledOffsets } from './offsets.js';
import { createOutgoing, createLanguageTracker, targetLanguage } from './outgoing.js';
import { createKeySender, sayTranslated, takeLine, sayLine } from './sendchat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The first start ever (no settings file yet) shows the window once: it says
// the app is ready and that Dota must be restarted once for its chat feed.
const firstRun = !fs.existsSync(CONFIG_PATH);
let firstShown = false;
const cfg = loadConfig();
let win = null;
let watcher = null;
let hidden = false;
let inFront = true;

// Where the chat box goes. A corner by default; boxX / boxY, as fractions
// of the screen (0-1) from its top-left, put it anywhere - which is what
// laying it OVER the game's own chat will need, later.
function place(bounds, c = cfg) {
  const w = Math.round(c.boxWidth);
  const h = Math.min(bounds.height - 80, 40 + c.maxLines * 52);
  const pad = 24;
  const right = c.position.endsWith('right');
  const bottom = c.position.startsWith('bottom') || c.position === 'chat';
  if (c.position === 'chat' && !(c.boxX >= 0 && c.boxY >= 0)) {
    // Directly above the game's own chat, growing upwards, so the English
    // is read where the eye already goes for chat. MEASURED on a 5120x1440
    // screen: Dota lays its HUD out in a centred 16:9 area, and its chat
    // lines begin 0.31 of the way across that area and sit between 0.64
    // and 0.70 of the way down the screen. NOT checked at 16:9, 16:10 or
    // 4:3, nor with the HUD flipped (minimap on the right).
    const hudW = Math.min(bounds.width, Math.round(bounds.height * 16 / 9));
    const hudX = bounds.x + Math.round((bounds.width - hudW) / 2);
    return { x: hudX + Math.round(0.31 * hudW), y: bounds.y + Math.round(0.625 * bounds.height) - h, width: w, height: h };
  }
  if (c.boxX >= 0 && c.boxY >= 0) {
    return {
      x: Math.round(bounds.x + c.boxX * bounds.width),
      // Bottom-anchored, boxY is where the box ENDS: it grows upwards.
      y: Math.round(bounds.y + c.boxY * bounds.height - (bottom ? h : 0)),
      width: w,
      height: h,
    };
  }
  return {
    x: bounds.x + (right ? bounds.width - w - pad : pad),
    // 150 down, not 40: Dota keeps K/D/A and last hits in its top-left.
    y: bounds.y + (bottom ? bounds.height - h - pad : pad + 150),
    width: w,
    height: h,
  };
}

function createWindow() {
  // The whole display, not the work area: a borderless game covers the
  // taskbar, and the box is placed against the game.
  const area = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    ...place(area),
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true },
  });
  // "screen-saver" is the level that stays above a borderless game; the
  // default "floating" loses to it.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (cfg.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(here, 'overlay.html'));
  // On every load, not once: changing the look in the setup window reloads
  // this page, and a fresh page knows nothing.
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('config', {
      holdSeconds: cfg.holdSeconds,
      maxLines: cfg.maxLines,
      showOriginal: cfg.showOriginal,
      showHeroes: cfg.showHeroes,
      fontSize: cfg.fontSize,
      opacity: cfg.opacity,
      position: cfg.position,
      display: cfg.display,
      fadeWithGame: cfg.fadeWithGame,
      textLeft: TEXT_LEFT,
    });
    if (lastFonts) win.webContents.send('fonts', lastFonts);
    if (!started) { started = true; start(); }
  });
}

let started = false;
let lastFonts = '';
// The game's own hero portraits, from the player's install (src/heroface.js).
// Until the game's folder is known, and for any hero it cannot give, the
// overlay uses the picture on Valve's web server - which is NOT the same one.
const patchWatch = createPatchWatch({
  onSlow: () => {
    send('status', { kind: 'error', text: SLOW_TEXT });
    if (tray) tray.setToolTip('Dota Translator ' + app.getVersion() + ' - slow mode: waiting for a fix for the new Dota build');
  },
  onFast: () => { if (tray) tray.setToolTip('Dota Translator ' + app.getVersion()); },
});
let faceOf = () => null;
const withFace = (row) => (cfg.showHeroes && row && row.hero ? { ...row, face: faceOf(row.hero) } : row);

// The look changed in the setup window: put the window back where that
// look wants it and start its page again, clean.
function applyDisplay(display) {
  if (display === cfg.display || !win || win.isDestroyed()) { cfg.display = display; return; }
  cfg.display = display;
  coverAt = '';
  win.setBounds(place(screen.getPrimaryDisplay().bounds));
  win.reload();
}

// DT_DEBUG=1 prints everything sent to the chat box, for the day it shows
// nothing and the question is whether it was ever told anything.
const DEBUG = Boolean(process.env.DT_DEBUG);

// COVER mode: the window is laid exactly over the game's own chat lines,
// from where the GAME says they are. MEASURED on 5120x1440 (scale 1.33):
// the line box begins 42px right of HudChat's x and the newest line ends
// 187px below HudChat's y - 31.5 and 140 in the 1080-high units Dota's
// layout is written in, which is why they are multiplied by the scale
// the game reports rather than kept as pixels. NOT checked on any other
// screen; that they are layout constants is the bet.
// The three that were calibrated by eye live in offsets.json with the
// memory offsets, for the same reason: if a patch restyles the chat they
// are fixed by a commit there. These are what shipped, until it is read.
let { chatLeft: CHAT_LEFT, chatBottom: CHAT_BOTTOM, chatHigh: CHAT_HIGH, textLeft: TEXT_LEFT } = bundledOffsets().layout;
const LINE_BOX = 1000, ROWS_HIGH = 340;
// ABOVE mode: the same place, one chat-height higher. The game draws its
// chat in a window 216px high at scale 1.33 (162 units: six lines, which
// is also what it shows when the chat is OPENED), so a box that ends
// where that window begins has nothing of the game's under it, ever -
// which is the whole reason for it. Laying English OVER the lines worked
// but needed a strip to hide the Russian, a guess at when the game's line
// fades (wrong once already), and a signal for the opened chat that was
// not found.
const GAP = 4;
let coverAt = '';

function coverBounds(l) {
  const lift = cfg.display === 'above' ? CHAT_HIGH + GAP : 0;
  const px = {
    x: Math.round(l.x + CHAT_LEFT * l.scale),
    y: Math.round(l.y + (CHAT_BOTTOM - ROWS_HIGH - lift) * l.scale),
    width: Math.round(LINE_BOX * l.scale),
    height: Math.round(ROWS_HIGH * l.scale),
  };
  // The game speaks in screen pixels and Electron in scaled ones; they
  // differ whenever Windows display scaling is not 100%.
  return screen.screenToDipRect ? screen.screenToDipRect(null, px) : px;
}

function onLayout(l) {
  if ((cfg.display !== 'cover' && cfg.display !== 'above') || !win || win.isDestroyed()) return;
  const b = coverBounds(l);
  const key = [b.x, b.y, b.width, b.height].join();
  if (key !== coverAt) { coverAt = key; win.setBounds(b); }
  // The renderer works in ITS pixels: the scale it needs is the game's
  // scale shrunk by whatever Windows scaling stretched the window by.
  const dip = b.width / Math.round(LINE_BOX * l.scale);
  send('layout', { rows: l.rows.map((r) => ({ ...r, height: r.height * dip, width: r.width * dip })), scale: l.scale * dip });
}

function send(channel, payload) {
  if (DEBUG && channel !== 'seen' && (channel !== 'status' || payload.text)) console.log(new Date().toISOString().slice(11, 23), channel, JSON.stringify(payload));
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function restartWatcher() {
  if (watcher) { watcher.stop(); watcher = null; }
  start();
}

async function start() {
  // A few seconds at most, and never fatal: see src/offsets.js.
  if (!cfg.offsets) cfg.offsets = await loadOffsets({ url: cfg.offsetsUrl });
  ({ chatLeft: CHAT_LEFT, chatBottom: CHAT_BOTTOM, chatHigh: CHAT_HIGH, textLeft: TEXT_LEFT } = cfg.offsets.layout);
  send('config', { textLeft: TEXT_LEFT });
  if (DEBUG) console.log('offsets', cfg.offsets.source, 'v' + cfg.offsets.version, cfg.offsets.updated);
  // Ready = a key of the player's own (0.8.0: the only translator). Not an
  // error to be read off an overlay: a window that asks for it, and one line
  // on the overlay for when the game is in front. The first start ever shows
  // the window once either way, and goes on if ready.
  cfg.geminiApiKey = storedKey();
  const ready = hasKey();
  if (!ready || (firstRun && !firstShown)) {
    firstShown = true;
    openSetup();
    if (!ready) { noKeyNotice(); return; }
  }
  if (cfg.display === 'replace') {
    send('status', { kind: 'error', text: 'Replacing the game chat in place is not built yet - using the chat box.' });
  }
  // 'memory' reads the running game, which is the only place the chat
  // actually is; 'log' is the old console.log reader, kept as a fallback.
  // Never the memory reader: see DEFAULTS.source.
  const start = cfg.source === 'log' ? startWatching : startWatchingGsi;
  watcher = start(cfg, {
    onStatus: (s) => {
      // The one thing about how the app is getting on that IS the player's
      // business: a Dota patch has put it into slow mode (src/patchwatch.js).
      if (s && s.kind === 'find' && s.find) patchWatch.find(s.find.panels);
      if (s && s.kind === 'waiting') patchWatch.reset();
      send('status', s);
    },
    onPending: (row) => { spoken.saw(row.text); traceSayInto('line'); itsMe(row); send('pending', withFace(row)); },
    onLayout,
    // Who the player is, from the feed: replaces whatever an earlier game taught.
    onSelf: (self) => { me = self && self.name ? { name: self.name, slot: self.slot, hero: self.hero } : null; },
    // GSI mode only: where the game's window is. The dark box is then placed
    // in IT, not on the screen (a windowed game had the box on the desktop).
    onWindow: (w) => {
      if (cfg.display === 'above' || cfg.display === 'cover' || !win || win.isDestroyed()) return;
      const px = { x: w.x, y: w.y, width: w.w, height: w.h };
      const b = place(screen.screenToDipRect ? screen.screenToDipRect(null, px) : px);
      const key = [b.x, b.y, b.width, b.height].join();
      if (key !== coverAt) { coverAt = key; win.setBounds(b); }
    },
    onSeen: (s) => { if (cfg.display === 'cover') send('seen', s); },
    // The game's chat is set in Valve's Radiance, which is not on anybody's
    // machine except inside the game. It is loaded from THERE - the
    // player's own copy - and never copied into this repo.
    onGamePath: (exe) => {
      // dota2.exe is in game/bin/win64; the fonts are in game/dota/panorama/fonts.
      const dir = path.resolve(path.dirname(exe), '..', '..', 'dota', 'panorama', 'fonts');
      faceOf = faces(path.resolve(path.dirname(exe), '..', '..', 'dota'));
      if (fs.existsSync(path.join(dir, 'radiance-bold.otf'))) { lastFonts = pathToFileURL(dir).href; send('fonts', lastFonts); }
    },
    // Up only while the game is the window in front.
    onFocus: (on) => {
      setSayHotkey(on);
      // Enter is held only while Dota is in front, never over another program.
      if (!on && enterHeld) { globalShortcut.unregister('Enter'); enterHeld = false; }
      inFront = on;
      if (!win || win.isDestroyed() || hidden) return;
      if (on) win.showInactive(); else win.hide();
    },
    onResult: (row) => { spoken.saw(row.text); traceSayInto('line'); itsMe(row); send('line', withFace(row)); },
  });
}

// ---- SAYING SOMETHING BACK -------------------------------------------
// Asked for by the first players who saw the app: their own English, in
// the language the others type in (src/outgoing.js).
//
// The player types English into the game's OWN chat field and presses
// this key instead of Enter. The app then presses keys, as a keyboard
// would (src/sendchat.ps1): Ctrl+A, Ctrl+C to take what was typed;
// it is translated; Ctrl+A, Ctrl+V, Enter to put the translation in its
// place and say it. Team or all chat is whichever the player opened.
//
// It is INPUT and nothing else. Nothing is written to the game's memory,
// and the game's process is not even opened for this. (The user asked
// about writing the field in memory instead, 2026-09-21; it would not
// have been quicker - the game sends on Enter, the model needs a second -
// and it is the one thing this app has never done.) A first version was a
// window of its own and the clipboard only; the user found that five
// keypresses and two waits for one line, and it took the keyboard off the
// game besides.
//
// The key exists ONLY while Dota is the window in front. Ctrl+Enter is
// "send" in half the programs on a PC, and a global shortcut swallows the
// key from whatever has the keyboard.
// ---- THE KEY (0.8.0) -----------------------------------------------------
// Every translation is one call to Google's Gemini with the player's OWN
// key, straight from this PC. Nothing goes anywhere else. The key the window
// saves is encrypted by Windows for this user (safeStorage = DPAPI); a plain
// geminiApiKey in config.json, or GEMINI_API_KEY, still works and wins.
function storedKey() {
  if (cfg.geminiApiKeyPlain) return cfg.geminiApiKeyPlain;
  if (!cfg.geminiApiKeyEnc || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(cfg.geminiApiKeyEnc, 'base64')); } catch { return ''; }
}
cfg.geminiApiKeyPlain = cfg.geminiApiKey;
const hasKey = () => Boolean(cfg.geminiApiKey);
// With no key, once in half an hour: the one thing the overlay says about it.
let lastNoKey = 0;
function noKeyNotice() {
  if (hasKey() || Date.now() - lastNoKey < 30 * 60000) return;
  lastNoKey = Date.now();
  send('status', { kind: 'error', text: NO_KEY });
}

const spoken = createLanguageTracker({ fallback: THEIRS.includes(cfg.theirLanguage) ? cfg.theirLanguage : 'Russian' });
// DT_DEBUG only: which language Ctrl+Enter would write NOW, printed when it
// changes and after every settings click - how the language switches are
// tested end to end without a game (Ctrl+Enter itself needs Dota in front).
let lastSayInto = '';
function traceSayInto(why, force = false) {
  if (!DEBUG) return;
  const into = targetLanguage(cfg.replyLanguage, spoken);
  if (!force && into === lastSayInto) return;
  lastSayInto = into;
  console.log(new Date().toISOString().slice(11, 23), 'say-into', JSON.stringify({ into, why, theirLanguage: cfg.theirLanguage, replyLanguage: cfg.replyLanguage, scripts: cfg.scripts }));
}
traceSayInto('start', true);
// What has been said before is said the same way again: said.json, beside
// the settings, English -> what was sent. The player can read and correct it.
const SAID_PATH = path.join(DATA_DIR, 'said.json');
const sayIt = createOutgoing({
  apiKey: () => cfg.geminiApiKey, model: () => cfg.model,
  // A file that will not parse (a crash mid-save, a hand edit gone wrong) is
  // kept beside it as said.broken.json and the app starts afresh - it never
  // stops saving for good (a review, 2026-09-23).
  store: { read: () => { const text = fs.readFileSync(SAID_PATH, 'utf8').replace(/^\uFEFF/, ''); try { return JSON.parse(text); } catch { try { fs.copyFileSync(SAID_PATH, SAID_PATH.replace(/\.json$/, '.broken.json')); } catch { /* nothing to keep */ } return {}; } }, write: (all) => fs.writeFileSync(SAID_PATH, JSON.stringify(all, null, 2)) },
});
const keys = createKeySender();
let sayKeyOn = false;
let saying = false;
let enterHeld = false;
// WHO the player is, learnt from the game: a line that comes back out of
// the chat with the words the app has just sent for them is THEIR line,
// and carries their name, colour slot and hero. Known from their first
// translated message of a match; a new hero next match replaces it.
let me = null;
const sentForMe = new Set();
function itsMe(row) {
  if (!row || !sentForMe.has(row.text)) return;
  me = { name: row.name, slot: row.slot, hero: row.hero };
}

// Ctrl+Enter says the line in team chat, Ctrl+Shift+Enter in all chat - as
// Enter and Shift+Enter open them. The app cannot see which one the player
// opened, so the key says it.
const sayKeys = () => [[cfg.sayHotkey, 'team'], [cfg.sayAllHotkey, 'all']].filter(([k]) => k && typeof k === 'string');
function setSayHotkey(on) {
  if (!cfg.sayHotkey || on === sayKeyOn) return;
  for (const [accel, channel] of sayKeys()) {
    try {
      if (on) globalShortcut.register(accel, () => sayKey(channel));
      else globalShortcut.unregister(accel);
    } catch { /* not a key Electron knows: that one is not there, and nothing else breaks */ }
  }
  sayKeyOn = on;
  if (on) keys.warm();
}

// One key, and a SETTING for which way it goes (the user: "better with
// setting, but same hotkeys"): replyLanguage "auto" sends the line in the
// language the others type in, Russian by default; "English" sends it in
// English whatever it was typed in - for the player on the other side of
// the same problem, typing Russian to English speakers. Read at each press,
// so changing it in the setup window needs no restart.
// What a line the app said for the player MEANS, handed to the reader
// before the keys that say it (it finds the line in ~0.2s).
function learnedLine(out, typed) {
  // SEEN 2026-09-22: Russian pasted and sent with this key goes out
  // unchanged, and "it means what was typed" then told the reader that
  // Russian means Russian - the player's own line was never translated.
  if (watcher && watcher.know && out.trim() !== typed.trim()) watcher.know(out, typed);
  sentForMe.add(out);
  if (sentForMe.size > 50) sentForMe.delete(sentForMe.values().next().value);
}

// THE DEFAULT (sayMode "close"; the user, 2026-09-27): the chat is closed at
// once and the line said when it is translated. Lines are said in the
// order they were taken; each is translated as soon as it is taken.
let sayChain = Promise.resolve();
function sayClosing(asked) {
  const into = targetLanguage(cfg.replyLanguage, spoken);
  const note = (s) => send('status', withFace(s));
  // Which chat was open, read off the screen BEFORE the chat is closed (the
  // user, 2026-09-27: Ctrl+Enter in all chat went to the team). Not sure -
  // no answer in 250ms, another language, the grab off - and the key decides.
  // Ctrl+Shift+Enter says all chat whatever is open.
  let channel = asked;
  const seen = asked !== 'all' && watcher && watcher.channel ? Promise.race([watcher.channel().catch(() => null), new Promise((r) => setTimeout(() => r(null), 250))]) : Promise.resolve(null);
  const taken = seen.then((c) => { if (c) channel = c; if (DEBUG) console.log('say channel', JSON.stringify({ asked, seen: c })); return takeLine({ keys, clipboard }); });
  const ARROW = String.fromCharCode(0x2192), DOTS = String.fromCharCode(0x2026);
  const translated = taken.then(async (t) => {
    if (!t.typed) return { t };
    note({ kind: 'note', text: t.typed, more: ARROW + ' ' + into + DOTS, holdMs: 20000, ...(me && me.name ? { name: me.name, slot: me.slot, hero: me.hero } : {}) });
    try { return { t, r: await sayIt(t.typed, into) }; } catch (err) { return { t, err }; }
  });
  sayChain = sayChain.then(async () => {
    const { t, r, err } = await translated;
    if (!t.typed) { if (DEBUG) console.log('say', JSON.stringify({ said: false, why: t.why })); return; }
    if (err) {
      const why = String((err && err.message) || err);
      const said = explainModelError(why);
      clipboard.writeText(t.typed);
      note({ kind: 'error', text: (said === why ? 'Not translated (' + why + ').' : said.split(' Lines are shown')[0] + ' Not translated.') + ' Your line is on the clipboard - Ctrl+V pastes it.' });
      if (DEBUG) console.log('say', JSON.stringify({ said: false, why }));
      return;
    }
    try { learnedLine(r.out, t.typed); } catch { /* the line is still said */ }
    const done = await sayLine({ keys, clipboard, out: r.out, channel, note });
    if (done.said) note({ kind: 'note', text: '' });
    if (DEBUG) console.log('say', JSON.stringify({ ...done, typed: t.typed, channel }));
  }).catch(() => {});
}

async function sayKey(channel = 'team') {
  if (!hasKey()) { lastNoKey = 0; noKeyNotice(); return; }
  if (cfg.sayMode !== 'open') { sayClosing(channel); return; }
  if (saying) return;
  saying = true;
  try {
    const into = targetLanguage(cfg.replyLanguage, spoken);
    const r = await sayTranslated({
      keys, clipboard, into, explain: explainModelError,
      // The line comes back out of the chat within a moment: it means what was typed.
      learned: learnedLine,
      who: () => me,
      // An Enter pressed while the line is away is swallowed, not sent.
      hold: (on) => {
        if (on) { try { enterHeld = globalShortcut.register('Enter', () => {}); } catch { enterHeld = false; } }
        else if (enterHeld) { globalShortcut.unregister('Enter'); enterHeld = false; }
      },
      translate: (typed) => sayIt(typed, into),
      note: (s) => send('status', withFace(s)),
    });
    if (DEBUG) console.log('say', JSON.stringify(r));
  } finally { saying = false; }
}

// ---- UPDATES ---------------------------------------------------------
// The INSTALLED app keeps itself up to date from the project's GitHub
// releases (the user asked: "the app should auto update when start"). It
// looks once at startup, downloads a newer version quietly in the
// background and installs it when the app is next closed - never in the
// middle of a match, and never with a dialog over the game. Run from
// source there is nothing to update and nothing is asked.
// What the settings window shows about it (the user, 2026-09-22: an
// indicator that this copy is up to date). `status`: source (run from
// source, nothing to check), off (autoUpdate false), checking, latest,
// downloading, ready (installs when the app quits), error.
const updateState = { status: app.isPackaged ? (cfg.autoUpdate === false ? 'off' : 'checking') : 'source', version: app.getVersion(), latest: '', checked: 0 };
function setUpdate(patch) {
  Object.assign(updateState, patch);
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('update', updateState);
}
let lookForUpdate = () => {};
function checkForUpdates() {
  if (!app.isPackaged || cfg.autoUpdate === false) return;
  const { autoUpdater } = updater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-not-available', (info) => setUpdate({ status: 'latest', latest: info && info.version || app.getVersion(), checked: Date.now() }));
  autoUpdater.on('update-available', (info) => setUpdate({ status: 'downloading', latest: info.version, checked: Date.now() }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('error', (err) => { setUpdate({ status: 'error', checked: Date.now() }); if (DEBUG) console.log('update:', String((err && err.message) || err)); });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdate({ status: 'ready', latest: info.version, checked: Date.now() });
    if (tray) tray.setToolTip('Dota Translator - version ' + info.version + ' installs when you quit');
  });
  const look = () => autoUpdater.checkForUpdates().catch(() => { /* offline, or no release yet: next time */ });
  lookForUpdate = look;
  look();
  // And again every few hours. It used to look ONCE, at startup - and the
  // user's own copy, started before three releases came out and left
  // running, never heard of any of them. An app that lives in the tray is
  // started once a day at most, or once a week.
  setInterval(look, 4 * 60 * 60 * 1000).unref();
}

// One copy only: two would translate every line twice on one key (the
// 15-a-minute limit), and a player who cannot find the tray icon starts
// the app again - which should show them the window, not a second app.
const onlyCopy = app.requestSingleInstanceLock();
if (!onlyCopy) app.quit();
app.on('second-instance', openSetup);

app.whenReady().then(() => {
  if (!onlyCopy) return;
  createWindow();
  checkForUpdates();
  makeTray();
  setAppKeys();
});

// The app's own keys: hide/show (Alt+D by default - a screenshot, a clear view
// of a fight) and quit (Alt+Shift+D). The player's to change or turn off in
// the settings window: a key registered here is taken from every program,
// Dota included (a player, 2026-09-28: Alt+D is their alt-cast).
const appKeys = new Map();
function setAppKeys() {
  const want = [[cfg.hideHotkey, toggleHidden], [cfg.quitHotkey, quitApp]];
  for (const accel of appKeys.keys()) { try { globalShortcut.unregister(accel); } catch { /* not ours any more */ } }
  appKeys.clear();
  for (const [accel, fn] of want) {
    if (!accel || typeof accel !== 'string') continue;
    try { if (globalShortcut.register(accel, fn)) appKeys.set(accel, fn); } catch { /* not a key Electron knows: skipped */ }
  }
  if (tray) tray.setContextMenu(trayMenu());
}
const pretty = (accel) => String(accel || '').replace('Control', 'Ctrl');

// ---- THE SETUP WINDOW ------------------------------------------------
// Where a player gives the app its key without ever seeing config.json
// (the user, 2026-09-20: "simpler for non techie user to just enter api
// key in the ui"). It opens by itself when there is no key, and from the
// tray icon after that. The key is TRIED before it is saved - one real
// translation - so "saved" means "works", and it is stored encrypted by
// Windows for this user (safeStorage = DPAPI) rather than in plain text.
// Feedback goes to the support address, by e-mail.
const FEEDBACK_URL = 'https://forms.gle/4UwGB5drooGT4mUB9';
let setupWin = null;
let tray = null;
// The balloon's picture is OUR icon, said outright: left to Windows it showed
// the icon it had cached from an older install (the user, 2026-09-22: 'the
// old translator logo is used').
const balloonIcon = () => nativeImage.createFromPath(path.join(here, 'balloon.png'));



// The window on TOP, whatever is in front. Windows refuses a background app
// the focus (the user, 2026-09-22: it opened behind Chrome, and they had to
// minimise Chrome to find it), so it is made topmost for a moment.
function surface(w) {
  w.show();
  w.setAlwaysOnTop(true);
  w.moveTop();
  w.focus();
  app.focus({ steal: true });
  // And it STAYS on top while it is open. A timer was not enough (SEEN: up
  // for a blink, then behind Chrome again), nor was until-blur (the user:
  // 'it goes back the moment I move my mouse towards the browser'). It is
  // small and has a Close button.
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) { surface(setupWin); return; }
  setupWin = new BrowserWindow({
    // Wide enough that nothing wraps awkwardly; the HEIGHT is whatever the
    // page turns out to need (fitSetup) - a fixed one was a guess, and the
    // guess was short: the window scrolled.
    width: 680, height: 720, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false,
    title: 'Dota Translator', backgroundColor: '#0a0d10', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(here, 'setup-preload.cjs'), contextIsolation: true, sandbox: true },
  });
  setupWin.removeMenu();
  setupWin.loadFile(path.join(here, 'setup.html'));
  setupWin.once('ready-to-show', async () => { await fitSetup(); if (setupWin && !setupWin.isDestroyed()) surface(setupWin); });
  // Nothing in this window goes anywhere but the page it was given.
  setupWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWin.webContents.on('will-navigate', (e) => e.preventDefault());
  // Closing the window is not quitting: say where the app went (the user
  // asked, 2026-09-22), unless the close IS a quit.
  setupWin.on('close', () => {
    if (quitting || !tray) return;
    tray.displayBalloon({ iconType: 'custom', icon: balloonIcon(), title: 'Still running in the tray', content: 'Dota Translator keeps working by the clock (behind the ^ arrow). Click its icon for settings, right-click to quit.' });
  });
  setupWin.on('closed', () => { setupWin = null; });
}

// Make the setup window exactly as tall as its page, capped to the screen.
// Asked again when the page says its content changed (a result appearing).
async function fitSetup() {
  if (!setupWin || setupWin.isDestroyed()) return;
  try {
    const want = await setupWin.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
    const room = screen.getPrimaryDisplay().workAreaSize.height - 60;
    const [w] = setupWin.getContentSize();
    setupWin.setContentSize(w, Math.max(400, Math.min(want, room)));
    // DT_SHOT=<file>: the window photographs itself - the only way to look
    // at it while a game covers the screen.
    if (process.env.DT_SHOT_MORE && !fitSetup.opened) { fitSetup.opened = true; setupWin.webContents.executeJavaScript('document.getElementById("more").open = true'); return; }
    if (process.env.DT_SHOT) setTimeout(async () => { try { fs.writeFileSync(process.env.DT_SHOT, (await setupWin.webContents.capturePage()).toPNG()); } catch { /* closed */ } }, 600);
    if (DEBUG) console.log('setup window: page needs', want, 'screen allows', room, '-> content', setupWin.getContentSize().join('x'));
    // Centred when it opens; after that it stays where the player put it,
    // only nudged back up if it grew past the bottom of the screen.
    if (!setupWin.placed) { setupWin.center(); setupWin.placed = true; } else {
      const b = setupWin.getBounds(), area = screen.getDisplayMatching(b).workArea;
      if (b.y + b.height > area.y + area.height) setupWin.setBounds({ ...b, y: Math.max(area.y, area.y + area.height - b.height) });
    }
  } catch { /* closed meanwhile */ }
}
ipcMain.handle('setup:fit', fitSetup);

function makeTray() {
  // The app's own icon: an amber square with a D (docs/logo.svg, rendered
  // by tools/makeicons.mjs) - NOT Dota's logo, which is Valve's trademark
  // and not ours to use.
  tray = new Tray(nativeImage.createFromPath(path.join(here, 'tray.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Dota Translator ' + app.getVersion());
  tray.setContextMenu(trayMenu());
  tray.on('click', openSetup);
  // With a key there is no window at all at startup, and Windows hides a
  // new tray icon behind the ^ arrow: say where the app went. A balloon
  // takes no focus, and Windows holds it back itself over a fullscreen game.
  if (hasKey()) {
    tray.displayBalloon({ iconType: 'custom', icon: balloonIcon(), title: 'Dota Translator is running', content: 'It sits here by the clock (behind the ^ arrow) and shows translations above the chat in Dota. Click the icon for settings.' });
    tray.on('balloon-click', openSetup);
  }
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Settings and key...', click: openSetup },
    { label: 'Hide or show the translations' + (cfg.hideHotkey ? ' (' + pretty(cfg.hideHotkey) + ')' : ''), click: toggleHidden },
    ...(cfg.sayHotkey ? [{ label: cfg.sayHotkey.replace('Control', 'Ctrl') + ' in Dota\'s chat sends it translated', enabled: false }] : []),
    ...(cfg.sayHotkey && cfg.sayAllHotkey ? [{ label: cfg.sayAllHotkey.replace('Control', 'Ctrl') + ' sends it to all chat', enabled: false }] : []),
    // The way a player says anything back. cfg.feedbackUrl (https or mailto) overrides it.
    { label: 'Send feedback, or report a bad translation...', click: () => shell.openExternal(/^(https|mailto):/.test(String(cfg.feedbackUrl || '')) ? cfg.feedbackUrl : FEEDBACK_URL) },
    { label: 'Version ' + app.getVersion(), enabled: false },
    { type: 'separator' },
    { label: 'Quit' + (cfg.quitHotkey ? ' (' + pretty(cfg.quitHotkey) + ')' : ''), click: quitApp },
  ]);
}

function toggleHidden() {
  if (!win || win.isDestroyed()) return;
  hidden = !hidden;
  if (hidden) win.hide(); else if (inFront) win.showInactive();
}

ipcMain.handle('setup:state', () => ({ version: app.getVersion(), update: updateState, hasKey: hasKey(), display: cfg.display, settings: uiSettings(cfg), languages: LANGUAGES }));
// The key, from the settings window. It is TRIED with one real translation
// before it is saved (src/keycheck.js): saved means works. The key itself is
// never handed back to the page - only whether there is one.
ipcMain.handle('setup:guide', () => {
  // The live page, not a copy in the app: a file:// address looks wrong in a
  // browser, and a key is no use offline anyway.
  shell.openExternal('https://dotatranslator.live/key.html');
});
ipcMain.handle('setup:key', async (_e, typed) => {
  const key = tidyKey(typed);
  if (!key) return { ok: false, why: 'Paste your Gemini API key first.' };
  const r = await checkKey(key, { model: cfg.model });
  if (!r.ok) return { ok: false, why: r.why };
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const patch = canEncrypt ? { geminiApiKeyEnc: safeStorage.encryptString(r.key).toString('base64'), geminiApiKey: '' } : { geminiApiKey: r.key };
  saveConfig(patch);
  Object.assign(cfg, patch);
  cfg.geminiApiKeyPlain = canEncrypt ? '' : r.key;
  cfg.geminiApiKey = r.key;
  if (tray) tray.setContextMenu(trayMenu());
  restartWatcher();
  return { ok: true, hasKey: true, sample: r.sample, en: r.en };
});

ipcMain.handle('setup:folder', () => {
  // The file may not exist yet on a fresh install: make it, so that there
  // is something in the folder to find.
  if (!fs.existsSync(CONFIG_PATH)) saveConfig({});
  shell.showItemInFolder(CONFIG_PATH);
});

// The five settings the window offers, applied to the running app: the
// overlay's page is reloaded (it is told its settings on every load) and
// the reader restarted if WHICH LANGUAGES changed, since that is decided
// where the lines are read.
function applySettings(patch) {
  const languagesChanged = patch.scripts && JSON.stringify(patch.scripts) !== JSON.stringify(cfg.scripts);
  // Another reader altogether: the watcher starts again with it.
  const sourceChanged = Boolean(patch.source) && patch.source !== cfg.source;
  const keysChanged = ('hideHotkey' in patch && patch.hideHotkey !== cfg.hideHotkey) || ('quitHotkey' in patch && patch.quitHotkey !== cfg.quitHotkey);
  Object.assign(cfg, patch);
  if (keysChanged) setAppKeys();
  if (win && !win.isDestroyed()) win.reload();
  return languagesChanged || sourceChanged;
}
// Which way Ctrl+Enter translates is saved THE MOMENT IT IS CLICKED, not on
// Save. The user picked "in English", closed the window, and Russian kept
// coming out as Russian "with both settings": config.json had not been
// written since the day before. A choice that looks made should be made.
ipcMain.handle('setup:sayInto', (_e, which) => {
  const patch = settingsPatch({ sayInto: which }, cfg);
  if (Object.keys(patch).length) { saveConfig(patch); Object.assign(cfg, patch); }
  traceSayInto('setup:sayInto', true);
  return { sayInto: uiSettings(cfg).sayInto };
});
ipcMain.handle('setup:theirs', (_e, which) => {
  const patch = settingsPatch({ theirLanguage: which }, cfg);
  if (Object.keys(patch).length) {
    saveConfig(patch); Object.assign(cfg, patch);
    spoken.choose(cfg.theirLanguage);
    if (patch.scripts) restartWatcher();
  }
  traceSayInto('setup:theirs', true);
  return uiSettings(cfg);
});
ipcMain.handle('setup:update', () => { lookForUpdate(); return updateState; });
ipcMain.handle('setup:quitInstall', quitApp);
ipcMain.handle('setup:close', () => { if (setupWin && !setupWin.isDestroyed()) setupWin.close(); });
ipcMain.handle('setup:save', async (_e, payload) => {
  const display = payload && payload.display === 'box' ? 'box' : 'above';
  const patch = settingsPatch(payload && payload.settings, cfg);
  saveConfig({ display, ...patch });
  const restart = applySettings(patch);
  traceSayInto('setup:save', true);
  applyDisplay(display);
  if (restart) restartWatcher();
  return { ok: true, settings: uiSettings(cfg) };
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keys.stop();
  if (watcher) watcher.stop();
});

app.on('window-all-closed', () => app.quit());
ipcMain.on('quit', quitApp);

// Quitting with an update ready INSTALLS it and STARTS the new version. Left
// to electron-updater's own quit handler the install is silent and the app
// stays closed (SEEN: the user's copy 'just closed after updating and I had
// to manually reopen').
let quitting = false;
function quitApp() {
  quitting = true;
  if (updateState.status === 'ready') {
    try { updater.autoUpdater.quitAndInstall(true, true); return; } catch { /* then a plain quit */ }
  }
  app.quit();
}
