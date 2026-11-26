# Releasing

How `@staix/agent-tex` reaches npm. The steps that publish or change repository settings are the owner's; agents prepare and verify but do not run them without an explicit instruction.

## One-time bootstrap (owner, before the first release)

npm trusted publishing can only be attached to a package that already exists, and `@staix/agent-tex` does not exist yet. The family convention is a placeholder version `0.0.0-stage` published once by hand, then trust, then every real version through the release workflow with provenance. The placeholder never takes a version the workflow needs.

Steps 1 and 2 need npm 11.15 or later (`npm trust`).

1. Publish the placeholder from an empty directory, logged in to npm as an owner of the `@staix` scope (2FA prompts as usual). The subshell stops at the first failure, so nothing is written outside the new directory:

   ```sh
   (set -e
   cd "$(mktemp -d)"
   printf '%s\n' '{"name":"@staix/agent-tex","version":"0.0.0-stage","description":"Name reservation for trusted publishing. Install 0.1.0 or later.","license":"MIT","repository":{"type":"git","url":"git+https://github.com/STAIxBWLB/agent-tex.git"}}' > package.json
   printf '%s\n' '# @staix/agent-tex' '' 'Name reservation. Install 0.1.0 or later.' > README.md
   npm publish --access public --tag stage
   npm deprecate @staix/agent-tex@0.0.0-stage "name reservation; install 0.1.0 or later")
   ```

2. Attach GitHub Actions trust (the workflow file, repository and environment must match `release.yml`):

   ```sh
   npm trust github @staix/agent-tex --file release.yml --repository STAIxBWLB/agent-tex --environment npm-production --allow-publish
   npm trust list @staix/agent-tex
   ```

   Optionally, in the package settings on npmjs.com, require 2FA and disallow tokens so only the workflow can publish.

3. In the GitHub repository, create the environment `npm-production` with required reviewers and a deployment policy that allows `v*` tags, then set the repository variable `NPM_PUBLISH_ENABLED=true`.

## Every release

1. On a branch: `bun run release:prepare X.Y.Z`, review the dated CHANGELOG section, open the PR, merge after review.
2. On an up-to-date `main` whose Check run is green: `bun run release:tag`. It refuses unless exact-commit CI passed and the tag is new.
3. The `v*` tag runs `release.yml`: CI gate, tag and changelog validation, stage and clean-prefix smoke on Linux and macOS, then npm publish with provenance (only with `NPM_PUBLISH_ENABLED=true`, after the environment's reviewers approve), then the GitHub release with the verified tarball and manifest.

A new environment image is published separately with an `image-v<tag>` tag and pinned in `src/image.ts` before the npm release that uses it.
