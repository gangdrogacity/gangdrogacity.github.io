// tar.js — parser tar in streaming per browser (e node, per i test).
// Gestisce il formato dei tarball di GitHub (git archive): ustar con prefix,
// pax extended header ('x': path=..., 'g': globali) e GNU longname ('L').
//
// Uso:
//   for await (const entry of tarEntries(readableStream)) {
//     // entry: { name, size, type }
//     for await (const chunk of entry.data()) { ... }  // opzionale
//   }
// Le entry non consumate (o consumate a metà) vengono scartate automaticamente
// prima di passare alla successiva.

const td = new TextDecoder();

function parseOctal(buf, off, len) {
  const s = td.decode(buf.subarray(off, off + len)).replace(/[\0 ]+$/g, '').replace(/^[\0 ]+/g, '');
  return s ? parseInt(s, 8) : 0;
}

function cString(buf, off, len) {
  let end = off;
  const max = off + len;
  while (end < max && buf[end] !== 0) end++;
  return td.decode(buf.subarray(off, end));
}

function isZeroBlock(buf) {
  for (let i = 0; i < 512; i++) if (buf[i] !== 0) return false;
  return true;
}

// record pax: "<len> <chiave>=<valore>\n" ripetuti
function parsePax(payload) {
  const out = {};
  const text = td.decode(payload);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, i + len - 1); // senza il \n finale
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

export async function* tarEntries(readableStream) {
  const reader = readableStream.getReader();
  // coda di chunk con offset: niente ri-concatenazioni O(n²)
  const chunks = [];
  let headOff = 0;   // offset nel primo chunk
  let avail = 0;     // byte disponibili totali
  let eof = false;

  async function pull() {
    if (eof) return false;
    const { done, value } = await reader.read();
    if (done) { eof = true; return false; }
    if (value?.length) { chunks.push(value); avail += value.length; }
    return true;
  }

  // n byte esatti in un nuovo Uint8Array; null se lo stream finisce prima (a 0 byte)
  async function take(n) {
    while (avail < n) {
      if (!(await pull())) {
        if (avail === 0) return null;
        throw new Error('tar troncato');
      }
    }
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const first = chunks[0];
      const canTake = Math.min(n - got, first.length - headOff);
      out.set(first.subarray(headOff, headOff + canTake), got);
      got += canTake;
      headOff += canTake;
      avail -= canTake;
      if (headOff === first.length) { chunks.shift(); headOff = 0; }
    }
    return out;
  }

  // itera n byte come sub-chunk zero-copy, consumandoli
  async function* stream(n) {
    let remaining = n;
    while (remaining > 0) {
      if (avail === 0 && !(await pull())) throw new Error('tar troncato dentro una entry');
      const first = chunks[0];
      const canTake = Math.min(remaining, first.length - headOff);
      const piece = first.subarray(headOff, headOff + canTake);
      headOff += canTake;
      avail -= canTake;
      remaining -= canTake;
      if (headOff === first.length) { chunks.shift(); headOff = 0; }
      yield piece;
    }
  }

  async function skip(n) {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of stream(n)) { /* scarta */ }
  }

  let nextPath = null; // override pax 'x' o GNU 'L' per la prossima entry

  while (true) {
    const hdr = await take(512);
    if (hdr === null) return;              // EOF pulito
    if (isZeroBlock(hdr)) {                // blocco di fine archivio
      const second = await take(512).catch(() => null);
      void second;
      return;
    }

    const size = parseOctal(hdr, 124, 12);
    const pad = (512 - (size % 512)) % 512;
    const typeflag = String.fromCharCode(hdr[156] || 48);

    if (typeflag === 'x' || typeflag === 'g') {
      const payload = await take(size);
      if (pad) await skip(pad);
      if (typeflag === 'x') {
        const records = parsePax(payload);
        if (records.path) nextPath = records.path;
      }
      continue;
    }
    if (typeflag === 'L') { // GNU longname
      const payload = await take(size);
      if (pad) await skip(pad);
      nextPath = cString(payload, 0, payload.length);
      continue;
    }

    let name = nextPath;
    nextPath = null;
    if (!name) {
      const base = cString(hdr, 0, 100);
      const prefix = cString(hdr, 345, 155);
      name = prefix ? `${prefix}/${base}` : base;
    }

    if (typeflag === '0' || typeflag === '\0') {
      let consumed = 0;
      let entryDone = false;
      const self = {
        name,
        size,
        type: 'file',
        data: async function* () {
          for await (const piece of stream(size)) {
            consumed += piece.length;
            yield piece;
          }
          if (pad) await skip(pad);
          entryDone = true;
        },
      };
      yield self;
      if (!entryDone) {
        // il chiamante non ha (finito di) leggere: scarta il resto
        await skip(size + pad - consumed);
      }
    } else {
      // directory, symlink, ecc.: si saltano
      if (size + pad > 0) await skip(size + pad);
    }
  }
}
