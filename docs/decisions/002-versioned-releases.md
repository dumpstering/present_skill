# ADR-002: Versioned releases with release-please

**Date:** 2026-11-27T04:49:02Z
**Status:** accepted

## Context

ADR-001 shipped the plugin without a `version`, so every commit to `main` reached installed copies. The owner asked for mature, presentable versioning, and chose release PRs over a release on every merge.

## Decision

- `.claude-plugin/plugin.json` carries a semver `version`, starting at 1.0.0 (PR #10).
- release-please (`googleapis/release-please-action`, pinned to a commit SHA) keeps a release PR open after each merge to `main`. It picks the next version from Conventional Commits and drafts `CHANGELOG.md`.
- Merging the release PR tags `vX.Y.Z`, publishes a GitHub Release and bumps `plugin.json` through the `extra-files` JSON updater. Installs with auto-update take the new version on their next check.
- CI runs Python tests (3.10, 3.14), browser checks (Chromium, Firefox, WebKit) and `claude plugin validate` on every PR. Dependabot keeps the action pins current.

## Consequences

- Installs only move on a deliberate release, and each release has notes.
- Merging to `main` no longer ships by itself. Someone has to merge the release PR.
- Commit messages must follow Conventional Commits to land in the changelog.
- The repo needs "Allow GitHub Actions to create and approve pull requests" turned on by an admin.

## Alternatives Considered

- Keep commit-based updates (supersedes ADR-001's "no version" choice): rejected, because there are no version numbers or notes to show people.
- Release on every merge (semantic-release style): rejected by the owner in favor of batching changes into release PRs.

Sources: https://github.com/googleapis/release-please/blob/main/docs/customizing.md, https://github.com/googleapis/release-please-action
