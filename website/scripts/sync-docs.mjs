#!/usr/bin/env node

/**
 * Sync source-of-truth docs into website/docs/ with Docusaurus frontmatter.
 *
 * Source:  repo root CHANGELOG.md + deployment/docs/*.md
 * Target:  website/docs/*.md (regenerated on every build, gitignored)
 *
 * This keeps a single source of truth for the raw docs and lets us apply
 * SEO-tuned frontmatter per page without polluting the raw files shipped
 * to the npm consumers of the package.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(__dirname, '..');
const repoRoot = resolve(websiteRoot, '..');
const sourceDir = resolve(repoRoot, 'deployment', 'docs');
const targetDir = resolve(websiteRoot, 'docs');

// Per-file frontmatter. Keys are the filenames in deployment/docs/.
// For any file not listed here, the sync still copies but without frontmatter.
const FRONTMATTER = {
  'README.md': {
    title: 'Overview — NotebookLM MCP + HTTP REST API',
    description:
      'Google NotebookLM over MCP plus a local HTTP REST API. Citation-backed Q&A, audio, video, content generation, multi-account rotation. Claude Code, Codex, Cursor, n8n, Zapier, Make.',
    keywords: [
      'notebooklm',
      'mcp',
      'mcp-server',
      'claude-code',
      'codex',
      'cursor',
      'gemini',
      'google-notebooklm',
      'http-api',
      'rest-api',
      'n8n',
      'zapier',
      'make',
      'anthropic',
      'citations',
      'ai-agent',
    ],
    slug: '/',
    sidebar_position: 1,
  },
  '01-INSTALL.md': {
    title: 'Install NotebookLM MCP + REST API on Windows, macOS, Linux, WSL',
    description:
      'Install the NotebookLM MCP server and REST API. Clone, npm install, build, authenticate Google, register with Claude Code, Codex, Cursor, or run as a local HTTP REST API for n8n / Zapier / Make.',
    keywords: [
      'notebooklm mcp install',
      'install notebooklm rest api',
      'notebooklm mcp setup',
      'claude code mcp install',
      'notebooklm installation windows',
      'notebooklm wsl',
      'notebooklm cli install',
    ],
    slug: '/install',
  },
  '02-CONFIGURATION.md': {
    title: 'Configure NotebookLM MCP — env vars, headless, stealth, locale',
    description:
      'Full configuration reference. Environment variables for headless mode, stealth, UI locale, data directory, session timeout, max sessions. Persistent auth layout and security notes.',
    keywords: [
      'notebooklm mcp config',
      'notebooklm environment variables',
      'notebooklm headless',
      'notebooklm locale',
      'patchright stealth',
    ],
  },
  '03-API.md': {
    title: 'NotebookLM REST API reference — 45 HTTP endpoints',
    description:
      'HTTP REST API reference for NotebookLM, 45 endpoints: /ask, /content, /notebooks, /sources, /labels, /share, /health, /setup-auth. Request and response schemas, ready for n8n / Zapier / Make / curl.',
    keywords: [
      'notebooklm rest api',
      'notebooklm http api',
      'notebooklm api endpoints',
      'notebooklm ask endpoint',
      'notebooklm content api',
      'notebooklm api reference',
      'notebooklm openapi',
    ],
    slug: '/notebooklm-rest-api',
  },
  '04-N8N-INTEGRATION.md': {
    title: 'NotebookLM in n8n — HTTP workflows with citations',
    description:
      'Integrate NotebookLM into n8n workflows via the HTTP REST API. Webhook examples, scheduled queries, Slack integration, content generation flows, citation-backed responses. Works the same way for Zapier and Make.',
    keywords: [
      'notebooklm n8n',
      'n8n notebooklm integration',
      'n8n http request notebooklm',
      'notebooklm workflow automation',
      'zapier notebooklm',
      'make.com notebooklm',
      'notebooklm webhook',
    ],
    slug: '/notebooklm-n8n',
  },
  '05-TROUBLESHOOTING.md': {
    title: 'Troubleshooting — doctor scripts, common failures and fixes',
    description:
      'Common failure signatures and fixes for the NotebookLM MCP server. Doctor script, port conflicts, authentication loops, rate limits, browser profile locks, session expiry.',
    keywords: [
      'notebooklm troubleshooting',
      'notebooklm mcp errors',
      'notebooklm authentication failed',
      'notebooklm rate limit',
      'notebooklm doctor script',
    ],
  },
  '06-NOTEBOOK-LIBRARY.md': {
    title: 'Notebook library — save, search, activate, auto-discover',
    description:
      'Manage a persistent library of NotebookLM notebooks. Add by URL, search by name or topics, set an active notebook, share across Codex and Claude Code via cross-client sharing.',
    keywords: [
      'notebooklm library',
      'notebooklm notebook manager',
      'notebooklm search',
      'notebooklm cross-client',
    ],
  },
  '07-AUTO-DISCOVERY.md': {
    title: 'Auto-discover NotebookLM notebook metadata from a URL',
    description:
      'Use the auto_discover_notebook tool or /notebooks/auto-discover endpoint to extract notebook name, description, topics, and use cases from just a NotebookLM URL.',
    keywords: [
      'notebooklm auto discovery',
      'notebooklm metadata extraction',
      'auto_discover_notebook',
      'claude desktop auto discovery',
    ],
  },
  '08-DOCKER.md': {
    title: 'Deploy NotebookLM MCP with Docker and noVNC',
    description:
      'Dockerfile and docker-compose setup for the NotebookLM MCP server. Build from source, visual authentication via noVNC, Synology and QNAP NAS deployment patterns.',
    keywords: [
      'notebooklm docker',
      'notebooklm mcp container',
      'notebooklm novnc',
      'notebooklm synology',
      'notebooklm nas',
    ],
  },
  '08-WSL-USAGE.md': {
    title: 'Use NotebookLM MCP from WSL on Windows',
    description:
      'WSL workflow for the NotebookLM MCP server. Run the server on the Windows side, call it from WSL via a helper, manage the Chrome profile across WSL and Windows.',
    keywords: ['notebooklm wsl', 'notebooklm windows subsystem linux', 'notebooklm mcp wsl setup'],
  },
  '09-MULTI-INTERFACE.md': {
    title: 'Run NotebookLM MCP + HTTP server simultaneously',
    description:
      'Use NotebookLM as an MCP stdio server for Claude Code AND as a local HTTP REST API for n8n, Zapier, curl, at the same time. Stdio-to-HTTP proxy pattern, no profile conflicts.',
    keywords: [
      'notebooklm mcp http',
      'notebooklm stdio http proxy',
      'notebooklm claude desktop',
      'notebooklm multi interface',
    ],
  },
  '10-CONTENT-MANAGEMENT.md': {
    title: 'Generate audio, video, infographics, reports from NotebookLM',
    description:
      'Generate NotebookLM Studio outputs — audio podcasts, video brief and explainer, infographics, reports, presentations, data tables — programmatically via MCP or HTTP API.',
    keywords: [
      'notebooklm audio',
      'notebooklm video',
      'notebooklm podcast api',
      'notebooklm infographic',
      'notebooklm studio api',
      'notebooklm content generation',
    ],
  },
  '11-MULTI-ACCOUNT.md': {
    title: 'NotebookLM multi-account rotation with TOTP auto-reauth',
    description:
      'Configure multiple Google accounts for NotebookLM. Automatic rotation on rate-limit detection, TOTP (2FA) auto-reauth, AES-256-GCM encrypted credential vault, per-account profile storage.',
    keywords: [
      'notebooklm multi account',
      'notebooklm account rotation',
      'notebooklm rate limit',
      'notebooklm totp',
      'notebooklm 2fa automation',
      'notebooklm auto reauth',
      'google account rotation',
    ],
    slug: '/notebooklm-multi-account',
  },
  '12-BATCH-1000.md': {
    title: 'Run 1 000 NotebookLM questions overnight — REST API batch pattern',
    description:
      'Production pattern for running 1 000+ citation-backed Q&A queries against Google NotebookLM through a local HTTP REST API. Resilient batches, auto-reauth, multi-account rotation, JSON citation export, restart-safe progress, throttling.',
    keywords: [
      'notebooklm batch processing',
      'notebooklm rest api',
      'notebooklm 1000 questions',
      'automate notebooklm',
      'notebooklm overnight automation',
      'notebooklm research workflow',
      'notebooklm thesis automation',
      'notebooklm bulk queries',
    ],
    slug: '/batch-1000-questions',
  },
  '14-RTFM-INTEGRATION.md': {
    title: 'NotebookLM + RTFM — cache batch outputs as a searchable markdown vault',
    description:
      'Pipeline pattern for academic research and competitive intelligence: use NotebookLM as a one-shot ingestion layer, RTFM as the retrieval layer. /batch-to-vault endpoint, nblm-answer-v1 JSON schema, RTFM index integration, offline unlimited queries.',
    keywords: [
      'notebooklm rtfm',
      'notebooklm cache',
      'notebooklm vault',
      'notebooklm markdown',
      'notebooklm offline',
      'notebooklm retrieval layer',
      'notebooklm rate limit workaround',
      'notebooklm sota workflow',
      'notebooklm research pipeline',
      'rtfm notebooklm integration',
    ],
    slug: '/notebooklm-rtfm',
  },
  '13-COMPARE.md': {
    title: 'Migrating from PleasePrompto/notebooklm-mcp (archived) — tool mapping and comparison',
    description:
      'PleasePrompto/notebooklm-mcp was archived in September 2026. How to migrate: 17 of its 19 tool names work unchanged, the environment variables that differ, the one variable that means something else here, and a full feature comparison.',
    keywords: [
      'pleaseprompto notebooklm-mcp archived',
      'notebooklm-mcp unmaintained',
      'notebooklm-mcp alternative',
      'migrate from notebooklm-mcp',
      'notebooklm mcp replacement',
      'notebooklm mcp comparison',
      'notebooklm rest api alternative',
      'notebooklm studio api',
    ],
    // Slug kept as /compare: the page changed purpose, but the URL has been
    // live for months and carries whatever ranking it has earned. Title,
    // description and keywords do the targeting; the path string does not.
    slug: '/compare',
  },
  '15-SECURITY.md': {
    title: 'Securing the NotebookLM HTTP API — token, bind address, allowed origins',
    description:
      'Secure the NotebookLM REST API: loopback by default, NOTEBOOKLM_API_KEY required to expose it, NOTEBOOKLM_ALLOWED_ORIGINS for browser clients, Docker requirements, and how to report a vulnerability.',
    keywords: [
      'notebooklm mcp security',
      'notebooklm api token',
      'mcp server authentication',
      'notebooklm rest api auth',
      'mcp server exposed port',
      'notebooklm api key',
    ],
    slug: '/security',
  },
};

function renderFrontmatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(', ')}]`);
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

// Ensure target exists — website/docs/ is gitignored, so on a fresh
// CI checkout the directory may not exist yet.
mkdirSync(targetDir, { recursive: true });

// Sync deployment/docs/*.md → website/docs/
for (const file of readdirSync(sourceDir)) {
  if (!file.endsWith('.md')) continue;
  const src = resolve(sourceDir, file);
  const dst = resolve(targetDir, file);
  const body = readFileSync(src, 'utf-8');
  const fm = FRONTMATTER[file] ? renderFrontmatter(FRONTMATTER[file]) : '';
  writeFileSync(dst, fm + body, 'utf-8');
  console.log(`  ${file}`);
}

// Sync root CHANGELOG.md → website/docs/CHANGELOG.md
{
  const changelogSrc = resolve(repoRoot, 'CHANGELOG.md');
  const changelogDst = resolve(targetDir, 'CHANGELOG.md');
  const fm = renderFrontmatter({
    title: 'Release history and per-version changelog',
    description:
      'Detailed per-version changelog for the NotebookLM MCP + HTTP REST API server. Added, changed, fixed, and security notes for every release since 1.0.0.',
    keywords: ['notebooklm mcp changelog', 'notebooklm release history', 'notebooklm mcp versions'],
    sidebar_position: 99,
    slug: '/changelog',
  });
  let body = readFileSync(changelogSrc, 'utf-8');
  body = body.replace(/^#\s+Changelog\s*\n+/, '');
  writeFileSync(changelogDst, fm + body, 'utf-8');
  console.log('  CHANGELOG.md');
}

console.log('Docs sync complete.');
