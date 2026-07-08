// app.js — costruisce il .mrpack del modpack GDC interamente nel browser.
//
// Percorso primario (veloce): UNA richiesta al proxy gdc-tarball (worker
// Cloudflare free, vedi proxy-worker/) che streamma il tar.gz del commit da
// codeload; gunzip nativo (DecompressionStream) + parser tar (tar.js).
// Fallback (se il proxy non risponde): download file-per-file da jsDelivr@sha
// con raw.githubusercontent come seconda scelta — più lento e soggetto ai
// rate limit di GitHub, ma senza dipendenze.
//
// Regole identiche al builder server-side (mrpack-service/):
//   - modrinth.index.json overrides-only, dipendenze dal manifest
//   - tutti i file di manifest.files sotto overrides/, escluso il runtime
//     (java/, natives/, lib/)
//   - ogni file verificato con lo sha256 del manifest
//   - package LOD estratti con 7z-wasm nelle posizioni finali
//   - zip STORE in streaming (zip.js)

import { ZipWriter } from './zip.js';
import { tarEntries } from './tar.js';

const REPO = 'jamnaga/wtf-modpack';
const BRANCH = 'main';
const TARBALL_PROXY = 'https://tar.gangdrogacity.xyz/';

const EXCLUDE_TOP = new Set(['java', 'natives', 'lib']);
const CONCURRENCY = 16;
const AHEAD_CAP = 96 * 1024 * 1024;   // fallback: byte massimi prefetchati
const BLOB_SPOOL = 64 * 1024 * 1024;  // fallback Blob: consolida ogni 64 MB
const LOD_CHUNK = 8 * 1024 * 1024;
const JSD_MAX = 18 * 1024 * 1024;     // jsDelivr /gh/ rifiuta file oltre ~20 MB

const qs = new URLSearchParams(location.search);
const FORCE_BLOB = qs.has('nofsapi');
const REF_OVERRIDE = qs.get('ref');       // per test: costruisce da uno sha specifico
const PROXY = qs.get('proxy') ?? TARBALL_PROXY; // per test: proxy alternativo

const $ = (id) => document.getElementById(id);
const te = new TextEncoder();

// ---- stato -----------------------------------------------------------------

let plan = null; // { commit, ref, jsdRef, manifest, include, packages, ... }
let activeBuildPlan = null; // variante effettivamente usata durante una build
let building = false;
let branch = BRANCH;   // cambiabile dal tasto «Branch: …»
let branches = null;   // elenco branch del repo (caricato al primo click)
const progress = {
  phase: 'idle', filesDone: 0, filesTotal: 0,
  bytesDone: 0, bytesTotal: 0, zipBytes: 0,
  tarBytes: 0, tarTotalEst: 0,
  currentPath: '', startedAt: 0, phaseStartedAt: 0, source: '',
};

function setPhase(phase) {
  progress.phase = phase;
  progress.phaseStartedAt = Date.now();
  progress.currentPath = '';
}

// Handle di debug/test (usato anche dai test automatizzati)
window.__mrpack = {
  progress,
  get plan() { return plan; },
  get activeBuildPlan() { return activeBuildPlan; },
  get building() { return building; },
};

