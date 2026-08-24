# ROADMAP — RLY Gateway

> **Live board:** [Rly Gateway Backlog — Project 4](https://github.com/users/trungtaottn/projects/4) · `Horizon` is the horizon of record. `plans/` stays gitignored (local research).

**Rule:** Quarters are windows, not promises. Slip moves the item, not the calendar claim. Every feature that touches UI/config must pass `docs/RITUAL.md` before `ak:plan`.

## Now · Q4 2026 — Seal the cockpit (v0.2.x honesty)

*Board filter → `Horizon:Now` · Theme `Seal the cockpit`*

| Item | Pillar | Exit | Project filter |
|------|--------|------|----------------|
| Keys CRUD UI (Config → 3 cụm Configure/Operate/Govern + drawer affinity/capability/launchPolicy) | UI/Governance | Aug23 A 9 acceptances: 44px, 409 `role=alert`, secret once, AT-031 green | `Horizon:Now` `Pillar:UI` |
| `recordKeyUsage` not 0-at-auth + ledger on every terminal path | Governance/Ledger | Budget blocks only on real spend; no silent 0-token ledger rows | `Horizon:Now` `Pillar:Governance` |
| `GET /v1/pool-health` + `GET /v1/ledger` secret-free | Observability/Routing | Health meters + burn from ledger, no Bearer/JWT in DTO | `Horizon:Now` `Pillar:Observability` |
| Schema v3 orphan resolved | Ops | `DEFAULT_MIGRATIONS` no orphan; checksum fail-closed; migrations green | `Horizon:Now` `Pillar:Ops` |
| `pnpm verify` macos green (lint→typecheck→test→browser→build→privacy) | — | CI badge green on `dev` | — |

## Next · Q1 2027 — Honest operate

*Board filter → `Horizon:Next` · Theme `Honest operate`*

- Keys list shows `spent_usd` burn from ledger; Health shows EWMA `score = ewma*0.6 + errorRate*40 + quotaPenalty` from `GET /v1/pool-health`
- Affinity/capability names match DTO (`sessionEnabled`/`ttlSeconds`), no raw-JSON pool drawer
- Alibaba terms eligibility + unknown-adapter `fail-closed` tests
- First-run wizard: 5 disconnected CRUD tables → empty-state + provider catalog picker; macOS Apple Silicon qualify from experimental (adoption lever)
- AT-031 overclaims closed; Phase-10 QA leftovers done

## Later · Q2 2027+ — Reviewed breadth

*Board filter → `Horizon:Later` · Theme `Reviewed breadth`*

- Provider expansion only after SPEC Must (direct Anthropic/OpenAI, Gemini vs Antigravity, Z.AI terms) — 5 contracts per adapter
- Optional C-lite CodeMirror island / D-lite health chart (no Vite SPA)
- `workspace_id` nullable hook on `governance_keys` + `ledger_entries` (team SKU optionality) — core gateway/keys/ledger stays **free forever** (local-first invariant)
- Keychain `BL-040`, licensed exact tokenizer, OTel export stay Later unless a theme promotes them

## How to use this file vs Projects

- `ROADMAP.md` is the frozen contract on `main` (reviewed, `git blame`able, linked from README). It lists **horizons + exit criteria**, not tasks.
- Project 4 is the live execution board — `Horizon`/`Theme`/`Pillar`/`Ritual` fields + Status `Backlog→Todo→In Progress→Done`. Filter the board; don't duplicate tasks here.
- Ritual is `docs/RITUAL.md` — no feature enters `ak:plan` without its HTML brief link.

## Links

- Board: https://github.com/users/trungtaottn/projects/4
- Ritual: [docs/RITUAL.md](docs/RITUAL.md)
- Prior briefs (local, not public): `plans/reports/brainstorm-260823-configurations-ui.html`, `plans/reports/brainstorm-260823-roadmap-overview.html`
