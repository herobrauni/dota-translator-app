// The file that tells Dota to send its state here. Game State Integration
// is Valve's documented feed: a cfg in game/dota/cfg/gamestate_integration
// names an address and the sections wanted, and the game POSTs to it.
// Dota reads these files ONLY AT LAUNCH, so a newly written one does nothing
// until the game has been restarted - the caller says so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CFG_NAME = 'gamestate_integration_dotatranslator.cfg';

// provider/map say which match; player/hero who the player is (and, for a
// spectator, who everybody is); events is where the chat is.
export function gsiConfigText(port) {
  return [
    '"Dota Translator - sends chat to the app on this PC. Safe to delete."',
    '{',
    `    "uri"           "http://127.0.0.1:${Number(port)}/"`,
    '    "timeout"       "5.0"',
    '    "buffer"        "0.1"',
    '    "throttle"      "0.1"',
    '    "heartbeat"     "10.0"',
    '    "data"',
    '    {',
    '        "provider"  "1"',
    '        "map"       "1"',
    '        "player"    "1"',
    '        "hero"      "1"',
    '        "events"    "1"',
    '    }',
    '}',
    '',
  ].join('\r\n');
}

// Every Steam library on this machine, from libraryfolders.vdf.
export function libraryPaths(vdfText) {
  const out = [];
  for (const m of String(vdfText || '').matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

export function steamRoots() {
  if (process.env.STEAM_PATH && fs.existsSync(process.env.STEAM_PATH)) {
    return [path.normalize(process.env.STEAM_PATH)];
  }
  if (process.platform === 'win32') {
    for (const key of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
      for (const value of ['SteamPath', 'InstallPath']) {
        try {
          const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
          const m = /REG_SZ\s+(.+)/.exec(out);
          if (m && fs.existsSync(m[1].trim())) return [path.normalize(m[1].trim())];
        } catch { /* not there */ }
      }
    }
    return [];
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/share/Steam'),
    path.join(home, '.steam/steam'),
    path.join(home, '.steam/root'),
    path.join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam'),
    path.join(home, '.var/app/com.valvesoftware.Steam/.steam/steam'),
    path.join(home, 'snap/steam/common/.local/share/Steam'),
  ];
  return candidates.filter((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

function steamPath() {
  const roots = steamRoots();
  return roots.length ? roots[0] : null;
}

// <library>/steamapps/common/dota 2 beta/game/dota, or null.
export function findDotaDir({ steam, exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (process.env.DOTA_DIR && exists(path.join(process.env.DOTA_DIR, 'cfg'))) {
    return path.normalize(process.env.DOTA_DIR);
  }
  const roots = steam ? [steam] : steamRoots();
  if (!roots.length) return null;
  let libraries = [...roots];
  for (const root of roots) {
    try {
      libraries = libraries.concat(libraryPaths(read(path.join(root, 'steamapps', 'libraryfolders.vdf'))));
    } catch { /* libraryfolders.vdf not readable */ }
  }
  const seen = new Set();
  for (const lib of libraries) {
    if (!lib || seen.has(lib)) continue;
    seen.add(lib);
    const dir = path.join(lib, 'steamapps', 'common', 'dota 2 beta', 'game', 'dota');
    if (exists(path.join(dir, 'cfg'))) return dir;
  }
  return null;
}

/**
 * Make sure the cfg is there and says this port.
 * -> { state: 'present' | 'written' | 'notfound' | 'failed', file, dotaDir, detail }
 */
export function ensureGsiConfig({ port, dotaDir = findDotaDir() } = {}) {
  if (!dotaDir) return { state: 'notfound', file: null, dotaDir: null };
  const file = path.join(dotaDir, 'cfg', 'gamestate_integration', CFG_NAME);
  const want = gsiConfigText(port);
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === want) return { state: 'present', file, dotaDir };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, want);
    return { state: 'written', file, dotaDir };
  } catch (err) {
    return { state: 'failed', file, dotaDir, detail: String((err && err.message) || err) };
  }
}

/**
 * The language Dota runs in, as Steam keeps it for the game
 * (steamapps/appmanifest_570.acf, "language"). '' when it cannot be read.
 */
export function gameLanguage(dotaDir, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (!dotaDir) return '';
  try {
    // <library>/steamapps/common/dota 2 beta/game/dota
    const text = read(path.join(dotaDir, '..', '..', '..', '..', 'appmanifest_570.acf'));
    const m = /"language"\s+"([a-z_]+)"/i.exec(text);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}
