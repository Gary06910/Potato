# Potato P1 cross-platform handoff

This is a development integration candidate for native platform acceptance. Product version remains 1.0.0. The Windows promotion receipt supplies the full `P1_5_PINNED_COMMIT_SHA`; macOS and Linux must verify and check out that exact commit in isolated directories. A moving branch name alone is insufficient. This document cannot embed its own commit SHA.

## Fixed sources

- Application upstream: `Javis603/token-monitor`, stable `v0.74.0`, peeled commit `cbed5915e294abb4a210f7ebb385e9415f706821`.
- Tokscale: `4.20.0`, fork `Javis603/tokscale`, commit `324d51362201b746fc35c2f2a3793c971f01d5aa`, vendor release `token-monitor-324d5136`.
- `scripts/vendor/tokscale.json` records all nine platform assets and SHA256 pins. Install each platform's own dependencies and run the vendor ensure/check gates. Windows dependencies and binaries must not be reused on another OS.
- macOS arm64 asset SHA256: `9d0f64bec1b564e19afbc93cb152a5aa82c5e2a10fba4a95a3d5bbc789718a10`.
- Linux x64 asset SHA256: `6d147e46acea5dd5452493a8b4357ae0112441c4e90edaa55aaef7c0ee77fadf`.

## Integrated behavior

| Stage | Included contracts |
| --- | --- |
| P1.1 | Pinned fork binary/provenance, authoritative bundled resolver, read-only legacy pointer handling, Server Agent packaging contract; standalone Tokscale updating retired. |
| P1.2 | 37 client IDs, 35 defaults, MiMo aliases, Pi/OMP generation 2, one-time preference seeding, daily/client/session archive identity compatibility. |
| P1.3 | Shared source registry, health/watch/WSL markers, isolated fork probes, native Proma/Qoder CN ownership, Qoder read-only source guard, CatPaw source-set replay/fingerprint, covered-interval coalescing. |
| P1.4 | Five custom price fields, manual/provider rule preservation, pricing revision, atomic price/source replay, historical repricing, SQLite V1 concurrency/recovery, token-component provenance/Unclassified, duration-weighted period/model throughput and optional wire fields. |

Desktop-to-Android notifications, Codex Stop Hook, Server Agent notifications, Remote Usage, device composition, CloudBase schema, Android pairing, branding and compatible application/data identities remain in scope for regression checks. Legacy Proma/Qoder JavaScript parsers are retained only as test fixtures and are absent from the production package.

## Windows evidence and limitations

Windows cumulative targeted regression: 806 total, 803 pass, 3 existing platform skips, zero failures. `npm run lint` passes. `npm run verify` reports 5248 total, 5237 pass, 2 failures, 9 skips, zero cancelled. The two failures are unchanged baseline assertions at `tests/docs/readmeConsistency.test.js:188` and `:250` (native macOS Widget prose and tool-count prose regex). They remain enabled. No new Usage/Cost/Archive/Notification regression was observed.

Windows directory packaging uses `--win dir --x64 --publish never`. Native fixtures, custom pricing replay and real SQLite multiprocess recovery pass. Unsigned Windows output, manual visual acceptance and a real installer upgrade remain separate release-stage work. Windows evidence does not establish macOS, Linux or real WSL acceptance.

Known constraints to carry forward:

- Aggregate-only legacy Pi history cannot be precisely split without original session evidence; missing model/component/duration provenance stays unavailable.
- Default MiMo tracking retains the upstream Claude-import overlap policy; explicit saved selections are preserved.
- An unreadable Qoder legacy database retains the last complete joint snapshot and delays that local refresh until recovery.
- Native unknown-model cost zero lacks unpriced-token provenance and does not establish a free price.
- Previously observed Agent concurrency timeouts and installer empty-stderr intermittency remain unexplained; successful later runs do not establish a root-cause fix.
- Repository-visible workflows and hooks can be audited; external service subscriptions outside available repository metadata remain unverified.

## macOS arm64 acceptance

Use the pinned SHA with native arm64 dependencies/binary and isolated HOME, appData, userData, XDG/config/cache and source fixtures. Verify native scanners, source health/watch, fork-only clients, all pricing/cache-write fields, history/archive, SQLite recovery/ownership, token provenance and throughput. Build and inspect an Electron app plus macOS widgets, menu bar/tray and permissions behavior. Run notification/remote/schema regressions with injected senders. Never alter the real Keychain, Login Items or existing installation. Sparkle updating belongs to P6.

## Linux x64 acceptance

Use the same pinned SHA with native x64 dependencies/binary. Isolate HOME, XDG/config/cache, archive, install and service paths. Verify native parsers, pricing, history/archive, SQLite multiprocess recovery, Server Agent once/run, Linux packaging, snapshot wire compatibility, service-manager fixtures, dry-run and notification schema with mock senders. Preserve the production Agent 1.0.0 installation and all running services, GPU/CUDA/Python/tmux/training workloads. No production service operation is authorized.

## Promotion and change control

Only the independent development branch `codex/potato-p1-tokscale-420` may receive this integration candidate. Main, Preview tags, Release creation, production update metadata, CloudBase/Worker/Android deployment and the production Server Agent are outside this acceptance authorization. The six existing workflows are unchanged; this branch push does not match their push filters. Do not manually dispatch publication workflows.

Mac/Linux acceptance must leave the pinned candidate unchanged. Report real source defects to the integration owner; a repair requires a new integration commit and a new shared pinned SHA. No automatic entry into P1.5-M or P1.5-L follows Windows promotion. Timezone R2, automatic updating and P2-P7 migrations remain deferred.
