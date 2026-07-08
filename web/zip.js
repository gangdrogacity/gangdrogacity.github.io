// zip.js — scrittore ZIP in streaming per browser, solo metodo STORE.
// Port di mrpack-service/container/zipwriter.js: data descriptor (bit 3),
// nomi UTF-8, niente ZIP64 (archivio < 4 GiB, < 65535 entry — con guardie).
// Pure Uint8Array + DataView: gira in browser e in node (per i test).

const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf, prev = 0) {
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const te = new TextEncoder();

function struct(size, fill) {
  const b = new Uint8Array(size);
  fill(new DataView(b.buffer));
  return b;
}

export class ZipWriter {
  #write;
  #offset = 0;
  #entries = [];
  #time;
  #date;

  // write: async (Uint8Array) => void — il chunk può essere riusato dal chiamante
  // solo DOPO che la promise risolve (i sink devono copiare o scrivere subito)
  constructor(write) {
    this.#write = write;
    const { time, date } = dosDateTime(new Date());
    this.#time = time;
    this.#date = date;
  }

  get bytesWritten() { return this.#offset; }
  get entryCount() { return this.#entries.length; }

  async #out(buf) {
    await this.#write(buf);
    this.#offset += buf.length;
  }

  // source: iterable o async iterable di Uint8Array
  async addEntry(name, source) {
    const nameBytes = te.encode(name);
    if (nameBytes.length > MAX_U16) throw new Error(`nome entry troppo lungo: ${name}`);
    const offset = this.#offset;
    if (offset > MAX_U32) throw new Error('offset oltre 4 GiB: servirebbe ZIP64');

    const time = this.#time;
    const date = this.#date;
    await this.#out(struct(30, (v) => {
      v.setUint32(0, 0x04034b50, true);   // local file header
      v.setUint16(4, 20, true);           // versione minima 2.0
      v.setUint16(6, 0x0808, true);       // bit 3 (data descriptor) + bit 11 (UTF-8)
      v.setUint16(8, 0, true);            // metodo 0 = store
      v.setUint16(10, time, true);
      v.setUint16(12, date, true);
      // CRC e dimensioni a 0: arrivano nel data descriptor
      v.setUint16(26, nameBytes.length, true);
    }));
    await this.#out(nameBytes);

    let crc = 0;
    let size = 0;
    for await (const chunk of source) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      await this.#out(chunk);
    }
    if (size > MAX_U32) throw new Error(`entry oltre 4 GiB: ${name}`);

    const fcrc = crc;
    const fsize = size;
    await this.#out(struct(16, (v) => {
      v.setUint32(0, 0x08074b50, true);   // firma data descriptor
      v.setUint32(4, fcrc, true);
      v.setUint32(8, fsize, true);        // compressa == originale (store)
      v.setUint32(12, fsize, true);
    }));

    this.#entries.push({ nameBytes, crc, size, offset });
    return size;
  }

  async finish() {
    if (this.#entries.length > MAX_U16) throw new Error('troppe entry: servirebbe ZIP64');
    const cdStart = this.#offset;
    if (cdStart > MAX_U32) throw new Error('central directory oltre 4 GiB: servirebbe ZIP64');

    const time = this.#time;
    const date = this.#date;
    for (const e of this.#entries) {
      await this.#out(struct(46, (v) => {
        v.setUint32(0, 0x02014b50, true); // central directory header
        v.setUint16(4, 20, true);
        v.setUint16(6, 20, true);
        v.setUint16(8, 0x0808, true);
        v.setUint16(10, 0, true);         // store
        v.setUint16(12, time, true);
        v.setUint16(14, date, true);
        v.setUint32(16, e.crc, true);
        v.setUint32(20, e.size, true);
        v.setUint32(24, e.size, true);
        v.setUint16(28, e.nameBytes.length, true);
        v.setUint32(42, e.offset, true);
      }));
      await this.#out(e.nameBytes);
    }

    const cdSize = this.#offset - cdStart;
    const count = this.#entries.length;
    await this.#out(struct(22, (v) => {
      v.setUint32(0, 0x06054b50, true);   // end of central directory
      v.setUint16(8, count, true);
      v.setUint16(10, count, true);
      v.setUint32(12, cdSize, true);
      v.setUint32(16, cdStart, true);
    }));
  }
}
