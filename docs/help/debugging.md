---
summary: "Debugging tools: watch mode, raw model streams, and tracing reasoning leakage"
read_when:
  - You need to inspect raw model output for reasoning leakage
  - You want to run the Gateway in watch mode while iterating
  - You need a repeatable debugging workflow
title: "Debugging"
---

# Debugging

This page covers debugging helpers for streaming output, especially when a
provider mixes reasoning into normal text.

## Runtime debug overrides

Use `/debug` in chat to set **runtime-only** config overrides (memory, not disk).
`/debug` is disabled by default; enable with `commands.debug: true`.
This is handy when you need to toggle obscure settings without editing `openclaw.json`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` clears all overrides and returns to the on-disk config.

## Gateway watch mode

For fast iteration, run the gateway under the file watcher:

```bash
pnpm gateway:watch --force
```

This maps to:

```bash
tsx watch src/entry.ts gateway --force
```

Add any gateway CLI flags after `gateway:watch` and they will be passed through
on each restart.

## Dev profile + dev gateway (--dev)

Use the dev profile to isolate state and spin up a safe, disposable setup for
debugging. There are **two** `--dev` flags:

- **Global `--dev` (profile):** isolates state under `~/.openclaw-dev` and
  defaults the gateway port to `19001` (derived ports shift with it).
- **`gateway --dev`: tells the Gateway to auto-create a default config +
  workspace** when missing (and skip BOOTSTRAP.md).

Recommended flow (dev profile + dev bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

If you don’t have a global install yet, run the CLI via `pnpm openclaw ...`.

What this does:

1. **Profile isolation** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas shift accordingly)

2. **Dev bootstrap** (`gateway --dev`)
   - Writes a minimal config if missing (`gateway.mode=local`, bind loopback).
   - Sets `agent.workspace` to the dev workspace.
   - Sets `agent.skipBootstrap=true` (no BOOTSTRAP.md).
   - Seeds the workspace files if missing:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Default identity: **C3‑PO** (protocol droid).
   - Skips channel providers in dev mode (`OPENCLAW_SKIP_CHANNELS=1`).

Reset flow (fresh start):

```bash
pnpm gateway:dev:reset
```

Note: `--dev` is a **global** profile flag and gets eaten by some runners.
If you need to spell it out, use the env var form:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` wipes config, credentials, sessions, and the dev workspace (using
`trash`, not `rm`), then recreates the default dev setup.

Tip: if a non‑dev gateway is already running (launchd/systemd), stop it first:

```bash
openclaw gateway stop
```

## Raw stream logging (OpenClaw)

OpenClaw can log the **raw assistant stream** before any filtering/formatting.
This is the best way to see whether reasoning is arriving as plain text deltas
(or as separate thinking blocks).

Enable it via CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Optional path override:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Equivalent env vars:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Default file:

`~/.openclaw/logs/raw-stream.jsonl`

## Raw chunk logging (pi-mono)

To capture **raw OpenAI-compat chunks** before they are parsed into blocks,
pi-mono exposes a separate logger:

```bash
PI_RAW_STREAM=1
```

Optional path:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Default file:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Note: this is only emitted by processes using pi-mono’s
> `openai-completions` provider.

## Log file management

Moltbot writes daily rolling logs to `/tmp/moltbot/` by default. To prevent
unbounded disk growth, you can configure size-based rotation and error spike
alerting.

### Size-based rotation

Limit individual log file sizes and the total number of rotations per day:

```json
{
  "logging": {
    "level": "info",
    "maxFileSize": "100MB",
    "maxFilesPerDay": 5
  }
}
```

When a log file exceeds `maxFileSize`, it rotates to a numbered suffix
(e.g., `moltbot-2026-01-30.1.log`). Once `maxFilesPerDay` rotations are
reached, further log entries for that day are dropped to prevent disk
exhaustion.

Defaults:

- `maxFileSize`: `"100MB"`
- `maxFilesPerDay`: `5`

Size format supports: `B`, `KB`, `MB`, `GB` (e.g., `"50MB"`, `"1GB"`).

### Error spike alerting

Get notified via Telegram when errors spike beyond a threshold:

```json
{
  "logging": {
    "alertOnErrorSpike": {
      "enabled": true,
      "threshold": 100,
      "windowSeconds": 60,
      "telegramChatId": "123456789",
      "cooldownSeconds": 300
    }
  }
}
```

| Field             | Default | Description                                   |
| ----------------- | ------- | --------------------------------------------- |
| `enabled`         | `false` | Enable error spike alerting                   |
| `threshold`       | `100`   | Number of errors to trigger alert             |
| `windowSeconds`   | `60`    | Time window for counting errors               |
| `telegramChatId`  | -       | Telegram chat ID to receive alerts (required) |
| `cooldownSeconds` | `300`   | Minimum time between alerts                   |

When the error count within `windowSeconds` exceeds `threshold`, Moltbot sends
a Telegram alert. The `cooldownSeconds` prevents alert flooding.

Note: Requires a configured Telegram bot token in `channels.telegram`.

## Safety notes

- Raw stream logs can include full prompts, tool output, and user data.
- Keep logs local and delete them after debugging.
- If you share logs, scrub secrets and PII first.