// ---- utilità ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtBytes(n) {
  if (n == null) return '–';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  return Math.round(n / 1e3) + ' kB';
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(u8) {
  return toHex(await crypto.subtle.digest('SHA-256', u8));
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function currentPlan() {
  return activeBuildPlan ?? plan;
}

function isClientNamedMod(file) {
  const path = String(file?.path ?? '').replaceAll('\\', '/');
  const lowerPath = path.toLowerCase();
  const name = lowerPath.split('/').pop() ?? '';
  return lowerPath.startsWith('mods/') && name.includes('[client]');
}

function makeBuildVariant(skipClientMods = false) {
  if (!skipClientMods) return plan;

  const include = plan.include.filter((f) => !isClientNamedMod(f));
  const removedClientMods = plan.include.length - include.length;
  const removedClientModsBytes = plan.include.reduce((n, f) => n + (isClientNamedMod(f) ? f.size : 0), 0);
  const lodCount = plan.packages.reduce((n, pk) => n + (pk.filesToExtract?.length ?? 0), 0);

  return {
    ...plan,
    include,
    filesTotal: include.length + 1 + lodCount,
    bytesTotal: plan.bytesTotal - removedClientModsBytes,
    downloadBytes: plan.downloadBytes - removedClientModsBytes,
    skipClientMods,
    removedClientMods,
    removedClientModsBytes,
  };
}

function setBuildButtonsDisabled(disabled) {
  $('buildBtn').disabled = disabled;
  $('buildLiteBtn')?.toggleAttribute('disabled', disabled);
}

// ---- rate limit (solo percorso fallback): pausa globale per host -------------
// raw.githubusercontent.com applica un burst limit non documentato (429):
// quando succede, TUTTE le fetch verso quell'host si fermano, con backoff
// esponenziale + jitter. Un successo azzera il contatore.

const limiters = new Map(); // host → { until, strikes }

function notePause(url, retryAfterSec) {
  const host = new URL(url).host;
  const l = limiters.get(host) ?? { until: 0, strikes: 0 };
  l.strikes += 1;
  const base = retryAfterSec != null
    ? retryAfterSec * 1000
    : Math.min(60_000, 5000 * 2 ** (l.strikes - 1));
  l.until = Math.max(l.until, Date.now() + base + Math.random() * 1500);
  limiters.set(host, l);
}

function noteOk(url) {
  const l = limiters.get(new URL(url).host);
  if (l) l.strikes = 0;
}

function pauseLeft() {
  let m = 0;
  for (const l of limiters.values()) m = Math.max(m, l.until - Date.now());
  return Math.max(0, m);
}

async function politeWait(url) {
  const host = new URL(url).host;
  while (true) {
    const l = limiters.get(host);
    const left = l ? l.until - Date.now() : 0;
    if (left <= 0) return;
    await sleep(Math.min(left, 500));
  }
}

// fetch con retry e sorgenti alternative (urls in ordine di preferenza);
// aggiorna progress.bytesDone durante il download, con rollback se il
// tentativo fallisce. I 429 mettono in pausa l'host per tutti.
async function fetchBytes(urls, countProgress = true) {
  let lastErr;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const url = urls[(attempt - 1) % urls.length];
    await politeWait(url);
    let got = 0;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.status === 429) {
        // Retry-After spesso non è esposto via CORS: si va di backoff
        notePause(url, Number(r.headers.get('retry-after')) || null);
        const e = new Error('HTTP 429');
        e.status = 429;
        throw e;
      }
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status}`);
        e.status = r.status;
        throw e;
      }
      const chunks = [];
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (countProgress) progress.bytesDone += value.length;
      }
      noteOk(url);
      return concat(chunks, got);
    } catch (e) {
      if (countProgress) progress.bytesDone -= got;
      lastErr = e;
      // per i 429 l'attesa la impone politeWait al giro successivo
      if (attempt < 8 && e.status !== 429) await sleep(800 * attempt);
    }
  }
  throw new Error(`${decodeURIComponent(urls[0].split('/').pop())}: ${lastErr.message}`);
}

// ---- risoluzione commit + piano ---------------------------------------------

async function resolveCommit() {
  if (REF_OVERRIDE) {
    return { sha: REF_OVERRIDE, ref: REF_OVERRIDE, message: '(ref forzato da querystring)', date: null, author: null };
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/branches/${branch}`, {
      headers: { accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (r.ok) {
      const d = await r.json();
      return {
        sha: d.commit.sha,
        ref: d.commit.sha,
        message: (d.commit.commit?.message ?? '').split('\n')[0],
        date: d.commit.commit?.committer?.date ?? null,
        author: d.commit.commit?.author?.name ?? null,
      };
    }
  } catch { /* API giù o rate-limitata: fallback sotto */ }
  // Fallback: si costruisce dal ref del branch; la versione è l'hash del manifest
  const buf = await fetchBytes(
    [`https://raw.githubusercontent.com/${REPO}/refs/heads/${branch}/manifest.json?nocache=${Date.now()}`],
    false,
  );
  const hex = await sha256Hex(buf);
  return {
    sha: `manifest-${hex.slice(0, 12)}`,
    ref: `refs/heads/${branch}`,
    message: '(API GitHub non disponibile: versione identificata dal manifest)',
    date: null, author: null,
    manifestBytes: buf,
  };
}

