# Contributing to RLY Gateway

Thank you for helping improve RLY Gateway. Changes should preserve protocol
fidelity, local-only credential ownership, and deterministic routing.

## Before opening a change

- Search existing issues and pull requests.
- Use an issue for behavior changes, provider integrations, compatibility
  changes, or security-sensitive work.
- Never include real credentials, account identities, prompts, responses, or
  local client stores in source, fixtures, logs, screenshots, or tickets.
- Keep one coherent concern per pull request.

## Development setup

Requirements: Node.js 24, pnpm 11.16, and Chromium for Playwright.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
cp gateway.config.example.toml gateway.config.toml
pnpm dev doctor
```

`gateway.config.toml`, `.env`, runtime state, and credential material are local
only and must not be committed.

## Branch and pull-request workflow

1. Branch from the latest `dev` using `feat/`, `fix/`, `test/`, `docs/`, or
   `chore/` plus a descriptive name.
2. Add focused tests before or with the implementation.
3. Run the narrowest relevant test, then `pnpm verify` for shared behavior.
4. Use Conventional Commit messages and a Conventional Commit-compatible PR
   title.
5. Open the PR against `dev` and complete the repository template with exact
   commands and results.

Do not force-push `dev` or `main`. Stable promotion is performed from a
verified `dev` state into `main`.

## Engineering expectations

- Preserve Anthropic Messages and OpenAI Responses streaming, tool, reasoning,
  usage, error, and stop semantics.
- Keep provider/model selection separate from account eligibility and retry.
- Do not retry or rotate after output commitment.
- Bind local services to loopback and fail closed on foreign port ownership.
- Persist only secret-free control metadata.
- Import credentials explicitly and read-only by default.
- Do not mutate native Claude or Codex configuration globally.
- Record substantial upstream adaptation in the machine-readable
  [`provenance/`](./provenance/) inventory.

## Verification

```bash
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:lifecycle
pnpm test:privacy
pnpm test:standalone
pnpm lint
pnpm typecheck
pnpm build
pnpm verify
```

A skipped or unavailable check is not a pass. Explain the gap in the PR.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](./SECURITY.md).
