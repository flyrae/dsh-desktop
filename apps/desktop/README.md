# dsh-desktop

Tauri desktop shell for DeepSeek Harness. The Rust host spawns the dsh Node
runtime (`--profile web`) from a bundled, offline Node binary + dependency
closure; the WebView loads the frontend that Node child serves — the same HTTP
+ WebSocket transport a browser uses via `dsh web`.

## Architecture

```
NSIS install directory/
├── dsh-desktop.exe       Tauri main program
├── node.exe              Bundled Node 24 binary (externalBin sidecar)
├── dsh-runtime/          bundle.resources
│   ├── lib/              dsh CLI build artifacts (bin.js + hashed chunks)
│   ├── config/           agent-presets
│   └── node_modules/     Hoisted, symlink-free dependency closure
└── (WebView2 bootstrapped by NSIS)
```

The Rust host resolves the bundled `node` sidecar via `tauri-plugin-shell` and
the dsh CLI entry via `PathResolver(BaseDirectory::Resource)`, then spawns
`node <resource>/dsh-runtime/lib/bin.js --profile web` with `cwd` set to the
resource root. The WebView connects to `127.0.0.1:3080` (the default `dsh web`
port; change `build.devUrl` in `tauri.conf.json` if the web profile uses a
different port).

## Prerequisites

- Node `^22.19 || >=24`, pnpm (per root `engines`)
- Rust toolchain (`rustup`)
- Tauri v2 system dependencies — see <https://tauri.app/start/prerequisites/>

## Development (from source, no bundling)

```sh
# 1. Build the web frontend
pnpm run build:web

# 2. Start the dsh web host (serves the UI on 127.0.0.1:3080)
pnpm dsh web

# 3. In another terminal, launch the Tauri shell (dev mode reads DSH_BIN)
cd apps/desktop/src-tauri
cargo tauri dev
```

In dev mode the Rust host reads `DSH_BIN` (defaulting to
`node --import tsx/esm apps/cli/src/bin.ts`) and launches from the repository
source — no Node binary or closure bundling is needed.

## Production build (NSIS installer, fully offline)

```sh
# 1. Download and stage the Node 24 binary (cached in .cache/desktop-node/)
pnpm exec tsx scripts/fetch-node-for-desktop.ts

# 2. Build and stage the dsh runtime closure (lib/ + config/ + node_modules/)
pnpm exec tsx scripts/build-desktop-runtime.ts

# 3. Build the NSIS installer
cd apps/desktop/src-tauri
cargo tauri build
```

The NSIS installer (`-setup.exe`) appears under `src-tauri/target/release/bundle/nsis/`.
It bundles the Node binary + the dsh runtime (~240 MB) and bootstraps WebView2,
so the installed app runs fully offline without requiring the user to install Node.

### Build scripts

| Script | Purpose |
|--------|---------|
| `scripts/fetch-node-for-desktop.ts` | Downloads Node 24 win-x64 zip from nodejs.org, verifies SHA-256, caches, extracts `node.exe` to `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`. |
| `scripts/build-desktop-runtime.ts` | Deploys the `@deepseek-ai/dsh-desktop-runtime` closure (`pnpm deploy --hoisted`), materializes symlinks to real bytes, stages dsh CLI `lib/` + `config/`, verifies zero symlinks, outputs to `src-tauri/resources/dsh-runtime/`. |

The closure manifest `apps/desktop/desktop-runtime/package.json` is the single
source of truth for which plugins ship in the installer. Adding a plugin is one
dependency line there plus a repackage.

### IPC commands (control surface)

- `dsh_status()` → `bool`: whether the Node child is alive
- `dsh_restart()` → `Result<(), String>`: kill and re-spawn the child

## Directory layout

```
apps/desktop/
├── package.json                  workspace manifest (publishes src-tauri/)
├── README.md                     this file
├── desktop-runtime/
│   └── package.json              closure manifest (deploy root; private)
└── src-tauri/
    ├── Cargo.toml                Rust crate (tauri, tauri-plugin-shell, serde, log)
    ├── build.rs                  tauri_build::build()
    ├── tauri.conf.json           externalBin, resources, NSIS target, window
    ├── capabilities/default.json shell sidecar permission
    ├── icons/                    generated icon set (32, 128, ico, png)
    ├── binaries/                 (build output, gitignored) staged node-*.exe
    ├── resources/dsh-runtime/    (build output, gitignored) staged runtime closure
    └── src/
        ├── main.rs               Tauri builder, setup (spawn), teardown (kill), IPC
        └── spawn.rs              DshProcess: dev/release spawn, is_alive, kill, restart
```

## What this skeleton does NOT include

- Portable zip distribution (NSIS first; portable is a follow-up)
- Tauri-IPC `AbstractApiClient` subclass (replacing HTTP carriage with IPC)
- `events.mux` / `events.host` downlink stream reproduction over IPC
- Native capability bridges (directory-picker, notifications)
- macOS/Linux builds (Windows-only for now)
- Third-party license bundling (Node + npm package notices)
- Process-tree kill (direct child only; descendants need group/taskkill kill)