async function loadPlan() {
  const commit = await resolveCommit();
  const manifest = JSON.parse(new TextDecoder().decode(
    commit.manifestBytes
      ?? await fetchBytes([`https://raw.githubusercontent.com/${REPO}/${commit.ref}/manifest.json`], false),
  ));

  const include = manifest.files.filter((f) => !EXCLUDE_TOP.has(f.path.split('/')[0]));
  const packages = manifest.packages ?? [];
  const lodCount = packages.reduce((n, pk) => n + (pk.filesToExtract?.length ?? 0), 0);

  let partsBytes = 0;
  for (const pk of packages) {
    const metaByPath = new Map((pk.files ?? []).map((f) => [f.path, f]));
    for (const part of pk.parts ?? []) {
      partsBytes += metaByPath.get(`packages/${pk.name}/${part}`)?.size ?? 0;
    }
  }
  const includeBytes = include.reduce((n, f) => n + f.size, 0);

  plan = {
    commit,
    ref: commit.ref,
    // jsDelivr solo con lo sha completo (immutabile): con un ref di branch la
    // sua cache può restare indietro rispetto al manifest → mismatch garantiti
    jsdRef: /^[0-9a-f]{40}$/i.test(commit.ref) ? commit.ref : null,
    manifest,
    include,
    packages,
    filesTotal: include.length + 1 + lodCount,
    bytesTotal: includeBytes + partsBytes * 2, // stima: aggiustata dopo l'estrazione
    downloadBytes: includeBytes + partsBytes,
  };
  return plan;
}

// ---- sink di output ----------------------------------------------------------

async function makeSink(filename) {
  if (!FORCE_BLOB && 'showSaveFilePicker' in window) {
    const handle = await showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'Modpack Modrinth', accept: { 'application/zip': ['.mrpack'] } }],
    });
    const w = await handle.createWritable();
    return {
      kind: 'disco (streaming)',
      write: (c) => w.write(c),
      close: () => w.close(),
      abort: () => w.abort().catch(() => {}),
    };
  }
  // Fallback: Blob "spool" — consolida i chunk in sotto-Blob (il browser li
  // sposta su disco), così la RAM del tab resta bassa anche senza FS Access API
  let chunks = [];
  let chunksBytes = 0;
  const blobParts = [];
  const spool = () => {
    if (!chunks.length) return;
    blobParts.push(new Blob(chunks));
    chunks = [];
    chunksBytes = 0;
  };
  return {
    kind: 'download classico',
    write: (c) => {
      chunks.push(c.slice());
      chunksBytes += c.length;
      if (chunksBytes >= BLOB_SPOOL) spool();
    },
    close: () => {
      spool();
      const blob = new Blob(blobParts, { type: 'application/zip' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 120000);
    },
    abort: () => { chunks = []; blobParts.length = 0; },
  };
}

// ---- 7z-wasm -------------------------------------------------------------------

let szPromise = null;
const szStderr = [];

function ensureSevenZip() {
  szPromise ??= import('./7zz.es6.js').then((m) =>
    m.default({ print: () => {}, printErr: (l) => { szStderr.push(l); console.warn('7z:', l); } }),
  );
  return szPromise;
}

function writePart(sz, pkgIndex, partName, data) {
  const dir = `/parts${pkgIndex}`;
  try { sz.FS.mkdir(dir); } catch { /* esiste già */ }
  sz.FS.writeFile(`${dir}/${partName}`, data);
}

// ---- build --------------------------------------------------------------------

