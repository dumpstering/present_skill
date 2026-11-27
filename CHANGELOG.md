# Changelog

All notable changes to this plugin are listed here. Releases follow
[Semantic Versioning](https://semver.org), and entries after 1.0.0 are written
by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org).

## [1.1.0](https://github.com/dumpstering/present_skill/compare/v1.0.0...v1.1.0) (2026-11-27)


### Features

* session recap tab and thread ages on the loose threads board ([c5b2bf5](https://github.com/dumpstering/present_skill/commit/c5b2bf5d2aee355dbaa107e74dcfb7476f1dd4b5))
* session recap tab and thread ages on the loose threads board ([775d21c](https://github.com/dumpstering/present_skill/commit/775d21ca5ae357b4c4888a12991e8d5ef85a0c76))

## 1.0.0 (2026-11-27)

First versioned release, as a Claude Code plugin.

### Features

* Long replies, plans and questions open as a local browser page that updates in place, one tab per chat
* Designed slides: bold-led bullets become cards, bold numbers stat tiles, numbered lists step bubbles, an opening paragraph a cover ([#1](https://github.com/dumpstering/present_skill/pull/1))
* Tall sections continue onto extra slides instead of shrinking or scrolling ([#3](https://github.com/dumpstering/present_skill/pull/3))
* Plain prose and unbolded items get headline and card titles ([#4](https://github.com/dumpstering/present_skill/pull/4))
* Live, color-coded reply age in the header and history ([#5](https://github.com/dumpstering/present_skill/pull/5))
* `/present:present threads`: a ranked board of loose threads across Claude Code, Codex and Pi sessions ([#6](https://github.com/dumpstering/present_skill/pull/6))
* Slide navigation by scroll wheel, click, mouse side buttons and swipe ([#7](https://github.com/dumpstering/present_skill/pull/7))
* Packaged as a self-hosted plugin with hooks included and state kept in the plugin data folder ([#8](https://github.com/dumpstering/present_skill/pull/8))

### Fixes

* Thread effort reads as quick, one session or multi-session, so a card never shows "medium" twice
