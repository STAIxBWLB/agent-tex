// Project config (atex.toml), user config and the detection rules of issue #3.
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
export type Engine = (typeof ENGINES)[number];
export interface Variant { name: string; classOptions: string[] }
export interface Extra { path: string; as: string }
export interface Limits { cpus: number; memory: string; pids: number }

export interface Config {
  root: string;
  main: string; // relative to root, posix
  engine: Engine;
  documentClass: string | null;
  variants: Variant[];
  dateEpoch: number;
  shellEscape: "restricted" | "unrestricted";
  latexmkrc: boolean;
  outputs: string[]; // absolute PDF paths, one per variant (or one)
  snapshot: { exclude: string[]; extra: Extra[]; maxBytes: number; maxFiles: number };
  limits: Limits;
  stateDir: string;
}

export class ConfigError extends Error {
  constructor(message: string, readonly next: string) { super(message); }
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const OPTION = /^[A-Za-z0-9=._-]{1,64}$/;
const DAY = 86_400;

/**
 * Read a regular file, refusing special files. Over `max` bytes it fails, unless `head` asks for just the first `max`
 * bytes (enough for detection in a large .tex file).
 */
export function readBounded(file: string, max: number, what: string, head = false): string {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { throw new ConfigError(`${what} cannot be opened`, `check that ${what} exists and is readable`); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ConfigError(`${what} is not a regular file`, `replace ${what} with a regular file`);
    if (st.size > max && !head) throw new ConfigError(`${what} is over ${max} bytes`, `shorten ${what}`);
    const data = Buffer.alloc(Math.min(st.size, max));
    let off = 0;
    for (let n; off < data.length && (n = readSync(fd, data, off, data.length - off, off)) > 0;) off += n;
    return data.subarray(0, off).toString("utf8");
  } finally { closeSync(fd); }
}

const CONFIG_MAX = 64 << 10;
const TEX_HEAD = 1 << 20;

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => !!v && typeof v === "object" && !Array.isArray(v);

function parseToml(file: string): Table {
  let data: unknown;
  const text = readBounded(file, CONFIG_MAX, basename(file));
  try { data = Bun.TOML.parse(text); }
  catch (error) { throw new ConfigError(`${basename(file)} is not valid TOML (${(error as Error).message})`, `fix the syntax of ${basename(file)}`); }
  return data as Table;
}

/** Refuse unknown keys and wrong types, naming the key. */
function check(table: Table, where: string, schema: Record<string, (v: unknown) => boolean>, hint: string): void {
  for (const [key, value] of Object.entries(table)) {
    const ok = schema[key];
    if (!ok) throw new ConfigError(`${where}: unknown key ${key}`, `remove ${key} or check its spelling (${hint})`);
    if (!ok(value)) throw new ConfigError(`${where}: ${key} has the wrong type or value`, hint);
  }
}

const str = (v: unknown) => typeof v === "string" && v.length > 0;
const strs = (v: unknown) => Array.isArray(v) && v.every(str);
const bool = (v: unknown) => typeof v === "boolean";
const posInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;

export function findRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "atex.toml"))) return dir;
    if (dirname(dir) === dir) return resolve(cwd);
  }
}

/** Text before \begin{document}, without comments. */
function preamble(text: string): string {
  const end = text.indexOf("\\begin{document}");
  return (end < 0 ? text : text.slice(0, end)).replace(/(?<!\\)%.*$/gm, "");
}

export function detectEngine(text: string): Engine {
  const magic = /^%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)/im.exec(text)?.[1]?.toLowerCase();
  if (magic && (ENGINES as readonly string[]).includes(magic)) return magic as Engine;
  const head = preamble(text);
  if (/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:fontspec|xeCJK)\b/.test(head)) return "xelatex";
  if (/\\directlua\b/.test(head)) return "lualatex";
  return "pdflatex";
}

export function documentClass(text: string): string | null {
  return /\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*([A-Za-z0-9._-]+)\s*\}/.exec(preamble(text))?.[1] ?? null;
}

export function detectMain(root: string): string {
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".tex"))
    .map(e => e.name)
    .filter(name => /\\documentclass\b/.test(readBounded(join(root, name), TEX_HEAD, name, true)))
    .sort();
  if (candidates.length === 1) return candidates[0]!;
  throw new ConfigError(
    candidates.length ? `several main files: ${candidates.join(", ")}` : "no .tex file with \\documentclass in the project root",
    candidates.length ? "pass one, e.g. atex build " + candidates[0] + ", or set main in atex.toml" : "pass the main file, e.g. atex build paper.tex, or set main in atex.toml",
  );
}

function userConfig(env: Record<string, string | undefined>): Limits {
  const limits: Limits = { cpus: 2, memory: "4g", pids: 512 };
  const file = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "atex", "config.toml");
  if (!existsSync(file)) return limits;
  const data = parseToml(file);
  check(data, "user config", { limits: isTable }, "see the user config section of the README");
  if (isTable(data.limits)) {
    check(data.limits, "user config [limits]", { cpus: v => typeof v === "number" && v > 0, memory: v => typeof v === "string" && /^[0-9]+[kmg]?$/i.test(v), pids: posInt },
      "cpus is a number, memory like \"4g\", pids a whole number");
    Object.assign(limits, data.limits);
  }
  return limits;
}