function indexJson(manifest) {
  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0.0',
    name: 'GangDrogaCity',
    summary: 'Generato dal GangDrogaCity Web Launcher il ${new Date().toLocaleDateString()}',
    files: [],
    dependencies: {
      minecraft: manifest.mcVersion,
      'fabric-loader': manifest.fabricLoaderVersion,
    },
  };
}

function partsIndex() {
  const build = currentPlan();
  const map = new Map(); // path repo → { pkgIndex, partName, meta }
  for (const [pkgIndex, pk] of build.packages.entries()) {
    const metaByPath = new Map((pk.files ?? []).map((f) => [f.path, f]));
    for (const partName of pk.parts ?? []) {
      const p = `packages/${pk.name}/${partName}`;
      map.set(p, { pkgIndex, partName, meta: metaByPath.get(p) });
    }
  }
  return map;
}

// Fase 1: scarica l'INTERO archivio del commit in locale (spool su sotto-Blob:
// il browser li tiene su disco, la RAM del tab resta bassa). Se qualcosa va
// storto qui lo zip non è ancora stato toccato → il fallback resta possibile.
async function downloadArchive() {
  const build = currentPlan();
  setPhase('download');
  const url = `${PROXY.replace(/\/$/, '')}/tarball/${build.ref}`;
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    throw Object.assign(new Error(`proxy non raggiungibile: ${e.message}`), { beforeStream: true });
  }
  if (!res.ok || !res.body) {
    throw Object.assign(new Error(`proxy HTTP ${res.status}`), { beforeStream: true });
  }
  progress.source = 'tarball';
  // codeload non manda content-length (chunked): stima ~75% del contenuto
  progress.tarTotalEst = Number(res.headers.get('content-length'))
    || Math.round(build.downloadBytes * 0.75);

  const blobParts = [];
  let cur = [];
  let curBytes = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    cur.push(value);
    curBytes += value.length;
    progress.tarBytes += value.length;
    if (curBytes >= BLOB_SPOOL) {
      blobParts.push(new Blob(cur));
      cur = [];
      curBytes = 0;
    }
  }
  if (cur.length) blobParts.push(new Blob(cur));
  progress.tarTotalEst = progress.tarBytes; // ora è esatto
  return new Blob(blobParts);
}

// Fase 2: lavora l'archivio scaricato, tutto in locale (niente rete)
async function packFromArchive(zip, sz, archiveBlob) {
  const build = currentPlan();
  setPhase('pack');

  const includeMap = new Map(build.include.map((f) => [f.path, f]));
  const parts = partsIndex();
  const seen = new Set();
  const partsSeen = new Set();

  const gunzip = archiveBlob.stream().pipeThrough(new DecompressionStream('gzip'));
  for await (const entry of tarEntries(gunzip)) {
    // il tarball ha il prefisso "<repo>-<ref>/": via il primo segmento
    const rel = entry.name.split('/').slice(1).join('/');
    if (!rel) continue;

    const inc = includeMap.get(rel);
    const part = inc ? null : parts.get(rel);
    if (!inc && !part) continue; // entry non consumata: tar.js la scarta da solo

    progress.currentPath = rel;
    const chunks = [];
    let n = 0;
    for await (const c of entry.data()) {
      chunks.push(c);
      n += c.length;
      progress.bytesDone += c.length;
    }
    const data = concat(chunks, n);

    if (inc) {
      if (n !== inc.size) throw new Error(`dimensione diversa dal manifest: ${rel} (${n} ≠ ${inc.size})`);
      if (await sha256Hex(data) !== inc.sha256) throw new Error(`sha256 diverso dal manifest: ${rel}`);
      await zip.addEntry(`overrides/${rel}`, [data]);
      seen.add(rel);
      progress.filesDone += 1;
    } else {
      if (part.meta && (n !== part.meta.size || await sha256Hex(data) !== part.meta.sha256)) {
        throw new Error(`parte package corrotta o diversa dal manifest: ${rel}`);
      }
      writePart(sz, part.pkgIndex, part.partName, data);
      partsSeen.add(rel);
    }
  }

  if (seen.size !== includeMap.size) {
    const missing = build.include.map((f) => f.path).filter((p) => !seen.has(p));
    throw new Error(
      `${missing.length} file del manifest assenti nel commit (manifest non pushato?): ` +
      missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', …' : ''),
    );
  }
  if (partsSeen.size !== parts.size) {
    throw new Error('parti dei package assenti nel commit');
  }
}

