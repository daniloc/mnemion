# Core

Cross-cutting primitives shared by both the worker and the SPA: product identity, the declarative UI palettes (view / format / block / chart) an agent authors against, and dev-only seed data.

## works when
- constants.ts exists at this node
- view-palette.ts exists at this node
- view-palette.ts imports ./format-palette
- format-palette.ts exists at this node
- block-palette.ts exists at this node
- chart-spec.ts exists at this node
- chart-svg.ts exists at this node
- chart-svg.ts imports ./chart-spec
- dev-seed.ts exists at this node

## why

Core is the layer both runtimes depend on but neither owns, so it carries zero env-specific imports and stays pure data — that purity is what lets the same module validate a write in the worker and render it in the SPA without forking.

Its center of gravity is the agent-authorable UI: `view-palette` (how a pattern renders), `format-palette` (how a value renders), `block-palette` (how a page composes), and the chart pair (`chart-spec` + `chart-svg`). These are the canonical instances of the "self-enforcing declarations" doctrine — one declarative table that is simultaneously the spec an agent reads, the validator the kernel derives (`validateViewSpec`/`validateBlocks`/`validateFormatsMap`, fail-closed at the mutate chokepoint), and the totality oracle the SPA's `Record<…Id, Component>` enforces at compile time. The agent composes UI from these tables as data, never as code, which is what makes live agent-authored rework safe.

The chart layer is deliberately split so one spec drives two renderers: `chart-spec` is the single home for the mark set, the categorical color palette, and the long→wide series pivot, and both the in-hive Recharts renderer and the server SVG renderer (`chart-svg`, for published pages and OG cards) derive from it — so a dataset reads identically in-hive and on a public page. `constants` keeps product identity (`PRODUCT_NAME`, `URI_SCHEME`, `uri()`) in one place so the scheme is never hardcoded. `dev-seed` is gated and runs only in the DO constructor under `DEV_SEED`; it writes via raw SQL (trusted, bypassing the kernel hook), so its contents must stay valid against these same palettes by hand — it is inert in production.
