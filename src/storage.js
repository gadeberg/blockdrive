// Saving and loading worlds.
//
// A world is its seed plus every block the player has changed. Terrain is
// deterministic, so that pair reproduces the world exactly and stays small
// enough to sit in localStorage or travel as a file.

import { CH_X, CH_Y, CH_Z } from './world.js';
import { BLOCKS } from './blocks.js';

const FORMAT = 'blockdrive-world';
const VERSION = 1;

const INDEX_KEY = 'blockdrive.index';
const LAST_KEY = 'blockdrive.last';
const worldKey = (id) => `blockdrive.world.${id}`;

const MAX_BLOCK_INDEX = CH_X * CH_Y * CH_Z;
const MAX_EDITS = 2000000;        // refuse to chew on a hostile file forever
const MAX_NAME = 48;
const CHUNK_KEY_RE = /^-?\d{1,7},-?\d{1,7}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

// --- localStorage, defensively -------------------------------------------
// Private windows and blocked-site-data settings make every one of these throw.

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function storageAvailable() {
  try {
    localStorage.setItem('__bd_probe', '1');
    localStorage.removeItem('__bd_probe');
    return true;
  } catch {
    return false;
  }
}

// --- names, ids, seeds ----------------------------------------------------

export function newId() {
  return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Names are shown in the UI and may come from a file, so keep them boring. */
export function cleanName(name, fallback = 'Untitled world') {
  if (typeof name !== 'string') return fallback;
  const out = name.replace(CONTROL_RE, '').trim().slice(0, MAX_NAME);
  return out || fallback;
}

export function randomSeed() {
  return (Math.random() * 0x7fffffff) | 0;
}

/** Accept a typed seed as a number, or hash any other text into one. */
export function parseSeed(text) {
  const t = String(text ?? '').trim();
  if (!t) return randomSeed();
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n | 0;
  }
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

// --- edit log <-> plain JSON ---------------------------------------------

export function encodeEdits(edits) {
  const out = {};
  for (const [key, log] of edits) {
    if (log.size === 0) continue;
    const flat = new Array(log.size * 2);
    let i = 0;
    for (const [index, block] of log) {
      flat[i++] = index;
      flat[i++] = block;
    }
    out[key] = flat;
  }
  return out;
}

/** Turn a validated save back into an edit Map for World.reset(). */
export function editsFrom(save) {
  const edits = new Map();
  for (const key of Object.keys(save.edits)) {
    const flat = save.edits[key];
    const log = new Map();
    for (let i = 0; i < flat.length; i += 2) log.set(flat[i], flat[i + 1]);
    edits.set(key, log);
  }
  return edits;
}

// --- validation -----------------------------------------------------------

const vec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const vec4 = (a) => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite);

/**
 * Check a parsed save before letting it near the world. Files can be edited by
 * hand or come from someone else, and a bad block index would quietly corrupt
 * a chunk or hang the tab.
 * Returns { ok: true, save } or { ok: false, error }.
 */