// Fallback: download file-per-file (jsDelivr@sha, poi raw), append in ordine
async function buildPerFile(zip, sz) {
  const build = currentPlan();
  const { ref, jsdRef, include } = build;
  const RAW = `https://raw.githubusercontent.com/${REPO}/${ref}/`;
  const JSD = jsdRef ? `https://cdn.jsdelivr.net/gh/${REPO}@${jsdRef}/` : null;
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const urlsFor = (path, size) => {
    const enc = encPath(path);
    return JSD && size <= JSD_MAX ? [JSD + enc, RAW + enc] : [RAW + enc];
  };
  setPhase('pack');
  progress.source = 'file singoli';

  const fetchOne = async (f) => {
    const data = await fetchBytes(urlsFor(f.path, f.size));
    if (data.length !== f.size) throw new Error(`dimensione diversa dal manifest: ${f.path} (${data.length} ≠ ${f.size})`);
    if (await sha256Hex(data) !== f.sha256) throw new Error(`sha256 diverso dal manifest: ${f.path}`);
    return data;
  };

  const inflight = new Map();
  let nextFetch = 0;
  let aheadBytes = 0;
  const pump = () => {
    while (nextFetch < include.length && inflight.size < CONCURRENCY && aheadBytes < AHEAD_CAP) {
      const i = nextFetch++;
      aheadBytes += include[i].size;
      inflight.set(i, fetchOne(include[i]));
    }
  };
  for (let i = 0; i < include.length; i++) {
    pump();
    const data = await inflight.get(i);
    inflight.delete(i);
    aheadBytes -= include[i].size;
    pump();
    progress.currentPath = include[i].path;
    await zip.addEntry(`overrides/${include[i].path}`, [data]);
    progress.filesDone += 1;
  }

  for (const [rel, part] of partsIndex()) {
    progress.currentPath = rel;
    const data = await fetchBytes(urlsFor(rel, part.meta?.size ?? Infinity));
    if (part.meta && (data.length !== part.meta.size || await sha256Hex(data) !== part.meta.sha256)) {
      throw new Error(`parte package corrotta o diversa dal manifest: ${rel}`);
    }
    writePart(sz, part.pkgIndex, part.partName, data);
  }
}

// Estrae i package in MEMFS (già popolato di parti) e appende i file LOD
async function extractAndAppendLods(zip, sz) {
  const build = currentPlan();
  setPhase('lod');
  for (const [i, pk] of build.packages.entries()) {
    if (!(pk.parts ?? []).length) continue;
    const partsDir = `/parts${i}`;
    const outDir = `/out${i}`;
    try { sz.FS.mkdir(outDir); } catch { /* esiste già */ }

    progress.currentPath = 'estrazione 7z…';
    let rc = 0;
    try {
      rc = sz.callMain(['x', '-y', `-o${outDir}`, `${partsDir}/${pk.parts[0]}`]);
    } catch (e) {
      rc = typeof e?.status === 'number' ? e.status : 1;
    }
    if (rc !== 0) {
      throw new Error(`7z fallito (exit ${rc}): ${szStderr.slice(-3).join(' | ')}`);
    }
    for (const part of pk.parts) {
      try { sz.FS.unlink(`${partsDir}/${part}`); } catch { /* già assente */ }
    }

    // Stima → dimensioni reali degli estratti
    const toExtract = pk.filesToExtract ?? [];
    const metaByPath = new Map((pk.files ?? []).map((f) => [f.path, f]));
    let actual = 0;
    for (const f of toExtract) {
      try {
        actual += sz.FS.stat(`${outDir}/${f}`).size;
      } catch {
        throw new Error(`file atteso non estratto dal package: ${f}`);
      }
    }
    let partsSum = 0;
    for (const part of pk.parts) partsSum += metaByPath.get(`packages/${pk.name}/${part}`)?.size ?? 0;
    progress.bytesTotal += actual - partsSum;

    const base = (pk.extractTo ?? '').replace(/^\/+|\/+$/g, '');
    for (const f of toExtract) {
      progress.currentPath = f;
      const path = `${outDir}/${f}`;
      const size = sz.FS.stat(path).size;
      const stream = sz.FS.open(path, 'r');
      const tmp = new Uint8Array(LOD_CHUNK);
      await zip.addEntry(`overrides/${base}/${f}`, (async function* () {
        let pos = 0;
        while (pos < size) {
          const n = sz.FS.read(stream, tmp, 0, Math.min(LOD_CHUNK, size - pos), pos);
          if (n <= 0) throw new Error(`lettura MEMFS interrotta: ${f}`);
          pos += n;
          progress.bytesDone += n;
          yield tmp.slice(0, n); // copia: tmp viene riusato
        }
      })());
      sz.FS.close(stream);
      sz.FS.unlink(path);
      progress.filesDone += 1;
    }
  }
}

