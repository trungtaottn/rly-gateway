# RLY Gateway

[![PR validation](https://github.com/trungtaottn/RLY-Gateway/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/trungtaottn/RLY-Gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

RLY Gateway is a local, protocol-preserving gateway for running Claude Code and
Codex CLI through explicit provider, account-pool, and model policies. It keeps
credentials and runtime state on the user's machine, binds its data and
management APIs to loopback, and leaves native Claude and Codex configuration
untouched.

```text
Claude Code / Codex CLI
          ↓
  RLY profile and model policy
          ↓
 provider + eligible account pool
          ↓
 direct, OAuth, or reviewed interop adapter
```

## Highlights

- Launch named Claude profiles with `rly <profile>` such as `rly codex` or
  `rly deepseek`.
- Route Anthropic Messages and OpenAI Responses without flattening streaming,
  tools, reasoning, usage, or stop semantics.
- Keep provider, physical model, account pool, and reasoning policy as separate
  decisions.
- Discover Claude-compatible `claude-rly-*` model projections through the
  authenticated `/v1/models` gateway surface.
- Inspect the actual request-time provider and physical model with
  `rly route-trace`.
- Manage providers, accounts, pools, profiles, quota, and traces through a
  loopback-only Config UI.
- Install a self-contained per-user runtime. Released artifacts bundle their
  own pinned Node.js runtime and do not require sudo, npm, or pnpm.

## Release availability

The v0.1.0 Stable release publishes a qualified Linux x86-64 artifact. macOS
Apple Silicon, macOS Intel, and Linux ARM64 builds remain experimental and are
not published to Stable until each target passes the same exact-byte gates on
a matching provisioned runner. The resident Linux service requires a reachable
`systemd --user` manager. RLY does not enable lingering or install a root service.

## Install

The stable bootstrap verifies signed channel metadata, the signed release
manifest, the artifact checksum, its Ed25519 signature, and its unpacked tree
before installation.

```bash
curl -fsSLO https://github.com/trungtaottn/RLY-Gateway/releases/latest/download/install.sh
sh install.sh --channel stable
```

Requirements are limited to `curl`, `tar`, a SHA-256 utility, and OpenSSL 3
with Ed25519 `pkeyutl -rawin` support. On macOS, install OpenSSL 3 first:

```bash
brew install openssl@3
```

The installer writes only to user-owned locations:

```text
~/.rly                 control plane, runtime and logs
~/.local/bin/rly       stable launcher symlink
```

Add `~/.local/bin` to `PATH` if it is not already present.

## First run

Initialize the per-user service and open the local Config UI:

```bash
rly init
rly config
```

In Config UI:

1. Add a provider.
2. Add or import an account using a pseudonym.
3. Create a provider-scoped account pool.
4. Create a Claude or Codex profile and map its model roles.
5. Launch the profile by name.

```bash
rly <profile>
```

For example, a Claude profile named `codex` launches with `rly codex`.
`rly run codex` is different: it launches Codex CLI directly through the RLY
gateway. Provider names are not harness names.

## Model identity and switching

RLY deliberately separates three values:

| Value | Meaning |
| --- | --- |
| Requested selector | The role, native alias, exact model ID, or `claude-rly-*` projection sent by the client |
| Resolved target | The provider and physical model selected by the frozen session policy |
| Executed target | The request-time decision recorded before account selection |

Claude's model picker is an intent surface; `rly route-trace` is execution
evidence. Model projections have provider-aware display names and reversible
IDs. A model selection applies inside the current session universe. Editing a
profile changes new sessions only; it never silently mutates a running
session's frozen provider/model policy.

Fresh installations may show an empty model list because unreviewed models are
classified as experimental. Enable experimental discovery explicitly in the
gateway configuration or promote models through reviewed compatibility
evidence. Exact configured model routes continue to work independently of
picker visibility. The OpenRouter physical model
`deepseek/deepseek-v4-flash-0731` is admitted as EXPERIMENTAL catalog evidence
with declared context/output limits; it is not a reviewed live-canary path.

## Common commands

```bash
rly init
rly config
rly config status
rly status
rly doctor
rly quota
rly route-trace
rly cost --since 7d --group-by model --json
rly cost --prune 90d

rly <profile>
rly run claude --profile <profile> --
rly run codex -- --help

rly gateway status
rly gateway stop
rly gateway start

rly update --channel stable
rly uninstall
rly uninstall --purge --yes
```

Headless control-plane examples:

```bash
rly config providers list
rly config providers create --name openrouter --mode direct
rly config accounts create --provider-id <provider-id> --pseudonym acct-1 \
  --credential-env OPENROUTER_API_KEY
rly config providers create --name codex --mode oauth
rly config accounts login --provider-id <provider-id> --pseudonym acct-1
rly config pools create --name codex-pool --provider-id <provider-id> \
  --strategy fill-first --accounts <account-id>
rly config profiles create --name codex --harness claude \
  --provider-id <provider-id> --pool-id <pool-id> \
  --roles '{"primary":"gpt-5.4","fast":"gpt-5.4","reasoning":"gpt-5.4"}'
```

Never paste access tokens, refresh tokens, account identities, prompts, or
responses into commands, issues, or diagnostic attachments.

## Updates and uninstall

RLY separates acquisition from activation:

```bash
rly update --channel stable   # acquire, verify and stage
rly update                    # activate with drain, verify and rollback
```

Existing sessions keep using the old runtime until they drain. Failed
activation rolls back to the previous known-good runtime.

Default uninstall removes RLY-owned service and runtime artifacts but preserves
configuration and credential state. Full removal is explicit and destructive:

```bash
rly uninstall
rly uninstall --purge --yes
```

### Prerelease signing-key reset

The private beta builds used a prerelease signing key that v0.1.0 intentionally
replaces. An installed `v1.0.0-beta.*` client therefore cannot update in place
to v0.1.0; signature verification fails closed before activation. Preserve the
installation record and durable state, download a fresh v0.1.0 bootstrap, then
reinstall. Current releases preserve the secret-free installation record by
default; legacy beta uninstallers remove it, so beta users must preserve and
restore that record to retain an external custom config path:

```bash
(
  set -eu
  test -f "$HOME/.rly/installation.json"
  RLY_INSTALL_RECORD="$(mktemp)"
  trap 'rm -f "$RLY_INSTALL_RECORD"' EXIT HUP INT TERM
  cp "$HOME/.rly/installation.json" "$RLY_INSTALL_RECORD"
  rly uninstall
  mkdir -p "$HOME/.rly"
  cp "$RLY_INSTALL_RECORD" "$HOME/.rly/installation.json"
  chmod 600 "$HOME/.rly/installation.json"
  curl -fsSLO https://github.com/trungtaottn/RLY-Gateway/releases/download/v0.1.0/install.sh
  sh install.sh --channel stable --version 0.1.0
  rly doctor
)
```

Do not use `rly uninstall --purge --yes` for this reset: purge destroys RLY
configuration, accounts, credentials, and its control-plane database. The
service is unavailable during reinstall; verify providers and profiles before
resuming work.

## Security and privacy

- Data and management listeners bind to `127.0.0.1`.
- Management mutations require authentication, Origin/CSRF validation, and
  optimistic versions.
- Credentials are referenced by environment variable or project-owned handle;
  raw values do not enter Git or SQLite.
- Prompt and response bodies are not logged by default.
- Account rotation stops after the first response byte or tool event.
- RLY never kills a foreign process merely because it owns a configured port.
- Native `~/.claude` and Codex configuration are read/compose inputs, not RLY
  mutation targets.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## Development

Source development requires Node.js 24 and pnpm 11.16:

```bash
pnpm install --frozen-lockfile
cp gateway.config.example.toml gateway.config.toml
pnpm exec playwright install chromium
pnpm dev doctor
pnpm verify
```

The public branch model is:

- `dev`: active development and pull-request target
- `main`: stable, releasable snapshots

See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Release integrity

GitHub Releases are the canonical distribution channel. A stable release
contains platform tarballs, checksums, signatures, SBOMs, provenance, signed
channel metadata, qualification evidence, and `install.sh`. Published artifact
bytes are built from the tagged commit. Exact-byte qualification is the
publication authority.

## License

RLY Gateway is released under the [MIT License](./LICENSE). Frozen source
provenance is retained in [`provenance/`](./provenance/).
