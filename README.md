<div align="center">

# domino

**English** · [简体中文](README.zh-CN.md)

**Open a `.domino` file. An LLM builds the app — live.**

A cross-platform runtime where plain-text *domino* definitions (DOM + agent) are turned
into working, interactive UIs by your own LLM API key. No hand-written screens, no
boilerplate — the definition describes the app, and the agent renders it in real time.

[![Build](https://github.com/xxsLuna/domino/actions/workflows/build.yml/badge.svg)](https://github.com/xxsLuna/domino/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/xxsLuna/domino?display_name=tag&sort=semver)](https://github.com/xxsLuna/domino/releases)
[![Tests](https://img.shields.io/badge/tests-116%20passed-brightgreen)](https://github.com/xxsLuna/domino/actions/workflows/build.yml)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android-lightgrey)](#download)

macOS · Windows · Linux · Android (web build)

[Download](#download) · [Quick start](#quick-start) · [domino format](#domino-file-format-v1) · [Docs](#table-of-contents)

</div>

---

## Table of contents

- [What is this?](#what-is-this)
- [Features](#features)
- [How it works](#how-it-works)
- [Download](#download)
- [Quick start](#quick-start)
- [Using domino](#using-domino)
  - [Open a definition](#1-open-a-definition)
  - [Register your LLM key (BYOK)](#2-register-your-llm-key-byok)
  - [Interact — the agent renders the next screen](#3-interact--the-agent-renders-the-next-screen)
- [domino file format (v1)](#domino-file-format-v1)
- [Supported LLM providers](#supported-llm-providers)
- [Generated UI: HeroUI + app patterns](#generated-ui-heroui--app-patterns)
- [Design themes](#design-themes)
- [Local demo (no API key needed)](#local-demo-no-api-key-needed)
- [Development](#development)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

## What is this?

**domino** (think: *DOM* + *agent*) is a small runtime application. You give it a
`.domino` file — an INI-style text file with a tiny condition script — and it opens a
window that feels like an app that already exists: a login screen if the definition asks
for one, the app logo, a grid of live components, and a dashboard fed by real API calls.

Everything you see is generated at runtime by an LLM you configure yourself
(**bring your own key**). Every button press sends the current context back to the
agent, which renders the next screen in real time.

## Features

- **`.domino` definitions** — INI sections (`[meta]`, `[auth]`, `[api]`, `[ui]`, `[script]`)
  plus a boolean condition DSL (`when logged_in -> goto main`). Parse errors come with line numbers.
- **Real-time LLM UI generation** — the agent streams a validated UI spec and renders it
  progressively while it is still being generated; each card mounts once, as soon as it is complete.
- **HeroUI component registry** — 36 named components built on [HeroUI v3](https://heroui.com)
  (React Aria + Tailwind CSS v4): page headers, cards, tables, lists, KPI tiles, forms,
  tabs, dialogs, breadcrumbs, pagination… No drag & drop, no freeform CSS — specs are
  validated before render.
- **Native app patterns** — the agent follows dashboard / list / detail / form / settings /
  login patterns, and the runtime draws the app shell: a sidebar on desktop, an icon rail on
  tablets, a bottom tab bar on phones.
- **Responsive by construction** — the model lays a screen out once on a 12-column grid; the
  runtime reflows it for tablets and phones (KPI rows stay side by side, wide splits stack,
  tables become cards).
- **Auth flow** — if the definition declares `auth`, the agent builds a login page; the
  runtime intercepts the form, calls your `login_endpoint`, stores the token, and skips
  login on later launches when `skip_if_logged_in` is set.
- **Allow-listed API access** — the agent can only call endpoints listed in the definition's
  `[api] allow` patterns; tokens are attached automatically.
- **Session history** — back/forward navigation (app bar + `⌘[` / `⌘]`) over rendered screens.
- **Session render cache** — revisiting the same screen state reuses the cached render
  without an LLM call; the cache is discarded on restart, so every launch is regenerated fresh.
- **Design themes** — the `[ui]` section controls theme, accent color, corner style
  (`sharp` / `soft`), radius, density, and per-step status colors (Tailwind-style palettes).
- **Cross-platform** — Electron desktop app (macOS/Windows/Linux) and a pure web build
  wrapped by Capacitor for Android, all sharing one platform-independent core.
- **Recent list & settings** — launching without a definition shows basic info, your recent
  dominos, and a settings button for the BYOK provider panel.
- **domino maker** — describe the app you want in plain words (what the service is, what each
  API takes and returns, which screens you need); it asks about anything essential that is
  missing, then writes a validated `.domino` file you can run, save or refine.
- **Drag & drop** — drop a `.domino` file anywhere on the window to open it.
- **Auto-update** — on launch the app checks GitHub Releases; one click downloads the new
  version, installs it and relaunches (desktop). On Android it downloads the new APK for the
  system installer.

## How it works

```
 .domino file  ──parse──▶  app context (auth · api allow list · theme · script)
                                 │
                                 ▼
        ┌──────────── agent loop (your LLM key) ────────────┐
        │  tools: render_ui · call_api (allow list) · navigate│
        │  streams a UiSpec JSON → validated → rendered       │
        └──────────────────────┬─────────────────────────────┘
                               ▼
     HeroUI components on a responsive 12-column grid + app shell
                               │
        click / submit ────────┼─────── back / forward
                               ▼
        context + ACTION sent to agent → next screen rendered live
```

## Download

Grab the latest build for your OS from the
[**Releases**](https://github.com/xxsLuna/domino/releases) page
(CI builds every push to `main` and publishes a release — tag `v<version>` from
`package.json` — whenever the version is new; bump the version to ship the next one).

| Platform | Artifact |
|----------|----------|
| macOS (Apple silicon) | `domino-<version>-arm64.dmg`, `domino-<version>-arm64-mac.zip` |
| Windows | `domino-<version>-win-x64.exe` (NSIS installer) |
| Linux | `domino-<version>.AppImage`, `domino_<version>_amd64.deb` |
| Android | `domino-<version>-android.apk` |

## Quick start

1. Install from [Releases](https://github.com/xxsLuna/domino/releases) (or build from source below).
2. Launch **domino**. The welcome screen shows recent definitions and a ⚙ settings button.
3. Open the settings panel and register your LLM provider (API key stays on your device).
4. Open a `.domino` file — by URL, `domino://` link, file picker, or the recent list.

Want to try it instantly without a key? See [Local demo](#local-demo-no-api-key-needed).

## Using domino

### 1. Open a definition

Three ways to load an app definition:

- **URL** — paste `https://…/app.domino` or `domino://app.example.com/crm.domino` into the welcome screen.
- **File** — pick a `*.domino` file from disk, or drag it onto the window (double-clicking the file also works on desktop).
- **domino maker** — no file yet? Describe the app on the welcome screen and let the LLM write one.
- **Recent** — one click reopens anything you loaded before.

On first open, domino remembers the definition in your recent list.

### 2. Register your LLM key (BYOK)

Press ⚙ → choose a provider → paste your key → save. Keys are encrypted with the OS
keychain on desktop (`safeStorage`) and kept in `localStorage` on the web. See
[Supported providers](#supported-llm-providers) for the endpoints.

### 3. Interact — the agent renders the next screen

Click any button or submit a form: the runtime sends the current screen context and the
action to the agent, which calls APIs (within the allow list) and streams the next screen.
Use the toolbar arrows (or `⌘[` / `⌘]`) to move through history — screens you already
visited are served from the session cache without spending tokens.

## domino file format (v1)

```ini
[meta]
name = ExampleCRM
description = Lead tracking for a small sales team
logo = https://example.com/logo.png
home = main

[auth]
required = true
login_endpoint = https://api.example.com/auth/login
token_key = access_token
skip_if_logged_in = true

[api]
base_url = https://api.example.com
allow = /login, /leads, /leads/*

[ui]
theme = auto            ; light | dark | auto (follows the OS)
primary = #4f46e5       ; accent (buttons, links, card headers)
style = sharp           ; soft (default, rounded) | sharp (squared-off)
radius = 0              ; explicit corner radius in px (overrides style)
density = compact       ; comfortable (default) | compact
success = #10b981       ; per-step colors (Tailwind-style palette)
warning = #f59e0b
danger = #ef4444

[script]
when not logged_in -> goto login
when logged_in -> goto main
on auth_failed -> goto login

[guide]
; Free text for the UI agent — kept verbatim. Describe the service, each API
; (method, path, request/response fields, what to show) and the screens you want.
Sales reps log in and see their pipeline.
GET /leads returns [{id, name, company, stage, value}] — show it as a table, newest first.
POST /leads {name, company, value} creates a lead; afterwards return to the list.
```

`[guide]` is passed to the agent as the app's brief (alongside `[meta] description`), so the
screens, data and wording follow it; the allow list and runtime-owned login still apply.

The `[script]` condition DSL supports identifiers (`logged_in`), `not`, comparisons
(`==`, `!=`, `<`, `>`), `and` / `or`, parentheses, and dotted paths (`param.plan == "pro"`).
Commands are `goto <page>`, `render <page>`, and `call <endpoint>`. `on <event>` rules are
evaluated before `when` rules.

More samples: [`samples/`](samples/) — login required, no-auth, and conditional routing.

## Supported LLM providers

Any endpoint exposing one of these APIs works — just point domino at it:

| Provider | Endpoint | Typical backends |
|----------|----------|------------------|
| **OpenAI Responses** | `/responses` | OpenAI |
| **Chat Completions** | `/v1/chat/completions` | OpenAI-compatible APIs, Ollama, LM Studio, custom base URLs |
| **Anthropic Messages** | `/v1/messages` | Claude |

> **Note** — the model must support tool/function calling for the full agent loop
> (API calls, navigation). Plain chat models still render screens via a JSON fallback.

## Generated UI: HeroUI + app patterns

Every screen is a `UiSpec` the agent streams through `render_ui`. Nodes name a registered
component and a desktop grid position; the runtime does the rest.

```jsonc
{
  "version": 1,
  "page": "leads",
  "nav": [                                   // primary navigation (optional, sticky)
    { "id": "main", "label": "Dashboard", "icon": "dashboard" },
    { "id": "leads", "label": "Leads", "icon": "users", "badge": 3 }
  ],
  "pages": [{ "id": "leads", "name": "Leads", "layout": [
    { "name": "PageHeader", "id": "head", "grid": { "x": 0, "y": 0, "w": 12, "h": 1 },
      "props": { "title": "Leads", "description": "8 leads" },
      "children": [{ "name": "Button", "id": "new-lead", "props": { "text": "New lead", "icon": "plus" } }] },
    { "name": "Table", "id": "table", "grid": { "x": 0, "y": 1, "w": 12, "h": 6 },
      "props": { "columns": ["Name", "Stage"], "rows": [["Ana", { "text": "Won", "variant": "success" }]], "rowAction": true } }
  ]}]
}
```

- **Components** — layout (`PageHeader`, `Card`, `Columns`, `Stack`, `Tabs`, `Accordion`, `Divider`),
  text (`Heading`, `Paragraph`, `Badge`, `Link`), forms (`Form`, `Input`, `Textarea`, `Select`,
  `Checkbox`, `RadioGroup`, `Switch`, `SearchField`, `Button` with optional `confirm` dialog),
  data (`Table`, `List`, `StatCard`, `KeyValue`, `Avatar`, `EmptyState`), feedback (`Alert`,
  `Progress`, `Spinner`, `Skeleton`), navigation (`Breadcrumbs`, `Pagination`) and `Image`.
  Icons use a lucide-style vocabulary (`home`, `users`, `settings`, …) or any emoji.
- **App shell** — `nav` becomes a sidebar (≥1024px), an icon rail (≥640px) or a bottom tab
  bar with a "More" menu (phones). Selecting an item sends `ACTION navigate`; pages the agent
  already delivered switch instantly.
- **Events** — `click`, `submit` (form values by name), `navigate`, `select` (table row /
  list item), `search`, `change` (choice controls outside a form) and `page` are sent back to
  the agent as `ACTION …` messages.
- **Responsive layout** — breakpoints are measured on the content area, so the sidebar or a
  split window counts: desktop keeps the grid as written, tablets keep small cards together
  and stack wide splits, phones go single-column (KPI cards two-up, title + action rows kept).
- **Streaming** — while a screen streams, finished cards render and the one still being
  written is a placeholder; re-rendering the same page updates cards in place instead of
  blanking the screen.

## Design themes

The `[ui]` section is a small, Tailwind-flavored theme system mapped onto HeroUI's theme
tokens (`--accent`, `--success`, `--radius`, …):

- **`theme`** — `light` / `dark` palette, or `auto` (default) to follow the OS color scheme.
- **`primary`** — the accent color used across the whole app.
- **`style = sharp`** — squared corners everywhere (no rounding), stronger borders, flat cards.
- **`radius`** — pin an exact corner radius in pixels.
- **`density = compact`** — tighter grid gaps, padding, and smaller controls.
- **`success` / `warning` / `danger`** — per-step semantic colors for badges, alerts, deltas.

## Local demo (no API key needed)

A bundled mock backend + mock LLM lets you experience the full flow — login → dashboard →
leads list → lead detail → create form → settings → sign out, back/forward and cache hits —
without any API key:

```bash
npm run mock                   # mock API + streaming LLM on http://127.0.0.1:8787
npm run dev                    # launch domino → click "예시로 시작하기" (start with the example)
```

Then open ⚙ settings and save: base URL `http://127.0.0.1:8787/v1`, model `mock-model`,
any key. The embedded ExampleCRM demo will log you in and render a live dashboard.

The mock also serves its own definition at `http://127.0.0.1:8787/app.domino`
(`?theme=dark&density=compact&primary=%23059669` to try themes). `PORT=…` changes the port
and `CHUNK_MS=…` the streaming pace (`0` sends each screen at once). In a browser, run
`npm run dev:web` instead of `npm run dev`.

## Development

```bash
npm install
npm run dev          # Electron desktop app with hot reload
npm run dev:web      # the same renderer in a browser (Vite dev server)
npm run mock         # local mock backend + streaming mock LLM (see Local demo)
npm run build        # build the Electron app (out/)
npm run build:web    # build the pure web bundle (dist-web/)
npm run dist         # package desktop installers (release/) via electron-builder
npm run typecheck    # TypeScript (strict) across node + web configs
npm test             # vitest unit tests (parser, session, agent, layout, streaming)
npm run android:sync # build web bundle and sync into the Android shell
```

### Android

The web build runs as-is inside a Capacitor shell:

```bash
npm run android:sync    # build:web + cap sync android
npx cap open android    # open in Android Studio, then run on device/emulator
```

CI signs release APKs with the key stored in the repository secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, and checks the
signing certificate against the SHA-256 fingerprint in `build.yml`. Without those secrets it
publishes a debug-signed APK. Keep a backup of the keystore — Android only installs updates
signed with the same key.

## Architecture

```
src/core/              platform-independent core (shared by Electron, web, Android)
├─ domino/             file format types, parser, condition DSL, script engine
├─ spec/               UiSpec JSON schema (zod-validated)
├─ ui/                 HeroUI component registry (36 named components), responsive
│                      12-col CardGrid + layout engine, app navigation, theme tokens
├─ llm/                provider adapters (3 APIs → one normalized stream)
├─ agent/              agent loop, partial-JSON salvage for progressive render,
│                      API allow-list enforcement
└─ session/            back/forward history, session render cache, prefs/token storage

src/renderer/          React app shell (welcome / settings / runtime screens)
src/shell-electron/    Electron main + preload (domino:// protocol, IPC, safeStorage)
android/               Capacitor Android shell
samples/               sample .domino definitions + mock E2E server
```

Key decisions:

- **Core is pure web** — desktop and Android are thin shells over the same code, so every
  feature works on every platform by construction.
- **Specs are validated, never trusted** — LLM output goes through a zod schema; unknown
  components render a visible placeholder instead of crashing.
- **Progressive rendering** — streamed tool-call arguments are salvaged from partial JSON in a
  single pass, so the screen visibly assembles while the model is still generating; previews
  are throttled, run as React transitions, and only completed cards mount.
- **One spec, every form factor** — the model designs for a desktop grid; tablet and phone
  layouts are derived by the runtime instead of asking the model for three layouts.
- **Security** — API keys never leave the device (BYOK); `call_api` is hard-limited to the
  definition's allow list; secrets are redacted from what is sent to the LLM.

## Contributing

Issues and pull requests are welcome.

1. Fork and create a feature branch.
2. Run `npm run typecheck && npm test` — both must pass.
3. Keep the core platform-independent; platform code belongs in the shells.
4. Commit with a clear message describing the change.

## License

MIT — see [LICENSE](LICENSE).