async function buildPack(sink) {
  const build = currentPlan();
  const zip = new ZipWriter(async (chunk) => {
    await sink.write(chunk);
    progress.zipBytes += chunk.length;
  });

  await zip.addEntry('modrinth.index.json', [te.encode(JSON.stringify(indexJson(build.manifest), null, 2))]);
  progress.filesDone += 1;

  const hasParts = build.packages.some((pk) => (pk.parts ?? []).length);
  const sz = hasParts ? await ensureSevenZip() : null;

  const entriesBefore = zip.entryCount;
  let viaTarball = false;
  try {
    const archive = await downloadArchive();      // 1) tutto il commit in locale
    await packFromArchive(zip, sz, archive);      // 2) lavorazione senza rete
    viaTarball = true;
  } catch (e) {
    // il fallback è possibile solo se lo zip non è stato ancora toccato
    if (zip.entryCount > entriesBefore) throw e;
    console.warn('tarball non disponibile, passo al download file-per-file:', e.message);
  }
  if (!viaTarball) {
    await buildPerFile(zip, sz);
  }

  if (hasParts) await extractAndAppendLods(zip, sz);

  await zip.finish();
  progress.currentPath = '';
  return { files: zip.entryCount, bytes: zip.bytesWritten };
}

// ---- UI -------------------------------------------------------------------------

function renderPlan() {
  const c = plan.commit;
  // angolo in basso a sinistra, come la versione nel title screen vanilla
  $('commit').textContent =
    `(${branch !== 'main' ? branch + ' · ' : ''}` +
    `${c.sha.slice(0, 10)}${c.date ? ' · ' + new Date(c.date).toLocaleDateString('it-IT') : ''})`;
  $('planInfo').textContent =
    `${plan.filesTotal.toLocaleString('it-IT')} file · download ${fmtBytes(plan.downloadBytes)} · ` +
    `2,5 GB liberi su disco · ~3-4 minuti`;
  setBuildButtonsDisabled(false);
}

// ---- cambio branch (tasto ciclico stile opzioni MC) --------------------------

