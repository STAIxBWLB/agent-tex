// Stream protocol v1 (issue #3): the host writes a tar to atex-run's stdin and reads a tar from its stdout.
// The output tar is untrusted: readOutput accepts only regular files on the allow-list, within size caps,
// and checks result.json against the bytes it describes. Any violation is a ProtocolError (exit 3).

export interface Variant { name: string; classOptions: string[] }

export interface Job {
  v: 1;
  main: string;
  engine: "pdflatex" | "xelatex" | "lualatex";
  variants: Variant[];
  dateEpoch: number;
  shellEscape: "restricted" | "unrestricted";
  latexmkrc: boolean;
  fresh: boolean;
}

export interface Output { variant: string; path: string; sha256: string; pages: number | null }

export interface Result {
  v: 1;
  status: "ok" | "failed";
  steps: { name: string; exitCode: number; seconds: number; upToDate: boolean }[];
  outputs: Output[];
  omitted: { path: string; bytes: number; cap: number; next: string }[];
}

export class ProtocolError extends Error {}

const BLOCK = 512;
const enc = new TextEncoder();

// Caps on what the container may send back. A larger output fails the build instead of being written.
export const OUTPUT_CAPS = { total: 640 << 20, pdf: 512 << 20, log: 64 << 20, fls: 16 << 20, result: 1 << 20 } as const;

function octal(buf: Uint8Array, offset: number, width: number, value: number) {
  buf.set(enc.encode(value.toString(8).padStart(width - 1, "0")), offset);
}

function header(name: string, size: number, type: "0" | "x"): Uint8Array {
  const h = new Uint8Array(BLOCK);
  h.set(enc.encode(name).subarray(0, 100), 0);
  octal(h, 100, 8, 0o644);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, 0);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode("ustar\u000000"), 257);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\u0000 "), 148);
  return h;
}

/** The header block(s) for one regular file; a PAX record carries names over 100 bytes. */
export function tarHeader(name: string, size: number): Uint8Array[] {
  if (enc.encode(name).length <= 100) return [header(name, size, "0")];
  const body = (len: number) => `${len} path=${name}\n`;
  let len = enc.encode(body(0)).length;
  while (enc.encode(body(len)).length !== len) len = enc.encode(body(len)).length;
  const record = enc.encode(body(len));
  return [header("././@PaxHeader", record.length, "x"), padded(record), header(name.slice(-100), size, "0")];
}

export function padding(size: number): Uint8Array {
  return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + padding(data.length).length);
  out.set(data);
  return out;
}

export const TAR_END = new Uint8Array(BLOCK * 2);

/** One in-memory tar (tests and small payloads). */
export function tar(entries: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, data] of entries) parts.push(...tarHeader(name, data.length), data, padding(data.length));
  parts.push(TAR_END);
  return Buffer.concat(parts);
}

function text(buf: Uint8Array, start: number, end: number): string {
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  return new TextDecoder().decode(nul === -1 ? slice : slice.subarray(0, nul));
}

function parseOctal(buf: Uint8Array, start: number, end: number): number {
  const raw = text(buf, start, end).trim();
  if (!/^[0-7]+$/.test(raw)) throw new ProtocolError("output tar has a malformed header field");
  return parseInt(raw, 8);
}

/** Parse a tar of regular files only; links, directories, devices and global headers are refused. */
export function readTar(data: Uint8Array, caps: (name: string) => number): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let paxPath: string | null = null;
  while (offset + BLOCK <= data.length) {
    const h = data.subarray(offset, offset + BLOCK);
    if (h.every(byte => byte === 0)) return files;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i] ?? 0;
    if (parseOctal(h, 148, 156) !== sum) throw new ProtocolError("output tar has a bad header checksum");
    const type = String.fromCharCode(h[156] ?? 0);
    const size = parseOctal(h, 124, 136);
    const start = offset + BLOCK;
    const end = start + size;
    offset = start + size + padding(size).length;
    if (type === "x") {
      if (end > data.length) throw new ProtocolError("output tar is truncated");
      if (size > 64 << 10) throw new ProtocolError("output tar has an oversized PAX header");
      const record = new TextDecoder().decode(data.subarray(start, end));
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(record);
      paxPath = match?.[1] ?? null;
      if (/(?:^|\n)\d+ (?!path=|mtime=|atime=|ctime=)[^=\n]+=/.test(record)) throw new ProtocolError("output tar has unsupported PAX fields");
      continue;
    }
    if (type !== "0" && type !== "\0") throw new ProtocolError(`output tar has a non-regular entry (type ${JSON.stringify(type)})`);
    const prefix = text(h, 345, 500);
    const name = paxPath ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    paxPath = null;
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some(part => part === ".." || part === "." || part === "")) {
      throw new ProtocolError(`output tar entry ${JSON.stringify(name)} escapes or is not normalized`);
    }
    const cap = caps(name);
    if (cap < 0) throw new ProtocolError(`output tar entry ${JSON.stringify(name)} is not an expected output`);
    if (size > cap) throw new ProtocolError(`output tar entry ${name} is ${size} bytes, over its ${cap}-byte cap`);
    if (files.has(name)) throw new ProtocolError(`output tar repeats ${name}`);
    if (end > data.length) throw new ProtocolError("output tar is truncated");
    files.set(name, data.subarray(start, end));
  }
  throw new ProtocolError("output tar has no end marker");
}

