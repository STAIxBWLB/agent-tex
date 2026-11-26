import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway project: { "path": "content" }. */
export function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atex-test-")));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

export const DOC = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";
/** Config env that never reads the developer's own user config or state. */
export const env = (root: string) => ({ XDG_CONFIG_HOME: join(root, "..", "no-config"), XDG_STATE_HOME: `${root}-state` });
