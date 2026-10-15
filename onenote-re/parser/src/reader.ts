// Little-endian cursor over a byte buffer. Every structure in the revision
// store is little-endian and byte-packed (no implicit alignment).

export class ParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at 0x${offset.toString(16)})`);
    this.offset = offset;
  }
}

export class Reader {
  readonly buf: Uint8Array;
  readonly view: DataView;
  readonly start: number;
  readonly end: number;
  pos: number;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    if (start < 0 || end > buf.length || start > end) {
      throw new ParseError(`range [${start}, ${end}) outside buffer of ${buf.length}`, start);
    }
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.start = start;
    this.end = end;
    this.pos = start;
  }

  /** Reader over [offset, offset + length) of the same underlying buffer. */
  sub(offset: number, length: number): Reader {
    return new Reader(this.buf, offset, offset + length);
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) {
      throw new ParseError(`need ${n} bytes, ${this.remaining} left`, this.pos);
    }
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  peekU32(): number {
    this.need(4);
    return this.view.getUint32(this.pos, true);
  }

  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** u64 that must fit in a JS number (file offsets and sizes). */
  u64n(): number {
    const v = this.u64();
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  guid(): string {
    return formatGuid(this.bytes(16));
  }
}

/** Format a 16-byte little-endian GUID as {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}. */
export function formatGuid(b: Uint8Array): string {
  const h = (i: number) => b[i]!.toString(16).padStart(2, "0");
  const d1 = h(3) + h(2) + h(1) + h(0);
  const d2 = h(5) + h(4);
  const d3 = h(7) + h(6);
  const d4 = h(8) + h(9);
  const d5 = h(10) + h(11) + h(12) + h(13) + h(14) + h(15);
  return `{${d1}-${d2}-${d3}-${d4}-${d5}}`.toUpperCase();
}

export const NIL_GUID = "{00000000-0000-0000-0000-000000000000}";

export function utf16le(bytes: Uint8Array): string {
  let s = new TextDecoder("utf-16le").decode(bytes);
  // Strings are frequently stored with a trailing NUL.
  while (s.endsWith("\u0000")) s = s.slice(0, -1);
  return s;
}

export function latin1(bytes: Uint8Array): string {
  let s = new TextDecoder("latin1").decode(bytes);
  while (s.endsWith("\u0000")) s = s.slice(0, -1);
  return s;
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
