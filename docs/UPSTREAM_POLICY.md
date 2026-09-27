# Potato Upstream Policy

Potato is an independently maintained project.

## Upstream reference

The upstream reference is [Javis603/token-monitor](https://github.com/Javis603/token-monitor).

Current modernization baseline:

- Commit: `bce50dbdb67408dabd1a13758fd5009e36c88753`
- Upstream version: `0.58.0`
- Baseline date: `2026-09-17`

## Policy

- No automatic upstream synchronization.
- No automatic upstream merge or rebase.
- No version-number coupling.
- Upstream is reference-only after the independent baseline.
- Features and fixes are adopted selectively.
- Potato-specific architecture has priority after this baseline.
- The quality target is `NO UNINTENTIONAL DRIFT`, not permanent zero diff.

The normal adoption flow is to fetch and inspect upstream, review release notes and commits, create an adoption branch for a selected feature, analyze its dependencies, adapt it to Potato, test it, and record its provenance. The supported adoption modes are:

- `CLEAN_CHERRY_PICK` for an isolated commit with minimal conflict.
- `PATCH_TRANSPLANT` for selected hunks from a broader change.
- `DESIGN_PORT` for reimplementation of an upstream idea in the current Potato architecture.

`PATCH_TRANSPLANT` and `DESIGN_PORT` are the long-term defaults when the architectures differ.

## Source of truth and release ownership

- Authoritative repository target: `Gary06910/Potato`
- Authoritative local worktree: `token-monitor-wechat-delivery`
- Release owner target: `Gary06910/Potato`
- Potato update feed: the `Gary06910/Potato` Releases channel

Potato must not use a `Javis603/token-monitor` binary or release feed as its automatic update source. The updater implementation may retain applicable upstream algorithms, but release ownership and update endpoints remain Potato-specific.

## Attribution

Potato preserves the applicable MIT License, copyright notices, and upstream attribution. Independent branding, versioning, and release ownership do not remove the original author's license or attribution.
