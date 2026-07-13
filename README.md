# knip-gui

A local web GUI for [knip](https://knip.dev). Browse unused files, exports, types,
enum/namespace members, and dependencies in a file tree; select them; fix or ignore
them in bulk with a diff preview; commit the cleanup — all from your browser.

## Usage

Run in a project that has knip installed and configured:

```bash
npx knip-gui
```

The CLI resolves your project's own knip install, runs it with the JSON reporter,
and opens a browser at a local URL.

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port <n>` | random free port | Port to listen on (always binds `127.0.0.1`) |
| `--no-open` | — | Don't open the browser |
| `--dir <path>` | cwd | Project root to scan |

### Security

The server binds to `127.0.0.1` only. Every API request requires a per-session
token embedded in the served page, and cross-origin requests are rejected — so
web pages you have open cannot drive the API.

## Status

Under active development. Working: scan, normalized report API, file content API.
Coming: fix/ignore engines with diff preview, git integration, and the web UI.

## Development

```bash
npm install
npm test          # vitest (unit + integration against fixture projects)
npm run typecheck
npm run build     # emits dist/, including the CLI bin
```

Design docs live in `docs/superpowers/specs/`, implementation plans in
`docs/superpowers/plans/`.