/** The output names a job may produce: one jobname per variant, or the main file's name. */
export function jobnames(job: Job): string[] {
  const base = job.main.split("/").pop()!.replace(/\.tex$/, "");
  return job.variants.length ? job.variants.map(v => `${base}-${v.name}`) : [base];
}

export async function sha256(data: Uint8Array): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** Validate the container's output tar for this job. Returns the result and the PDF bytes by jobname. */
export async function readOutput(data: Uint8Array, job: Job): Promise<{ result: Result; pdfs: Map<string, Uint8Array>; log: string }> {
  if (data.length > OUTPUT_CAPS.total) throw new ProtocolError(`output tar is over ${OUTPUT_CAPS.total} bytes`);
  const names = jobnames(job);
  const allowed = new Map<string, number>([["result.json", OUTPUT_CAPS.result]]);
  for (const n of names) {
    allowed.set(`out/${n}.pdf`, OUTPUT_CAPS.pdf);
    allowed.set(`log/${n}.log`, OUTPUT_CAPS.log);
    allowed.set(`deps/${n}.fls`, OUTPUT_CAPS.fls);
  }
  const files = readTar(data, name => allowed.get(name) ?? -1);
  const raw = files.get("result.json");
  if (!raw) throw new ProtocolError("output tar has no result.json");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new ProtocolError("result.json is not JSON"); }
  const result = checkResult(parsed, names);
  const pdfs = new Map<string, Uint8Array>();
  for (const out of result.outputs) {
    const bytes = files.get(out.path);
    if (!bytes) throw new ProtocolError(`result.json lists ${out.path}, which the tar does not contain`);
    if (await sha256(bytes) !== out.sha256) throw new ProtocolError(`${out.path} does not match its sha256 in result.json`);
    pdfs.set(out.path.slice(4, -4), bytes);
  }
  if (result.status === "ok" && pdfs.size !== names.length) throw new ProtocolError("result.json reports ok but lists fewer PDFs than the job builds");
  for (const name of files.keys()) {
    if (name.startsWith("out/") && !result.outputs.some(o => o.path === name)) throw new ProtocolError(`${name} is not listed in result.json`);
  }
  const log = names.map(n => files.get(`log/${n}.log`)).filter(Boolean).map(b => new TextDecoder().decode(b)).join("\n");
  return { result, pdfs, log };
}

function checkResult(value: unknown, names: string[]): Result {
  const fail = (what: string): never => { throw new ProtocolError(`result.json: ${what}`); };
  if (!value || typeof value !== "object") fail("not an object");
  const r = value as Record<string, unknown>;
  if (r.v !== 1) fail("v is not 1");
  if (r.status !== "ok" && r.status !== "failed") fail("status is not ok or failed");
  if (!Array.isArray(r.steps) || !Array.isArray(r.outputs) || !Array.isArray(r.omitted)) fail("steps, outputs or omitted is not an array");
  for (const s of r.steps as unknown[]) {
    const step = s as Record<string, unknown>;
    if (typeof step?.name !== "string" || !Number.isInteger(step.exitCode) || typeof step.seconds !== "number" || typeof step.upToDate !== "boolean") fail("malformed step");
  }
  const paths = new Set(names.map(n => `out/${n}.pdf`));
  for (const o of r.outputs as unknown[]) {
    const out = o as Record<string, unknown>;
    if (typeof out?.path !== "string" || !paths.has(out.path)) fail("an output path is not an expected PDF");
    if (typeof out.variant !== "string" || typeof out.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(out.sha256)) fail("malformed output");
    if (out.pages !== null && !(Number.isInteger(out.pages) && (out.pages as number) >= 0)) fail("malformed page count");
  }
  return r as unknown as Result;
}
