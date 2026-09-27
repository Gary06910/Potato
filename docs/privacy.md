# Potato Privacy Policy

Potato is local-first, but it is not a pure offline application. It processes usage logs and usage statistics locally and does not send analytics or telemetry to the project maintainer. Potato has no default public usage-collection server; network access occurs only for documented or user-enabled features.

## Network features

Potato may make network requests for these documented or user-enabled features:

- Packaged builds check GitHub Releases for update metadata and downloads. GitHub is the update service for the Potato Desktop feed; see the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- Exchange-rate and service-status views fetch their public data sources.
- Enabled AI Tool Limits integrations contact the corresponding provider. Credentials are sent only to that provider.
- The optional Codex reset forecast fetches codex-resets.com, a third-party source that is not OpenAI.
- Discord Rich Presence sends the selected activity details to Discord when explicitly enabled; see the [Discord Privacy Policy](https://discord.com/privacy).
- Multi-device sync sends data to the hub URL configured by the operator.
- Potato Android notifications send an allowlisted completion event from Desktop to the user-configured Potato backend / uniCloud only after the user pairs the Desktop and enables notifications. The configured backend then handles task persistence and Android notification delivery through the Potato mobile path.

Review the privacy policy of the service receiving data before enabling a provider-backed integration or connecting a self-hosted deployment. Potato does not sell usage data to advertisers.

## Potato Android notifications

The Desktop-to-Android notification path is opt-in and uses the API URL and credential selected by the user. The event contains a stable event identity, Desktop identity, session identity, completion time, privacy-mode flag, and the allowlisted fields described below.

Privacy mode is enabled by default. It excludes project, model, summary, duration, prompt text, full conversation history, working directory, source code, file contents, environment variables, and raw provider responses. The backend rejects unexpected content fields in privacy mode.

Full mode is an explicit user choice. It may send a project basename or alias, model, duration, and a bounded one-paragraph completion summary to the configured backend/task record. It still does not send a prompt, full conversation, absolute working directory, source tree, or file contents.

The current Potato Android system notification uses generic completion text and task identity. It does not include prompt text, reply text, `cwd`, terminal output, source code, file contents, credential material, token material, task body, or summary content. Notification delivery can be disabled by the user and may fail; a provider success response is required before the backend records it as sent.

## Multi-device sync

Multi-device sync is optional and has no Potato-operated default server. The operator chooses and controls the destination hub, whether it runs in the app, on a self-hosted Node server, or on Cloudflare Workers.

When enabled, sync can send device identifiers and metadata; aggregate token and cost totals; client, model, session, and project attribution; retained usage history; and normalized provider-limit status. Project attribution can include an opaque project identifier and workspace-folder label, but never an absolute workspace path. Provider limits can include a hashed account identifier, account email, and plan label so the authenticated hub can distinguish accounts.

Sync also carries manually recorded subscription metadata when any exists: the plan name, amount, currency, billing cadence, dates you entered, and the account each record is bound to. These are values you typed in, never read from a provider, and they are stored once per hub rather than per device. The public stats endpoints never expose them.

Sync does not send raw AI logs, prompts, source code, conversation content, OAuth credentials, access or refresh tokens, provider cookies, API keys, or raw provider responses. See the [API documentation](API.md) for the current wire format and public-endpoint redactions.

Data retention and access on a synchronized or notification-enabled deployment are controlled by the operator of that backend and its infrastructure provider. Potato does not sell this data to advertisers.
