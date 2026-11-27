# ADR-001: Ship present as a self-hosted Claude Code plugin

**Date:** 2026-11-27T04:30:31Z
**Status:** accepted (its "no version" choice is superseded by [ADR-002](002-versioned-releases.md))

## Context

present was installed by cloning this repo into `~/.claude/skills/present`, with hooks added by hand to `~/.claude/settings.json`. Updates meant a manual `git pull`. The owner asked for it to auto-update.

## Decision

The repo is a plugin and its own marketplace (`present@present-marketplace`, PR #8):

- `.claude-plugin/plugin.json` has no `version`, so each commit to `main` is an update.
- The skill lives in `skills/present/`, and hooks ship in `hooks/hooks.json`.
- Pages, settings, the log and the `OFF` switch live in the plugin data folder (`CLAUDE_PLUGIN_DATA` for hooks, `PRESENT_DATA` passed by the skill's commands). A plugin update replaces the code folder, so state kept there would be lost.
- Installs turn on `autoUpdate` for the marketplace under `extraKnownMarketplaces`.

## Consequences

- Updates arrive in the background and load on the next start or `/reload-plugins`.
- The skill is invoked as `/present:present`, because plugin skills are namespaced.
- Plugin hooks call `python3`, so Windows users wire the hooks by hand (README).
- Uninstalling deletes the data folder, including saved pages and the chosen style.

## Alternatives Considered

- Keep the skill clone and add a scheduled `git pull`: rejected, because it adds a script to maintain and does nothing for the hooks.
- List the plugin in the owner's existing `netstoat-labs-skills` marketplace: rejected, because a self-hosted marketplace keeps this repo the single source.

Sources: https://code.claude.com/docs/en/plugins/marketplace-reference.md, https://code.claude.com/docs/en/plugins/host-marketplace.md, https://code.claude.com/docs/en/plugins/loading.md
