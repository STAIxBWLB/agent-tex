# agent-tex

- Implement the accepted issue contract (the phase's child spec under #1) on a branch with a PR. Change the spec first when the code must differ.
- Source is in `src/`, the bootstrap in `bin/`, checks in `scripts/`, tests and synthetic fixtures in `test/`.
- Strict TypeScript, `.ts` imports, `noUncheckedIndexedAccess`. Runtime imports: relative files, Node builtins and `bun:` only (`scripts/check-boundary.ts`).
- Verify with `bun install --frozen-lockfile && bun run check`. Passing output ends with `boundary: ok`, `0 fail` and the package dry-run listing.
- Never install or call TeX on the host. TeX runs only inside the container image.
- The working folder receives sources and the output PDF only. Intermediates, logs and receipts go to the state directory.
- The output tar from the container is untrusted: validate names, path escapes and size before writing anything. A failed build leaves an existing PDF untouched.
- Secrets patterns (`.env*`, key files, `.git`) never enter the snapshot. No symlink may leave the project root.
- No model calls inside atex. It builds, checks and renders.
- Unit tests never touch the network or need a container runtime; container tests are opt-in and skip when no runtime is present.
- Keep unimplemented phases out of the CLI and README command list.
- Public repo: no internal host names, accounts or manuscript names in code, tests, issues or PRs.
- Conventional English commits, no coauthor trailers unless requested.
