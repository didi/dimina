# @dimina/benchmark

Dimina end-to-end renderer benchmark.

This package is intended to live at:

```text
fe/packages/benchmark
```

The current `fe/pnpm-workspace.yaml` already contains `packages/*`, so no workspace
change is required.

## What is measured

For update cases the timer runs inside the benchmark mini-program logic layer:

```text
performance.now()
  -> Page.setData()
  -> service
  -> bridge
  -> @dimina/render
  -> Vue update
  -> DOM flush
  -> setData callback
  -> performance.now()
```

The samples are then sent back to the Web host through a container API registered
before `openApp()`:

```text
wx.benchmarkReport(...)
```

No benchmark-only change to Dimina runtime is required.

`cold-start` is different: the Web host starts the clock immediately before
`container.openApp()` and stops it when the benchmark page reaches `onReady` and
reports readiness.

This measures a new Web mini-program instance with an already available package.
Use device tooling to measure package installation, first paint, first input, and resume separately.

## Install

From the existing `fe/` workspace:

```bash
pnpm install
pnpm --filter @dimina/benchmark exec playwright install chromium
```

## Start the benchmark host

From `fe/`:

```bash
pnpm --filter @dimina/benchmark dev
```

`predev` does two things automatically:

1. builds the current `@dimina/fe-container-sdk` dependency graph in development mode;
2. compiles `packages/benchmark/miniapp` with Dimina's current compiler into
   `packages/benchmark/web/public/miniapp`.

The benchmark host is then available at:

```text
http://127.0.0.1:5174/
```

Open it in a browser if you want to inspect the embedded Dimina container manually.

## Run

In a second terminal, from `fe/`:

```bash
pnpm --filter @dimina/benchmark bench
```

Default URL:

```text
http://127.0.0.1:5174/
```

Override if necessary:

```bash
DIMINA_BENCH_URL=http://127.0.0.1:5174 \
pnpm --filter @dimina/benchmark bench
```

Set `DIMINA_BENCH_CHROMIUM` to the executable path of a local Chromium-based browser if needed.
To isolate the Web host's app-level transition and its minimum loading-screen hold, run the same build twice:

```sh
DIMINA_BENCH_OUTPUT=./results/with-app-transitions pnpm --filter @dimina/benchmark bench
DIMINA_BENCH_APP_TRANSITIONS=0 DIMINA_BENCH_OUTPUT=./results/no-app-transitions pnpm --filter @dimina/benchmark bench
```

The output records the `appTransitions` setting. Page navigation within an app is unchanged.

Run one case:

```bash
pnpm --filter @dimina/benchmark bench -- --case list-update-one-1000
```

Change the result label:

```bash
pnpm --filter @dimina/benchmark bench -- --mode vue36-vdom
pnpm --filter @dimina/benchmark bench -- --mode vue36-vapor
```

Important: `--mode` is a **result label**, not a runtime switch. Run each mode from
the branch/worktree/build that actually contains that renderer implementation.

Recommended comparison workflow:

```text
worktree A: current main / Vue 3.5 VDOM  -> --mode baseline
worktree B: Vue 3.6 VDOM                -> --mode vue36-vdom
worktree C: Vue 3.6 Vapor               -> --mode vue36-vapor
```

## Results

Generated under:

```text
packages/benchmark/results/
```

Example:

```text
results/baseline.json
results/vue36-vdom.json
results/vue36-vapor.json
```

Compare two result files:

```bash
pnpm --filter @dimina/benchmark compare -- \
  results/baseline.json \
  results/vue36-vapor.json
```

## First 10 cases

- `cold-start`
- `mount-1000-nodes`
- `set-data-primitive`
- `set-data-deep-path`
- `set-data-batch-100`
- `list-create-1000`
- `list-update-one-1000`
- `list-replace-1000`
- `wx-if-toggle-1000`
- `component-500-update`

## Controls

```bash
DIMINA_BENCH_WARMUP=10
DIMINA_BENCH_ITERATIONS=50
DIMINA_BENCH_TIMEOUT=60000
HEADLESS=0
```

Example:

```bash
HEADLESS=0 DIMINA_BENCH_ITERATIONS=20 \
pnpm --filter @dimina/benchmark bench -- --case set-data-primitive
```

## Notes about noise

GitHub-hosted runners and normal developer machines are noisy. Prefer:

- median for the typical cost;
- P95 / P99 for tail latency;
- the same browser version and machine for release decisions;
- at least three independent full-suite runs before drawing conclusions.

The initial benchmark is intentionally end-to-end. If a regression is found,
add a smaller render-only microbenchmark afterward to isolate the layer.