export interface LoadOptions { cwd: string; main?: string; out?: string; env?: Record<string, string | undefined>; now?: number }

export function loadConfig(opts: LoadOptions): Config {
  const env = opts.env ?? process.env;
  const root = findRoot(opts.cwd);
  const file = join(root, "atex.toml");
  const data: Table = existsSync(file) ? parseToml(file) : {};
  const hint = "see atex.toml in the README";
  check(data, "atex.toml", {
    main: str, engine: v => (ENGINES as readonly unknown[]).includes(v), out: str, date: v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
    shellEscape: v => v === "restricted" || v === "unrestricted", latexmkrc: bool, variants: v => Array.isArray(v) && v.every(isTable), snapshot: isTable,
  }, hint);

  let main = opts.main ? relative(root, resolve(opts.cwd, opts.main)) : (data.main as string | undefined) ?? detectMain(root);
  main = main.split("\\").join("/");
  if (!main.endsWith(".tex") || isAbsolute(main) || main.split("/").includes("..") || !existsSync(join(root, main)) || !statSync(join(root, main)).isFile()) {
    throw new ConfigError(`main file ${main} is not a .tex file inside the project`, "pass a .tex file inside the project, or fix main in atex.toml");
  }
  const text = readBounded(join(root, main), TEX_HEAD, main, true);

  const variants: Variant[] = [];
  for (const v of (data.variants as Table[] | undefined) ?? []) {
    check(v, "atex.toml [[variants]]", { name: v => typeof v === "string" && NAME.test(v), classOptions: v => strs(v) && (v as string[]).every(o => OPTION.test(o)) },
      "name uses letters, digits, . _ -; classOptions is a list of plain option names");
    if (typeof v.name !== "string") throw new ConfigError("atex.toml [[variants]]: name is missing", "give every variant a name");
    if (variants.some(x => x.name === v.name)) throw new ConfigError(`atex.toml: variant ${v.name} appears twice`, "give every variant a distinct name");
    variants.push({ name: v.name, classOptions: (v.classOptions as string[] | undefined) ?? [] });
  }
  const cls = documentClass(text);
  if (variants.some(v => v.classOptions.length) && !cls) {
    throw new ConfigError(`${main} has no \\documentclass{...} to pass variant class options to`, "add \\documentclass to the main file or drop classOptions");
  }

  const snap = isTable(data.snapshot) ? data.snapshot : {};
  check(snap, "atex.toml [snapshot]", { exclude: strs, extra: v => Array.isArray(v) && v.every(isTable), maxBytes: posInt, maxFiles: posInt }, hint);
  const extra: Extra[] = [];
  for (const e of (snap.extra as Table[] | undefined) ?? []) {
    check(e, "atex.toml [snapshot] extra", { path: str, as: v => typeof v === "string" && NAME.test(v) }, "each extra is {path = \"../shared\", as = \"shared\"}");
    const path = resolve(root, String(e.path));
    if (typeof e.as !== "string" || !existsSync(path) || !statSync(path).isDirectory()) {
      throw new ConfigError(`atex.toml [snapshot] extra ${String(e.path)} is not a directory or has no as`, "point path at an existing directory and set as");
    }
    if (extra.some(x => x.as === e.as)) throw new ConfigError(`atex.toml [snapshot] extra as = ${e.as} appears twice`, "give every extra a distinct as");
    extra.push({ path, as: e.as });
  }

  const base = basename(main, ".tex");
  const names = variants.length ? variants.map(v => `${base}-${v.name}.pdf`) : [`${base}.pdf`];
  const outArg = opts.out ? resolve(opts.cwd, opts.out) : typeof data.out === "string" ? resolve(root, data.out) : join(root, dirname(main));
  let outputs: string[];
  if (outArg.endsWith(".pdf")) {
    if (names.length > 1) throw new ConfigError("out names one PDF file but the project builds several variants", "set out to a directory");
    outputs = [outArg];
  } else outputs = names.map(n => join(outArg, n));

  const now = opts.now ?? Date.now();
  const dateEpoch = typeof data.date === "string" ? Date.parse(`${data.date}T00:00:00Z`) / 1000 : Math.floor(now / 1000 / DAY) * DAY;
  if (!Number.isInteger(dateEpoch) || dateEpoch < 0) throw new ConfigError(`atex.toml: date ${String(data.date)} is not a valid day`, "write date as YYYY-MM-DD");

  return {
    root, main, engine: (data.engine as Engine | undefined) ?? detectEngine(text), documentClass: cls, variants, dateEpoch,
    shellEscape: (data.shellEscape as Config["shellEscape"] | undefined) ?? "restricted", latexmkrc: data.latexmkrc === true, outputs,
    snapshot: { exclude: (snap.exclude as string[] | undefined) ?? [], extra, maxBytes: (snap.maxBytes as number | undefined) ?? 200 << 20, maxFiles: (snap.maxFiles as number | undefined) ?? 5000 },
    limits: userConfig(env),
    stateDir: join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "atex"),
  };
}