async function ensureBranches() {
  if (branches) return branches;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/branches?per_page=100`, {
      headers: { accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (r.ok) {
      const names = (await r.json()).map((b) => b.name);
      if (names.length) {
        names.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
        branches = names;
      }
    }
  } catch { /* API giù: fallback sotto */ }
  if (!branches) {
    // rate limit API: si accetta un nome scritto a mano
    const name = prompt('API GitHub non raggiungibile. Nome del branch:', branch);
    if (name?.trim() && name.trim() !== branch) branches = [branch, name.trim()];
  }
  return branches;
}

async function cycleBranch() {
  if (building) return;
  const btn = $('branchBtn');
  btn.disabled = true;
  try {
    const list = await ensureBranches();
    if (!list || list.length < 2) return;
    branch = list[(list.indexOf(branch) + 1) % list.length];
    $('branchLabel').textContent = `Branch: ${branch}`;
    plan = null;
    setBuildButtonsDisabled(true);
    $('error').style.display = 'none';
    $('done').style.display = 'none';
    $('planInfo').textContent = 'caricamento…';
    await loadPlan();
    renderPlan();
  } catch (e) {
    $('planInfo').textContent = '⚠ branch non leggibile: ' + String(e?.message ?? e);
  } finally {
    btn.disabled = false;
  }
}

// Riga "persone online" come nella home FancyMenu (placeholder gdc_players):
// qui i dati arrivano dal worker gdc-status (CORS aperto), aggiornati ogni 30s
const STATUS_URL = 'https://status.gangdrogacity.xyz/';

async function loadPlayers() {
  const el = $('playersLine');
  if (!el) return;
  try {
    const d = await (await fetch(STATUS_URL, { cache: 'no-store' })).json();
    const n = d?.players?.current;
    if (d?.online && typeof n === 'number') {
      el.textContent = n === 1
        ? 'C’è 1 persona online in questo momento.'
        : `Ci sono ${n} persone online in questo momento.`;
    } else {
      el.textContent = 'Il server è offline in questo momento.';
    }
  } catch {
    el.textContent = '';
  }
}


function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

const PHASE_LABELS = {
  download: 'Download del commit…',
  pack: 'Impacchettamento in locale…',
  lod: 'Estrazione LOD Distant Horizons…',
};

let renderTimer = null;
function renderProgress() {
  $('progress').style.display = building ? 'block' : 'none';
  if (!building) return;
  const paused = pauseLeft();
  $('phaseLabel').textContent = (PHASE_LABELS[progress.phase] ?? 'Preparazione…') +
    (paused > 0 ? ` — pausa rate-limit (${Math.ceil(paused / 1000)}s)` : '');

  // barra e contatori relativi alla fase corrente
  let done;
  let total;
  if (progress.phase === 'download') {
    done = progress.tarBytes;
    total = progress.tarTotalEst;
    $('files').textContent = '–';
    $('mb').textContent = `${fmtBytes(done)} / ~${fmtBytes(total)}`;
  } else {
    done = progress.bytesDone;
    total = progress.bytesTotal;
    $('files').textContent = `${progress.filesDone}/${progress.filesTotal}`;
    $('mb').textContent = `${fmtBytes(done)} / ${fmtBytes(total)}`;
  }
  const pct = total > 0 ? Math.min(99, (100 * done) / total) : 0;
  $('barFill').style.width = pct.toFixed(1) + '%';

  const elapsed = Math.max(1, (Date.now() - (progress.phaseStartedAt || progress.startedAt)) / 1000);
  const speed = done / elapsed;
  $('speed').textContent = speed > 1000 ? (speed / 1e6).toFixed(1) + ' MB/s' : '–';
  const remaining = speed > 0 && total > done ? (total - done) / speed : 0;
  $('eta').textContent = remaining >= 60 ? Math.round(remaining / 60) + ' min' : Math.round(remaining) + ' s';
  $('curPath').textContent = progress.currentPath ? '‎' + progress.currentPath : '';
}

function showError(msg) {
  $('error').style.display = 'block';
  $('error').innerHTML =
    `<div class="wastedTitle">✗ CONSEGNA FALLITA</div>` +
    `<div class="wastedMsg">${escapeHtml(msg)}</div>`;
}

function beforeUnload(e) {
  e.preventDefault();
  e.returnValue = '';
}

async function startBuild(skipClientMods = false) {
  if (building || !plan) return;
  $('error').style.display = 'none';
  $('done').style.display = 'none';

  const build = makeBuildVariant(skipClientMods);
  activeBuildPlan = build;

  const tag = build.commit.sha.startsWith('manifest-') ? build.commit.sha : build.commit.sha.slice(0, 10);
  const modeSuffix = skipClientMods ? '-no-client-mods' : '';
  const filename = `GDCModpack-1.0.0-${tag}${modeSuffix}.mrpack`;

  // Il picker DEVE partire dal gesto utente, prima di qualsiasi await lungo
  let sink;
  try {
    sink = await makeSink(filename);
  } catch (e) {
    activeBuildPlan = null;
    if (e?.name === 'AbortError') return; // annullato dall'utente
    showError(String(e?.message ?? e));
    return;
  }

  building = true;
  const clickedBtn = skipClientMods ? $('buildLiteBtn') : $('buildBtn');
  const btnLabel = clickedBtn?.querySelector('span');
  setBuildButtonsDisabled(true);
  $('branchBtn').disabled = true;
  if (btnLabel) btnLabel.textContent = 'Attendi…';
  Object.assign(progress, {
    phase: 'download', filesDone: 0, filesTotal: build.filesTotal,
    bytesDone: 0, bytesTotal: build.bytesTotal, zipBytes: 0,
    tarBytes: 0, tarTotalEst: 0,
    currentPath: '', startedAt: Date.now(), phaseStartedAt: Date.now(), source: '',
  });
  window.addEventListener('beforeunload', beforeUnload);
  renderTimer = setInterval(renderProgress, 250);
  renderProgress();

  try {
    const r = await buildPack(sink);
    await sink.close();
    const modeLine = skipClientMods
      ? `<br><span class="meta">Modalità grafica di merda: rimossi ${build.removedClientMods.toLocaleString('it-IT')} mod client (${fmtBytes(build.removedClientModsBytes)}).</span>`
      : '';
    $('done').style.display = 'block';
    $('doneInfo').innerHTML =
      `<b>${filename}</b> — ${r.files.toLocaleString('it-IT')} file, ${fmtBytes(r.bytes)} ` +
      `in ${Math.round((Date.now() - progress.startedAt) / 1000)}s. Benvenuto in città.${modeLine}<br>` +
      `Importalo in <b>Modrinth App</b> (o Prism): <span class="meta">Aggiungi istanza → Da file → seleziona il .mrpack</span>`;
  } catch (e) {
    console.error(e);
    sink.abort();
    showError(String(e?.message ?? e));
  } finally {
    building = false;
    activeBuildPlan = null;
    clearInterval(renderTimer);
    window.removeEventListener('beforeunload', beforeUnload);
    $('progress').style.display = 'none';
    setBuildButtonsDisabled(false);
    $('branchBtn').disabled = false;
    if (btnLabel) btnLabel.textContent = skipClientMods ? 'Inizia (modalità grafica di merda)' : 'Inizia';
  }
}

// ---- avvio ------------------------------------------------------------------------

$('buildBtn').addEventListener('click', () => startBuild(false));
$('buildLiteBtn')?.addEventListener('click', () => startBuild(true));
$('welcomeBtn')?.addEventListener('click', () => $('welcome')?.remove());

if (REF_OVERRIDE) {
  $('branchBtn').style.display = 'none'; // modalità test con ?ref=
} else {
  $('branchBtn').addEventListener('click', cycleBranch);
}

if (!FORCE_BLOB && !('showSaveFilePicker' in window)) {
  $('browserNote').style.display = 'block';
}

// parallax dello sfondo, come nel layout FancyMenu (intensità 0.02)
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const bg = $('bg');
  if (bg) {
    addEventListener('mousemove', (e) => {
      const dx = (e.clientX / innerWidth - 0.5) * 2;
      const dy = (e.clientY / innerHeight - 0.5) * 2;
      bg.style.transform = `translate(${(-dx * 1.1).toFixed(2)}%, ${(-dy * 1.1).toFixed(2)}%) scale(1.05)`;
    }, { passive: true });
  }
}

loadPlayers();
setInterval(loadPlayers, 30_000);

loadPlan().then(renderPlan).catch((e) => {
  $('planInfo').textContent = '⚠ impossibile leggere il manifest da GitHub';
  showError('impossibile leggere il manifest da GitHub: ' + String(e?.message ?? e));
});
