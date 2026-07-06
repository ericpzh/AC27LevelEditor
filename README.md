# AC27 Level Editor

Cross-platform desktop level editor for **Airport Control 27** `.acl` flight schedule files. Built with **Electron 33 + React 19 + Vite 8 + zustand 5**.

## Features

- **Flight table editor** — view, add, duplicate, and delete flights with full field validation
- **Timeline editors** — weather, wind, and runway timeline configuration
- **Interactive maps** — stand position map, STAR/approach map overlays
- **Live radar windows** — surface radar (ground), approach radar (air), and flight strips with real-time UDP telemetry from the game
- **Cloud LLM chat** — in-app AI assistant supporting DeepSeek, Gemini, Claude, and Codex
- **MCP integration** — HTTP API server (port 31415) with MCP tools for AI agent control
- **Witch mode** — easter-egg pixel-art character sprites in radar + flight strips windows
- **i18n** — English / Chinese (simplified Chinese)

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Run tests
npm test                 # Vitest — 361 component + hook tests
npm run test:e2e         # Playwright — E2E tests (requires `npm run build` first)
npm run test:all         # Full suite: component + E2E + integration

# Build for distribution
node build.js            # Local build (recommended on Windows)
npm run build:win        # CI build (cross-platform)
```

## Architecture

```
electron/main.js          # Electron main process — 53 IPC handlers, UDP listener, MCP server
electron/preload.js       # contextBridge — exposes window.electronAPI (52 methods)
src/main.jsx              # React entry — Vite + ReactDOM
src/components/           # React component tree
  SetupScreen/            # Game root directory selection
  BrowserScreen/          # Airport card listing, file browsing
  EditorScreen/           # Main editor — toolbar + flight table + timelines
  MapWindows/             # Ground/Air radar + flight strips (separate BrowserWindows)
  ChatPanel/              # Floating cloud-LLM chat panel
src/hooks/                # Custom React hooks
  hooks/map/              # Shared hooks for map windows
src/store/                # zustand state management
src/acl/                  # Backend — ACL parser, tokenizer, serializer
src/utils/                # Shared utilities — constants, i18n, validators, safeHtml
tests/                    # 361 Vitest + 16 Playwright + 22 Node.js integration tests
```

## Development Guide

This project uses a **CLAUDE.md skill system** for AI-assisted development. See:

- `.claude/skills/ac27-level-editor/SKILL.md` — main skill: conventions, architecture, rules
- `.claude/skills/ac27-level-editor/references/` — detailed reference files

### Key Conventions

| Rule | Detail |
|------|--------|
| **No TypeScript** | Plain JS/JSX only |
| **CommonJS for backend** | `electron/` and `src/acl/` use `require()` |
| **ESM for frontend** | `src/components/`, `src/hooks/`, `src/store/`, `src/utils/` use `import`/`export` |
| **IPC for all file I/O** | Renderer never touches filesystem directly |
| **No `dangerouslySetInnerHTML`** | Use `safeHtml()` from `src/utils/safeHtml.jsx` |
| **No inline styles** | Extract to component `.css` file |
| **One `.css` per component** | Match the component filename |
| **Snake case files for backend** | `snake_case.js` in `src/acl/` |
| **Pascal case files for components** | `PascalCase.jsx` in `src/components/` |

## Testing

| Layer | Command | Count | Description |
|-------|---------|-------|-------------|
| Component | `npm test` | 361 | Vitest + React Testing Library |
| E2E | `npm run test:e2e` | 16 | Playwright + Electron (isolated fixtures) |
| Integration | `node tests/integration/*.js` | 22 | Plain Node.js — ACL parsing, save integrity |

For detailed test documentation, see `tests/README.md`.

## License

Proprietary — Airport Control 27 Level Editor.
