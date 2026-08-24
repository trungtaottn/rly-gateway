# RITUAL — Standing gate before ak:plan

> **Invariant:** No UI/config feature enters `ak:plan`/`ak:cook` without this checklist. `plans/` is gitignored; `ROADMAP.md` + this file + Project 4 are the only public planning surfaces.

## Triggers (any fires the ritual)

- **T1** UI/config surface changed (`src/management/ui/*`, `src/management/*`, `src/control-plane/*`)
- **T2** P0 gap opened (`keys`, `affinity`, `capability/launchPolicy`, `ledger spent`, `pool-health`)
- **T3** Weekly 30′ research sync — re-score `Horizon:Now` pick
- **T4** Quarterly theme review — confirm Q4/Q1/Q2 still holds

## Steps

1. **Brainstorm contract (4 fields)** — Outcome / Constraints / Non-goals / Acceptance. 2–3 approaches ultra, pick cheapest to abandon. Record in `plans/reports/brainstorm-YYMMDD-<slug>.md` frontmatter.
2. **Research (parallel, xia)** — `ccs`/`opencodex`/`cliproxyapi`/`9router`/`NewAPI` + audit `P0/P1` gaps. Steal IA, reject React/Vite/CDN for loopback.
3. **Brief HTML (self-contained)** — `plans/reports/brainstorm-YYMMDD-<slug>.html`: 4 fields + candidate quadrant + implementation flow + annotated mockups (375/1024) + verifier score + risks. Gate input.
4. **Gate 30′** — Design review on the HTML. No pass → no plan. Reviewer checks: 409 no silent retry, secret-free DOM/SQLite/fixtures, no rotate after first byte (#121), 44px, `prefers-reduced-motion`.
5. **Plan** — `ak:plan` copies 4 fields + acceptance checklist from brief. `Ritual:Brief pending → Gate passed` on Project 4.
6. **Cook** — `ak:cook` on `feat/*` from previous merge tip (phase-per-branch). One `feat/*` PR per phase, conventional commit, `Closes #N`.
7. **Verify** — `pnpm verify` on macOS (lint→typecheck→test→browser→build→privacy→release) + `gh project item-edit` → `Ritual:Verified`, `Status:Done`.

## Cadence

- Weekly 30′: pick exactly one `Horizon:Now` item
- Per-feature: brief + gate
- Quarterly: confirm themes in `ROADMAP.md`

## PR template checklist addition

```md
- [ ] Ritual brief: plans/reports/brainstorm-*.html (link)
- [ ] Project 4: Horizon/Theme/Pillar/Ritual set
- [ ] pnpm verify green (macos)
```

## Failure modes

- Solo skip ritual under beta pressure → ROADMAP becomes fiction. Mitigate: CI requires brief link in PR body.
- Dual-doc drift (ROADMAP vs RITUAL) → keep RITUAL 1 page, ROADMAP refers here.
