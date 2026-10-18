# Roadmap

This document tracks planned features, recent implementations, and future ideas for the NotebookLM MCP Server.

## Current Version: v4.1.0

---

## Backlog

### Medium Priority

| Feature                           | Description                                                     |
| --------------------------------- | --------------------------------------------------------------- |
| **Scrape: reset to My Notebooks** | Navigate to "My Notebooks" before scraping (not shared view)    |
| **Scrape after auth**             | Option to auto-scrape notebooks after successful authentication |
| **Persist scraped notebooks**     | Keep scraped notebooks across re-authentication                 |
| **Cleanup test notebooks**        | Delete unused notebooks in test accounts (100 limit reached)    |
| **Edit/Delete notes**             | Complete notes CRUD operations                                  |

### Low Priority

| Feature                   | Description                                                           |
| ------------------------- | --------------------------------------------------------------------- |
| **Audio style selection** | Debate, Critique, Brief summary, Deep dive                            |
| **Export formats**        | PDF/DOCX for reports, PDF/PPTX for presentations, CSV/XLSX for tables |

---

## Recently Implemented

### v3.0.0 - Dual transport (internal RPC API) + 5 new tools

- [x] Data plane migrated to NotebookLM's internal `batchexecute` RPC API with automatic DOM fallback (10-100× faster, immune to UI rebrands)
- [x] `share_notebook` — read/set the public link + list collaborators
- [x] `generate_study_aid` — flashcards & quiz
- [x] `generate_mind_map` — interactive mind map, saved to the notebook
- [x] `manage_labels` — source-label CRUD
- [x] `research_sources` — web/Drive source discovery (fast/deep modes)
- [x] Interactive login as a CLI command (`notebooklm-mcp setup-auth`) for global / stdio installs — v3.0.1 (#27)

### v2.3.0 - "Gemini Notebook" rebrand support

- [x] Create / list / rename / delete, sources, and every Studio generation type re-verified against the rebuilt UI (#23, #21)

### v1.5.4 - Citation Source Format Fix

- [x] Fixed `source_format` parameter not passed from HTTP `/ask` endpoint (critical bug)
- [x] Updated citation selectors for current NotebookLM DOM (January 2026)
- [x] New `extractSourceFromElement()` extracts both `sourceName` and `sourceText`
- [x] Fixed Docker Xvfb permissions (`/tmp/.X11-unix`)
- [x] Changed docker-compose port from 5900 to 6080 (noVNC web interface)
- [x] Added E2E tests for source format functionality

### v1.5.3 - Docker & Bulk Import

- [x] Docker deployment with noVNC for visual Google authentication
- [x] `POST /notebooks/import-from-scrape` - Bulk import notebooks from scrape
- [x] Options: `notebook_ids` filter, `auto_discover` for AI metadata generation
- [x] Chrome flags for Docker compatibility (`--no-sandbox`, etc.)

### v1.5.2 - Notebook Discovery

- [x] `list_notebooks_from_nblm` tool - Scrape NotebookLM homepage for real notebook list
- [x] `GET /notebooks/scrape` endpoint with `?show_browser=true` option
- [x] MCP and HTTP support for notebook discovery

### v1.5.1 - Multilingual UI Support

- [x] i18n system for NotebookLM UI selectors (French and English)
- [x] `NOTEBOOKLM_UI_LOCALE` environment variable
- [x] Language switching script (`scripts/switch-account-language.sh`)
- [x] Complete E2E test suite (76 tests)
- [x] Documentation for adding new languages

### v1.5.0 - Studio Complete

- [x] Video overviews (Brief, Explainer formats + 6 visual styles)
- [x] Infographics (Horizontal 16:9, Vertical 9:16)
- [x] Presentations (styles: detailed_slideshow, presenter_notes + length options)
- [x] Data tables generation
- [x] Reports with format options (summary, detailed)
- [x] Download video, infographic, audio files
- [x] Export to Google Slides/Sheets
- [x] Notes management (create, chat-to-note, note-to-source)
- [x] Delete sources by name or ID
- [x] Language selection for generated content (80+ languages)
- [x] Custom instructions support for all content types

### v1.4.0 - Content Management

- [x] Add sources (files, URLs, text, YouTube, Google Drive)
- [x] Generate audio overview (clicks real Studio buttons)
- [x] Download audio files
- [x] List sources and content
- [x] Multi-account support

### v1.3.7 - Source Citation Extraction

- [x] 5 citation formats: none, inline, footnotes, json, expanded
- [x] Hover-based citation extraction from DOM

### v1.3.6 - Documentation Restructure

- [x] Simplified README.md from 765 to 165 lines (-78%)
- [x] Extracted roadmap into dedicated `ROADMAP.md` file
- [x] Better separation: README for overview, docs/ for details

### v1.3.5 - Quality Tooling

- [x] ESLint + Prettier configuration
- [x] Jest testing infrastructure with coverage
- [x] GitHub Actions CI workflow
- [x] Codecov integration

### v1.3.4 - Minor Fixes

- [x] Fix PowerShell `CursorPosition` error in test scripts (non-interactive terminal)
- [x] Add strict type validation for `show_browser` parameter (return 400 on invalid types)

### v1.3.2 - Auto-Discovery

**Autonomous Resource Discovery:**

- [x] Automatically generate notebook name, description, and tags via NotebookLM
- [x] Progressive disclosure pattern inspired by Claude Skills best practices
- [x] Zero-friction notebook addition (30 seconds vs 5 minutes)
- [x] Validation of auto-generated metadata (kebab-case, description length, tags count)
- [x] Orchestrators discover relevant documentation autonomously

**Details:** [Auto-Discovery Documentation](./deployment/docs/07-AUTO-DISCOVERY.md)

### v1.1.2 - Foundation

**PM2 Daemon Mode:**

- [x] Cross-platform process manager with auto-restart
- [x] Commands: `npm run daemon:start`, `daemon:logs`, `daemon:status`
- [x] Built-in log rotation and monitoring

**Multi-Notebook Library:**

- [x] Live validation of notebooks
- [x] Duplicate detection
- [x] Smart notebook selection

---

## Ideas & Proposals

Have an idea? [Open a discussion](https://github.com/roomi-fields/notebooklm-mcp/discussions) to suggest new features!

---

## Changelog

For detailed version history, see [CHANGELOG.md](./CHANGELOG.md).
