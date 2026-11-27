# Changelog

All notable changes to this plugin are listed here. Releases follow
[Semantic Versioning](https://semver.org), and entries after 1.0.0 are written
by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org).

## [1.1.0](https://github.com/dumpstering/present_skill/compare/v1.0.0...v1.1.0) (2026-11-27)

### Features

* Session recap tab and thread ages on the loose threads board ([#11](https://github.com/dumpstering/present_skill/pull/11))

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
