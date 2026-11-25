# Review

- Compare the complete diff with the linked phase spec (child issue of #1) and its acceptance criteria.
- Important: a file from the container's output tar written without name, path-escape and size validation; an intermediate file written to the working folder; an existing PDF replaced by a failed build.
- Important: a secrets pattern or `.git` entering the snapshot, a symlink leaving the project root followed, or a host path, alias or account written to `atex.toml`, a receipt or command output.
- Important: a container started with network, a writable root file system, added capabilities, root user or no resource limits; shell escape enabled without a project opt-in.
- Important: unbounded reads (files, stdin, tar streams, logs), unknown config fields accepted silently, a write before validation, an exit code outside the contract in #1.
- Important: a delete or rewrite (`clean`, `adopt`) applied without preview and fingerprint confirmation; CLI behaviour that differs from the MCP handler for the same operation.
- Check that unit tests stay offline and container-free, and that a test exists for each acceptance criterion it claims.
- Error messages: a new or changed error a person or agent sees names the cause and the next step (the command, setting or file that fixes it).
- Do not report: formatting, naming preferences, `ponytail:` simplifications that state their ceiling, generated `bun.lock`. At most five nits.
