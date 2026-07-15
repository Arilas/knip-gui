# Backlog → GitHub Issues

**As of 2026-07-15, open items are tracked on
[GitHub Issues](https://github.com/Arilas/knip-gui/issues), not in this file.**
Everything that was still open here was migrated:

| # | Item |
|---|------|
| [#1](https://github.com/Arilas/knip-gui/issues/1) | Server ops don't share a busy latch (scan/apply can start mid-sweep) |
| [#2](https://github.com/Arilas/knip-gui/issues/2) | PlanStore cap/TTL + cancelled previews orphan plans |
| [#3](https://github.com/Arilas/knip-gui/issues/3) | maxBuffer overflow indistinguishable from a knip crash |
| [#4](https://github.com/Arilas/knip-gui/issues/4) | Pin Origin check to exact origin (port) |
| [#5](https://github.com/Arilas/knip-gui/issues/5) | Defensive parse before editing malformed JSON configs |
| [#6](https://github.com/Arilas/knip-gui/issues/6) | Review Cancel/Done wipes the open Code file |
| [#7](https://github.com/Arilas/knip-gui/issues/7) | Mid-apply navigation skips the activity log |
| [#8](https://github.com/Arilas/knip-gui/issues/8) | CommitDialog abrupt unmount on tree-cleaning commit |
| [#9](https://github.com/Arilas/knip-gui/issues/9) | All-stale selection dead-ends without explanation |
| [#10](https://github.com/Arilas/knip-gui/issues/10) | CodePane >2MB skips the whole-file banner |
| [#11](https://github.com/Arilas/knip-gui/issues/11) | Gutter overlay doesn't re-measure on resize |
| [#12](https://github.com/Arilas/knip-gui/issues/12) | Production badge tooltip + amber variant |
| [#13](https://github.com/Arilas/knip-gui/issues/13) | Tree keyboard navigation (ARIA tree pattern) |
| [#14](https://github.com/Arilas/knip-gui/issues/14) | URL routing / browser history |
| [#15](https://github.com/Arilas/knip-gui/issues/15) | Playwright e2e in CI |
| [#16](https://github.com/Arilas/knip-gui/issues/16) | Seed-delta tree-expansion diff tests |
| [#17](https://github.com/Arilas/knip-gui/issues/17) | Monorepo workspace-scoped ignore real-knip e2e |
| [#18](https://github.com/Arilas/knip-gui/issues/18)–[#26](https://github.com/Arilas/knip-gui/issues/26) | Feature proposals (watch mode, undo, PR creation, blame age, per-issue fix modes, quick actions, row-click preview, command palette, usage heatmap) |

Not migrated (closed decisions, kept for the record):

- **Filter-chip counts** scoped only by search — deliberate, see the rationale in
  the git history of this file (Task 7 dogfood findings).
- **`lsof` unused-binary false positive** on the Packages page against this repo
  itself — legitimate knip behavior for system binaries, not worth an ignore
  entry.
- **Ordinal issue-id drift** when an earlier same-key duplicate disappears —
  documented tradeoff in `src/core/normalize.ts`.
- **`--production` false-positives on bundler-driven client subdirectories** —
  upstream knip semantics, documented in the README.

## History

The full delivered/deferred history that used to live in this file (v0.1–v0.3
review cycles, the 2026-07-15 post-v0.3 research fix pass, dogfood findings) is
preserved in git history — last full version at commit `61ceef2`.
