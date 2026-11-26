// Bounded file helpers for the release scripts (scripts may import anything; src/ stays dependency-free).
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";

export function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Read a regular file, refusing links (noFollow), special files and anything over maxBytes without buffering it. */
export function readBytesBounded(path: string, maxBytes: number, options: { noFollow?: boolean } = {}): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (options.noFollow ? constants.O_NOFOLLOW : 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path}: not a regular file`);
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65_536, maxBytes + 1 - total));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error(`${path}: over ${maxBytes} bytes`);
      parts.push(chunk.subarray(0, n));
    }
    return Buffer.concat(parts);
  } finally { closeSync(fd); }
}

export function readTextBounded(path: string, maxBytes: number, options: { noFollow?: boolean } = {}): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(readBytesBounded(path, maxBytes, options)); }
  catch (error) { if (error instanceof TypeError) throw new Error(`${path}: not valid UTF-8`); throw error; }
}

export function assertWritable(text: string | Uint8Array, maxBytes: number, what: string): void {
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`${what} would exceed ${maxBytes} bytes`);
}

export function writeAtomic(path: string, text: string | Uint8Array, maxBytes: number, mode = 0o644): void {
  assertWritable(text, maxBytes, path);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    if (typeof text === "string") writeSync(fd, text);
    else for (let offset = 0; offset < text.length;) offset += writeSync(fd, text, offset, text.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (error) { try { unlinkSync(tmp); } catch { /* already gone */ } throw error; }
}