export function validate(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'not a world file' };
  }
  if (obj.format !== FORMAT) return { ok: false, error: 'not a Blockdrive world file' };
  if (!Number.isFinite(obj.version) || obj.version > VERSION) {
    return { ok: false, error: 'saved by a newer build of the game' };
  }
  if (!Number.isFinite(obj.seed)) return { ok: false, error: 'missing or invalid seed' };

  const rawEdits = obj.edits;
  if (!rawEdits || typeof rawEdits !== 'object' || Array.isArray(rawEdits)) {
    return { ok: false, error: 'missing edit log' };
  }

  let total = 0;
  const clean = {};
  for (const key of Object.keys(rawEdits)) {
    if (!CHUNK_KEY_RE.test(key)) return { ok: false, error: `bad chunk key "${key}"` };
    const flat = rawEdits[key];
    if (!Array.isArray(flat) || flat.length % 2 !== 0) {
      return { ok: false, error: `bad edit list for chunk ${key}` };
    }
    total += flat.length / 2;
    if (total > MAX_EDITS) return { ok: false, error: 'edit log is implausibly large' };

    for (let i = 0; i < flat.length; i += 2) {
      const index = flat[i];
      const block = flat[i + 1];
      if (!Number.isInteger(index) || index < 0 || index >= MAX_BLOCK_INDEX) {
        return { ok: false, error: `block index out of range in chunk ${key}` };
      }
      if (!Number.isInteger(block) || block < 0 || block >= BLOCKS.length) {
        return { ok: false, error: `unknown block id ${block} in chunk ${key}` };
      }
    }
    clean[key] = flat;
  }

  const state = obj.state && typeof obj.state === 'object' ? obj.state : {};
  const safe = { headlights: !!state.headlights };
  if (state.car && vec3(state.car.pos) && vec4(state.car.quat)) {
    safe.car = { pos: state.car.pos, quat: state.car.quat };
  }
  if (state.player && vec3(state.player.pos)
      && Number.isFinite(state.player.yaw) && Number.isFinite(state.player.pitch)) {
    safe.player = { pos: state.player.pos, yaw: state.player.yaw, pitch: state.player.pitch };
  }
  if (state.mode === 'foot' || state.mode === 'drive') safe.mode = state.mode;
  if (Number.isInteger(state.slot) && state.slot >= 0 && state.slot < 8) safe.slot = state.slot;

  return {
    ok: true,
    save: {
      format: FORMAT,
      version: VERSION,
      id: typeof obj.id === 'string' && /^[\w-]{1,40}$/.test(obj.id) ? obj.id : newId(),
      name: cleanName(obj.name),
      seed: obj.seed | 0,
      created: Number.isFinite(obj.created) ? obj.created : Date.now(),
      saved: Number.isFinite(obj.saved) ? obj.saved : Date.now(),
      edits: clean,
      state: safe,
      count: total,
    },
  };
}

export function buildSave({ id, name, seed, created, world, state }) {
  return {
    format: FORMAT,
    version: VERSION,
    id,
    name: cleanName(name),
    seed,
    created: created ?? Date.now(),
    saved: Date.now(),
    edits: encodeEdits(world.edits),
    state,
  };
}

// --- slots ----------------------------------------------------------------

/** [{ id, name, seed, saved, count }], most recently saved first. */
export function listWorlds() {
  const index = readJSON(INDEX_KEY);
  if (!Array.isArray(index)) return [];
  return index
    .filter((e) => e && typeof e.id === 'string')
    .map((e) => ({
      id: e.id,
      name: cleanName(e.name),
      seed: Number.isFinite(e.seed) ? e.seed : 0,
      saved: Number.isFinite(e.saved) ? e.saved : 0,
      count: Number.isFinite(e.count) ? e.count : 0,
    }))
    .sort((a, b) => b.saved - a.saved);
}

export function saveWorld(save) {
  const count = Object.values(save.edits).reduce((n, a) => n + a.length / 2, 0);
  if (!writeJSON(worldKey(save.id), save)) {
    return { ok: false, error: 'browser storage is full or unavailable' };
  }
  const index = listWorlds().filter((e) => e.id !== save.id);
  index.unshift({
    id: save.id, name: save.name, seed: save.seed, saved: save.saved, count,
  });
  writeJSON(INDEX_KEY, index);
  writeJSON(LAST_KEY, save.id);
  return { ok: true, count };
}

export function loadWorld(id) {
  const raw = readJSON(worldKey(id));
  if (!raw) return { ok: false, error: 'world not found' };
  return validate(raw);
}

export function deleteWorld(id) {
  try {
    localStorage.removeItem(worldKey(id));
  } catch {
    /* nothing useful to do about it */
  }
  writeJSON(INDEX_KEY, listWorlds().filter((e) => e.id !== id));
  if (readJSON(LAST_KEY) === id) writeJSON(LAST_KEY, null);
}

export function lastWorldId() {
  const id = readJSON(LAST_KEY);
  return typeof id === 'string' ? id : null;
}

/**
 * Remember which world is being played, so the next visit resumes it. Saving
 * does this too, but switching worlds has to record it as well — otherwise
 * loading a world and then reloading the page brings back the previous one.
 */
export function setLastWorldId(id) {
  writeJSON(LAST_KEY, id);
}

// --- files ----------------------------------------------------------------

export function downloadSave(save) {
  const blob = new Blob([JSON.stringify(save)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stem = save.name.replace(/[^\w -]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
  a.download = (stem || 'world') + '.blockdrive.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readSaveFile(file) {
  if (file.size > 32 * 1024 * 1024) return { ok: false, error: 'that file is too large' };
  let text;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: 'could not read that file' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'that file is not valid JSON' };
  }
  return validate(parsed);
}
