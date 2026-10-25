/**
 * HTTP Wrapper for NotebookLM MCP Server
 *
 * Exposes the MCP server via HTTP REST API
 * Allows n8n and other tools to call the server without stdio
 */

import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import net from 'net';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { AuthManager } from './auth/auth-manager.js';
import { SessionManager } from './session/session-manager.js';
import { NotebookLibrary } from './library/notebook-library.js';
import { ToolHandlers, buildToolDefinitions } from './tools/index.js';
import { AutoDiscovery } from './auto-discovery/auto-discovery.js';
import { StartupManager } from './startup/startup-manager.js';
import { isNotebookHost } from './utils/notebook-domain.js';
import { log } from './utils/logger.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
  type Tool,
  type Resource,
} from '@modelcontextprotocol/sdk/types.js';
import { CANONICAL_TO_LEGACY } from './tools/tool-names.js';

const SERVER_VERSION = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
  ) as { version: string }
).version;

// Extend Express Request to include requestId
import {
  assertSafeBind,
  createHostGuard,
  createOriginGuard,
  createTokenGuard,
  isLoopbackHost,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveApiToken,
  resolveHttpHost,
} from './http-security.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      /** Set by the token guard: true once a valid token was presented. */
      authenticatedCaller?: boolean;
    }
  }
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Request ID middleware for debugging and log correlation
app.use((req: Request, res: Response, next: NextFunction) => {
  // Use existing X-Request-ID header or generate a new one
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// Network exposure controls — see src/http-security.ts (GHSA-p69m-c5rf-g2c3,
// GHSA-2fgr-6pf3-3hcx). The host guard runs FIRST: it is the one control that
// does not depend on a header the caller can simply omit, so a rebound
// hostname is refused before anything else looks at the request. Then a
// browser page gets through only if its origin was allow-listed, and every
// route but /health needs the token once NOTEBOOKLM_API_KEY is set.
const API_TOKEN = resolveApiToken();
const HOST = resolveHttpHost();
app.use(createHostGuard(HOST, resolveAllowedHosts()));
app.use(createOriginGuard(resolveAllowedOrigins()));
app.use(createTokenGuard(API_TOKEN));

// Initialize managers
const authManager = new AuthManager();
const sessionManager = new SessionManager(authManager);
const library = new NotebookLibrary(sessionManager);
const toolHandlers = new ToolHandlers(sessionManager, authManager, library);

// MCP over Streamable HTTP (native /mcp endpoint for HTTP clients like Hermes)
/* eslint-disable @typescript-eslint/no-explicit-any */
const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'notebooklm-mcp',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  const toolDefinitions = buildToolDefinitions(library) as Tool[];

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolDefinitions,
    };
  });

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const notebooks = library.listNotebooks();
    const resources: Resource[] = [
      {
        uri: 'notebooklm://library',
        name: 'Notebook Library',
        description:
          'Complete notebook library with all available knowledge sources. ' +
          'Read this to discover what notebooks are available. ' +
          "⚠️ If you think a notebook might help with the user's task, " +
          'ASK THE USER FOR PERMISSION before consulting it: ' +
          "'Should I consult the [notebook] for this task?'",
        mimeType: 'application/json',
      },
    ];

    for (const notebook of notebooks) {
      resources.push({
        uri: `notebooklm://library/${notebook.id}`,
        name: notebook.name,
        description:
          `${notebook.description} | Topics: ${notebook.topics.join(', ')} | ` +
          `💡 Use ask_question to query this notebook (ask user permission first if task isn't explicitly about these topics)`,
        mimeType: 'application/json',
      });
    }

    const active = library.getActiveNotebook();
    if (active) {
      resources.push({
        uri: 'notebooklm://metadata',
        name: 'Active Notebook Metadata (Legacy)',
        description:
          'Information about the currently active notebook. ' +
          'DEPRECATED: Use notebooklm://library instead for multi-notebook support. ' +
          "⚠️ Always ask user permission before using notebooks for tasks they didn't explicitly mention.",
        mimeType: 'application/json',
      });
    }

    return { resources };
  });

  // List resource templates
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        {
          uriTemplate: 'notebooklm://library/{id}',
          name: 'Notebook by ID',
          description:
            'Access a specific notebook from your library by ID. ' +
            'Provides detailed metadata about the notebook including topics, use cases, and usage statistics. ' +
            "💡 Use the 'id' parameter from list_notebooks to access specific notebooks.",
          mimeType: 'application/json',
        },
      ],
    };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'notebooklm://library') {
      const notebooks = library.listNotebooks();
      const stats = library.getStats();
      const active = library.getActiveNotebook();

      const libraryData = {
        active_notebook: active
          ? {
              id: active.id,
              name: active.name,
              description: active.description,
              topics: active.topics,
            }
          : null,
        notebooks: notebooks.map((nb) => ({
          id: nb.id,
          name: nb.name,
          description: nb.description,
          topics: nb.topics,
          content_types: nb.content_types,
          use_cases: nb.use_cases,
          url: nb.url,
          use_count: nb.use_count,
          last_used: nb.last_used,
          tags: nb.tags,
        })),
        stats,
      };

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(libraryData, null, 2),
          },
        ],
      };
    }

    if (uri.startsWith('notebooklm://library/')) {
      const prefix = 'notebooklm://library/';
      const encodedId = uri.slice(prefix.length);
      if (!encodedId) {
        throw new Error('Notebook resource requires an ID (e.g. notebooklm://library/{id})');
      }

      let id: string;
      try {
        id = decodeURIComponent(encodedId);
      } catch {
        throw new Error(`Invalid notebook identifier encoding: ${encodedId}`);
      }

      if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) {
        throw new Error(
          `Invalid notebook identifier: ${encodedId}. Notebook IDs may only contain letters, numbers, and hyphens.`
        );
      }

      const notebook = library.getNotebook(id);

      if (!notebook) {
        throw new Error(`Notebook not found: ${id}`);
      }

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(notebook, null, 2),
          },
        ],
      };
    }

    if (uri === 'notebooklm://metadata') {
      const active = library.getActiveNotebook();

      if (!active) {
        throw new Error('No active notebook. Use notebooklm://library to see all notebooks.');
      }

      const metadata = {
        description: active.description,
        topics: active.topics,
        content_types: active.content_types,
        use_cases: active.use_cases,
        notebook_url: active.url,
        notebook_id: active.id,
        last_used: active.last_used,
        use_count: active.use_count,
        note: 'DEPRECATED: Use notebooklm://library or notebooklm://library/{id} instead',
      };

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(metadata, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: requestedName, arguments: args } = request.params;
    const name = CANONICAL_TO_LEGACY[requestedName] ?? requestedName;
    const progressToken = (args as Record<string, unknown> | undefined)?._meta as
      | { progressToken?: string }
      | undefined;
    const token = progressToken?.progressToken;

    const sendProgress = async (message: string, progress?: number, total?: number) => {
      if (token) {
        try {
          await server.notification({
            method: 'notifications/progress',
            params: {
              progressToken: token,
              message,
              ...(progress !== undefined && { progress }),
              ...(total !== undefined && { total }),
            },
          });
        } catch {
          // ignore
        }
      }
    };

    try {
      let result: any;

      switch (name) {
        case 'ask_question':
          result = await toolHandlers.handleAskQuestion(
            args as {
              question: string;
              session_id?: string;
              notebook_id?: string;
              notebook_url?: string;
              show_browser?: boolean;
            },
            sendProgress
          );
          break;

        case 'batch_to_vault':
          try {
            result = await (toolHandlers as any).handleBatchToVault(args as any, sendProgress);
          } catch {
            result = await (toolHandlers as any).handleBatchToVault?.(args as any);
          }
          break;

        case 'add_notebook':
          result = await toolHandlers.handleAddNotebook(args as any);
          break;

        case 'list_notebooks':
          result = await toolHandlers.handleListNotebooks();
          break;

        case 'get_notebook':
          result = await toolHandlers.handleGetNotebook(args as any);
          break;

        case 'select_notebook':
          result = await toolHandlers.handleSelectNotebook(args as any);
          break;

        case 'remove_notebook':
          result = await toolHandlers.handleRemoveNotebook(args as any);
          break;

        case 'update_notebook':
          result = await toolHandlers.handleUpdateNotebook(args as any);
          break;

        case 'get_library_stats':
          result = await toolHandlers.handleGetLibraryStats();
          break;

        case 'search_notebooks':
          result = await toolHandlers.handleSearchNotebooks(args as any);
          break;

        case 'auto_discover_notebook':
          result = await toolHandlers.handleAutoDiscoverNotebook(args as any);
          break;

        case 'setup_auth':
          result = await toolHandlers.handleSetupAuth(args as any);
          break;

        case 'list_sessions':
          result = await toolHandlers.handleListSessions();
          break;

        case 'close_session':
          result = await toolHandlers.handleCloseSession(args as any);
          break;

        case 'reset_session':
          result = await toolHandlers.handleResetSession(args as any);
          break;

        case 'get_health':
          result = await toolHandlers.handleGetHealth();
          break;

        case 'add_source':
          result = await toolHandlers.handleAddSource(args as any);
          break;

        case 'rename_source':
        case 'remove_source':
          result = await toolHandlers.handleRenameSource(args as any);
          break;

        case 'generate_content':
          try {
            result = await (toolHandlers as any).handleGenerateContent(args as any, sendProgress);
          } catch {
            try {
              result = await (toolHandlers as any).handleGenerateContent(args as any);
            } catch {
              result = await (toolHandlers as any).handleGenerateContent(args as any);
            }
          }
          break;

        case 'download_content':
          result = await toolHandlers.handleDownloadContent(args as any);
          break;

        case 'create_note':
          result = await toolHandlers.handleCreateNote(args as any);
          break;

        case 'chat_to_note':
        case 'save_chat_to_note':
          result = await toolHandlers.handleSaveChatToNote(args as any);
          break;

        case 'note_to_source':
        case 'convert_note_to_source':
          result = await toolHandlers.handleConvertNoteToSource(args as any);
          break;

        case 'list_sources':
          try {
            result = await toolHandlers.handleListSources((args || {}) as any);
          } catch {
            result = await (toolHandlers as any).handleListSources?.((args || {}) as any);
          }
          break;

        case 'read_source':
          try {
            result = await toolHandlers.handleReadSource(args as any);
          } catch {
            result = await (toolHandlers as any).handleReadSource?.(args as any);
          }
          break;

        case 'scrape_notebook':
          try {
            result = await (toolHandlers as any).handleScrapeNotebook?.(args as any);
          } catch {
            result = await (toolHandlers as any).handleCreateNotebook?.(args as any);
          }
          if (!result) {
            throw new Error('Scrape notebook not available in this build');
          }
          break;

        case 're_authenticate':
        case 're_auth':
          result = await (toolHandlers as any).handleReAuth?.(args as any);
          if (!result) throw new Error('Re-auth not available');
          break;

        case 'de_authenticate':
        case 'de_auth':
          result = await (toolHandlers as any).handleDeAuth?.();
          if (!result) throw new Error('De-auth not available');
          break;

        case 'cleanup_data':
          result = await toolHandlers.handleCleanupData(args as any);
          break;

        default:
          throw new Error(`Unknown tool: ${requestedName}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Streamable HTTP MCP endpoint
app.all('/mcp', async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      if (sessionId && mcpTransports.has(sessionId)) {
        const transport = mcpTransports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            mcpTransports.set(id, transport);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            mcpTransports.delete(sid);
          }
        };

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    if (req.method === 'GET') {
      if (!sessionId || !mcpTransports.has(sessionId)) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      const transport = mcpTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      if (!sessionId || !mcpTransports.has(sessionId)) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      const transport = mcpTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    res.status(405).set('Allow', 'GET, POST, DELETE').send('Method Not Allowed');
  } catch (error) {
    log.error(`MCP HTTP error: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Root endpoint - API info
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'NotebookLM MCP HTTP Server',
    // Read from package.json, not `npm_package_version`: that variable only
    // exists when the server is started through an npm script, so a plain
    // `node dist/http-wrapper.js` used to report the hardcoded fallback —
    // which had been stale since 1.5.2.
    version: SERVER_VERSION,
    endpoints: {
      health: 'GET /health',
      ask: 'POST /ask',
      batch_to_vault: 'POST /batch-to-vault',
      setup_auth: 'POST /setup-auth',
      notebooks: 'GET /notebooks',
      sources: 'GET /notebooks/:id/sources',
      read_source: 'GET /notebooks/:id/sources/:sourceId',
      sessions: 'GET /sessions',
    },
    docs: 'https://notebooklm.roomi-fields.com/',
  });
});

// Health check
app.get('/health', async (_req: Request, res: Response) => {
  try {
    // Open to monitors and container health checks. Once a token is set, a
    // caller without it gets liveness only, because the full report names the
    // active notebook. With no token configured there is no caller to tell
    // apart, so the full report is returned — that posture is loopback-only
    // and host-guarded, which is what keeps a web page out of it.
    if (API_TOKEN && !_req.authenticatedCaller) {
      return res.json({ status: 'ok', version: SERVER_VERSION });
    }
    const result = await toolHandlers.handleGetHealth();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Ask question
app.post('/ask', async (req: Request, res: Response) => {
  const reqId = req.requestId.substring(0, 8); // Short ID for logs
  try {
    const { question, session_id, notebook_id, notebook_url, show_browser, source_format } =
      req.body;

    if (!question) {
      log.warning(`[${reqId}] /ask - Missing question`);
      return res.status(400).json({
        success: false,
        error: 'Missing required field: question',
      });
    }

    const result = await toolHandlers.handleAskQuestion(
      { question, session_id, notebook_id, notebook_url, show_browser, source_format },
      async (message, progress, total) => {
        log.info(`[${reqId}] Progress: ${message} (${progress}/${total})`);
      }
    );

    log.success(`[${reqId}] /ask - Completed`);
    res.json(result);
  } catch (error) {
    log.error(`[${reqId}] /ask - Error: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Batch-to-vault — run a list of questions and persist each answer as
// markdown + JSON sidecar files, ready for ingestion by RTFM or any
// markdown vault indexer. Conforms to the nblm-answer-v1 schema.
//
// Same logic is exposed as the `batch_to_vault` MCP tool — both call
// ToolHandlers.handleBatchToVault, which wraps the shared runBatchToVault helper.
app.post('/batch-to-vault', async (req: Request, res: Response) => {
  const reqId = req.requestId.substring(0, 8);
  try {
    const {
      questions,
      notebook_id,
      notebook_url,
      vault_dir,
      slug_prefix,
      source_format,
      sleep_between_ms,
      session_id,
    } = req.body;

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or empty required field: questions (non-empty string array)',
      });
    }
    if (!vault_dir || typeof vault_dir !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: vault_dir (absolute or relative directory path)',
      });
    }

    log.info(`[${reqId}] /batch-to-vault — ${questions.length} questions → ${vault_dir}`);

    const result = await toolHandlers.handleBatchToVault({
      questions,
      vault_dir,
      notebook_id,
      notebook_url,
      slug_prefix,
      source_format,
      sleep_between_ms,
      session_id,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    log.success(
      `[${reqId}] /batch-to-vault — ${result.data!.succeeded}/${result.data!.total} written to ${result.data!.vault_dir}`
    );
    res.json(result);
  } catch (error) {
    log.error(
      `[${reqId}] /batch-to-vault - Error: ${error instanceof Error ? error.message : String(error)}`
    );
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Setup auth
app.post('/setup-auth', async (req: Request, res: Response) => {
  try {
    const { show_browser } = req.body;

    const result = await toolHandlers.handleSetupAuth(
      { show_browser },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// De-authenticate (logout)
app.post('/de-auth', async (_req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleDeAuth();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Re-authenticate
app.post('/re-auth', async (req: Request, res: Response) => {
  try {
    const { show_browser } = req.body;

    const result = await toolHandlers.handleReAuth(
      { show_browser },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Cleanup data
app.post('/cleanup-data', async (req: Request, res: Response) => {
  try {
    const { confirm, preserve_library } = req.body;
    const result = await toolHandlers.handleCleanupData({ confirm, preserve_library });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// List notebooks
app.get('/notebooks', async (_req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleListNotebooks();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Add notebook
app.post('/notebooks', async (req: Request, res: Response) => {
  try {
    const { url, name, description, topics, content_types, use_cases, tags } = req.body;

    if (!url || !name || !description || !topics) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: url, name, description, topics',
      });
    }

    const result = await toolHandlers.handleAddNotebook({
      url,
      name,
      description,
      topics,
      content_types,
      use_cases,
      tags,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Search notebooks (MUST be before /notebooks/:id to avoid being shadowed)
app.get('/notebooks/search', async (req: Request, res: Response) => {
  try {
    const { query } = req.query;
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid query parameter',
      });
    }
    const result = await toolHandlers.handleSearchNotebooks({ query });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get library stats (MUST be before /notebooks/:id to avoid being shadowed)
app.get('/notebooks/stats', async (_req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleGetLibraryStats();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Scrape notebooks from NotebookLM homepage (MUST be before /notebooks/:id to avoid being shadowed)
app.get('/notebooks/scrape', async (req: Request, res: Response) => {
  try {
    const showBrowser = req.query.show_browser === 'true';

    const result = await toolHandlers.handleListNotebooksFromNblm(
      { show_browser: showBrowser },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Import scraped notebooks into library (MUST be before /notebooks/:id)
app.post('/notebooks/import-from-scrape', async (req: Request, res: Response) => {
  try {
    const { notebook_ids, auto_discover, show_browser } = req.body;

    // Step 1: Scrape notebooks from NotebookLM
    log.info('📥 [IMPORT] Starting import from scrape...');
    const scrapeResult = await toolHandlers.handleListNotebooksFromNblm(
      { show_browser: show_browser === true },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    if (!scrapeResult.success || !scrapeResult.data) {
      res.status(500).json({
        success: false,
        error: `Scrape failed: ${scrapeResult.error || 'Unknown error'}`,
      });
      return;
    }

    const scrapedNotebooks = scrapeResult.data.notebooks;
    log.info(`  📋 Found ${scrapedNotebooks.length} notebooks from scrape`);

    // Step 2: Filter notebooks if notebook_ids provided
    let notebooksToImport = scrapedNotebooks;
    if (notebook_ids && Array.isArray(notebook_ids) && notebook_ids.length > 0) {
      notebooksToImport = scrapedNotebooks.filter((nb) => notebook_ids.includes(nb.id));
      log.info(`  🔍 Filtered to ${notebooksToImport.length} notebooks`);
    }

    // Step 3: Import each notebook
    const imported: Array<{ id: string; name: string; status: string }> = [];
    const errors: Array<{ id: string; name: string; error: string }> = [];

    for (const notebook of notebooksToImport) {
      try {
        if (auto_discover === true) {
          // Use auto-discovery to generate metadata
          log.info(`  🤖 Auto-discovering: ${notebook.name}`);
          const discoverResult = await toolHandlers.handleAutoDiscoverNotebook({
            url: notebook.url,
          });
          if (discoverResult.success) {
            imported.push({ id: notebook.id, name: notebook.name, status: 'auto-discovered' });
          } else {
            errors.push({
              id: notebook.id,
              name: notebook.name,
              error: discoverResult.error || 'Auto-discovery failed',
            });
          }
        } else {
          // Add with minimal metadata
          log.info(`  📝 Adding: ${notebook.name}`);
          const addResult = await toolHandlers.handleAddNotebook({
            url: notebook.url,
            name: notebook.name,
            description: `Imported from NotebookLM scrape`,
            topics: [notebook.name.toLowerCase().replace(/\s+/g, '-')],
          });
          if (addResult.success) {
            imported.push({ id: notebook.id, name: notebook.name, status: 'imported' });
          } else {
            errors.push({
              id: notebook.id,
              name: notebook.name,
              error: addResult.error || 'Add failed',
            });
          }
        }
      } catch (error) {
        errors.push({
          id: notebook.id,
          name: notebook.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log.success(`✅ [IMPORT] Completed: ${imported.length} imported, ${errors.length} errors`);

    res.json({
      success: true,
      data: {
        imported,
        errors,
        total_scraped: scrapedNotebooks.length,
        total_imported: imported.length,
        total_errors: errors.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Bulk delete notebooks from NotebookLM (MUST be before /notebooks/:id)
app.delete('/notebooks/bulk-delete', async (req: Request, res: Response) => {
  try {
    const { notebook_ids, show_browser } = req.body;

    if (!notebook_ids || !Array.isArray(notebook_ids) || notebook_ids.length === 0) {
      res.status(400).json({
        success: false,
        error: 'notebook_ids array is required',
      });
      return;
    }

    const result = await toolHandlers.handleDeleteNotebooksFromNblm(
      { notebook_ids, show_browser: show_browser === true },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get notebook
app.get('/notebooks/:id', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleGetNotebook({ id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Update notebook
app.put('/notebooks/:id', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleUpdateNotebook({
      id: req.params.id,
      ...req.body,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Delete notebook
app.delete('/notebooks/:id', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleRemoveNotebook({ id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Auto-discover notebook metadata
app.post('/notebooks/auto-discover', async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    // Validate URL is provided
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: url',
      });
    }

    // Validate it's a NotebookLM URL (proper URL parsing to prevent bypass)
    try {
      const parsedUrl = new URL(url);
      if (!isNotebookHost(parsedUrl.hostname)) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid URL: must be a NotebookLM URL (notebook.google.com or notebooklm.google.com)',
        });
      }
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format',
      });
    }

    // Create AutoDiscovery instance and discover metadata
    const autoDiscovery = new AutoDiscovery(sessionManager);

    let metadata;
    try {
      metadata = await autoDiscovery.discoverMetadata(url);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: `Failed to discover metadata: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    // Transform metadata to NotebookLibrary format
    // - tags → topics (rename field)
    // - Add default content_types
    // - Add default use_cases based on first few tags
    const notebookInput = {
      url,
      name: metadata.name,
      description: metadata.description,
      topics: metadata.tags, // tags → topics
      content_types: ['documentation'],
      use_cases: metadata.tags.slice(0, 3), // Use first 3 tags as use cases
      auto_generated: true,
    };

    // Add notebook to library
    let notebook;
    try {
      notebook = await library.addNotebook(notebookInput);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: `Failed to add notebook to library: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    // Return success with created notebook
    res.json({
      success: true,
      notebook,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Create a new notebook in NotebookLM (via browser automation)
app.post('/notebooks/create', async (req: Request, res: Response) => {
  try {
    const { name, show_browser } = req.body;

    const result = await toolHandlers.handleCreateNotebook(
      { name, show_browser },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Activate notebook (set as active)
app.put('/notebooks/:id/activate', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleSelectNotebook({ id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get notebook sharing status (RPC extension)
app.get('/notebooks/:id/share', async (req: Request, res: Response) => {
  try {
    res.json(await toolHandlers.handleNotebookSharing({ notebook_id: req.params.id }));
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Toggle the public link (RPC extension). Body: { public: boolean }
app.put('/notebooks/:id/share', async (req: Request, res: Response) => {
  try {
    res.json(
      await toolHandlers.handleNotebookSharing({
        notebook_id: req.params.id,
        set_public: req.body?.public === true,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Generate a study aid (flashcards/quiz) — RPC extension. Body: { notebook_url, kind, focus }
app.post('/content/study-aid', async (req: Request, res: Response) => {
  try {
    const { notebook_url, notebook_id, kind, focus, language } = req.body || {};
    res.json(
      await toolHandlers.handleGenerateStudyAid({
        notebook_url,
        notebook_id,
        kind,
        focus,
        language,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Discover web sources — RPC extension. Body: { notebook_url, query, import }
app.post('/content/research', async (req: Request, res: Response) => {
  try {
    const { notebook_url, notebook_id, query, import: imp } = req.body || {};
    res.json(
      await toolHandlers.handleResearchSources({ notebook_url, notebook_id, query, import: imp })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Generate + save a mind map — RPC extension. Body: { notebook_url, title }
app.post('/content/mind-map', async (req: Request, res: Response) => {
  try {
    const { notebook_url, notebook_id, title, language, focus } = req.body || {};
    res.json(
      await toolHandlers.handleGenerateMindMap({
        notebook_url,
        notebook_id,
        title,
        language,
        focus,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Manage source labels — RPC extension. GET = list; POST = { action, name, emoji, label_ids }
app.get('/notebooks/:id/labels', async (req: Request, res: Response) => {
  try {
    res.json(await toolHandlers.handleLabels({ notebook_id: req.params.id, action: 'list' }));
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});
app.post('/notebooks/:id/labels', async (req: Request, res: Response) => {
  try {
    const { action, name, emoji, label_ids } = req.body || {};
    res.json(
      await toolHandlers.handleLabels({
        notebook_id: req.params.id,
        action,
        name,
        emoji,
        label_ids,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// A notebook's own summary of its sources + the questions it suggests — RPC extension.
app.get('/notebooks/:id/summary', async (req: Request, res: Response) => {
  try {
    res.json(await toolHandlers.handleNotebookSummary({ notebook_id: req.params.id }));
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Have the notebook's URL / Drive sources drifted? `?source_id=` narrows to one.
app.get('/notebooks/:id/freshness', async (req: Request, res: Response) => {
  try {
    const sourceId = typeof req.query.source_id === 'string' ? req.query.source_id : undefined;
    res.json(
      await toolHandlers.handleSourceFreshness({ notebook_id: req.params.id, source_id: sourceId })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Read back the recorded questions and answers, newest first.
// `?conversation_id=` picks one, `?limit=` caps the turns.
app.get('/notebooks/:id/chat', async (req: Request, res: Response) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(
      await toolHandlers.handleChatHistory({
        notebook_id: req.params.id,
        conversation_id:
          typeof req.query.conversation_id === 'string' ? req.query.conversation_id : undefined,
        limit,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Clear the chat history. NotebookLM deletes whole conversations, never one turn.
app.delete('/notebooks/:id/chat', async (req: Request, res: Response) => {
  try {
    res.json(
      await toolHandlers.handleDeleteChatHistory({
        notebook_id: req.params.id,
        conversation_id:
          typeof req.query.conversation_id === 'string' ? req.query.conversation_id : undefined,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// List a notebook's sources with their IDs — RPC extension.
app.get('/notebooks/:id/sources', async (req: Request, res: Response) => {
  try {
    res.json(await toolHandlers.handleListSources({ notebook_id: req.params.id }));
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Read a source's indexed text — RPC extension.
// `?format=text|html`, `?paginate=false` for the whole document in one response,
// `?max_chars=` for the page size, `?cursor=` to resume from a previous page.
app.get('/notebooks/:id/sources/:sourceId', async (req: Request, res: Response) => {
  try {
    const num = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : undefined);
    res.json(
      await toolHandlers.handleReadSource({
        notebook_id: req.params.id,
        source_id: req.params.sourceId,
        format: req.query.format === 'html' ? 'html' : 'text',
        paginate: req.query.paginate !== 'false',
        max_chars: num(req.query.max_chars),
        cursor: num(req.query.cursor),
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// List sessions
// Rename one source in place — RPC extension. Body: { title }
app.patch('/notebooks/:id/sources/:sourceId', async (req: Request, res: Response) => {
  try {
    const title = req.body?.title;
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Missing required field: title' });
    }
    res.json(
      await toolHandlers.handleRenameSource({
        notebook_id: req.params.id,
        source_id: req.params.sourceId,
        title,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// NotebookLM's own summary and key topics for one source — RPC extension.
app.get('/notebooks/:id/sources/:sourceId/guide', async (req: Request, res: Response) => {
  try {
    res.json(
      await toolHandlers.handleSourceGuide({
        notebook_id: req.params.id,
        source_id: req.params.sourceId,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/sessions', async (_req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleListSessions();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Close session
app.delete('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleCloseSession({ session_id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Reset session
app.post('/sessions/:id/reset', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleResetSession({ session_id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ========================================
// Content Management Routes
// ========================================

// Add source to notebook
app.post('/content/sources', async (req: Request, res: Response) => {
  try {
    const { source_type, file_path, url, text, title, notebook_url, session_id, show_browser } =
      req.body;

    if (!source_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: source_type',
      });
    }

    const result = await toolHandlers.handleAddSource({
      source_type,
      file_path,
      url,
      text,
      title,
      notebook_url,
      session_id,
      show_browser,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Delete source from notebook
app.delete('/content/sources/:id', async (req: Request, res: Response) => {
  try {
    const { notebook_url, session_id } = req.query;
    const sourceId = req.params.id;

    if (!sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Missing source ID in URL path',
      });
    }

    const result = await toolHandlers.handleDeleteSource({
      source_id: sourceId,
      notebook_url: typeof notebook_url === 'string' ? notebook_url : undefined,
      session_id: typeof session_id === 'string' ? session_id : undefined,
    });

    if (!result.success) {
      // Return 404 if source not found
      if (result.error?.includes('not found')) {
        return res.status(404).json(result);
      }
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Delete source by name (alternative endpoint)
app.delete('/content/sources', async (req: Request, res: Response) => {
  try {
    const { source_name, source_id, notebook_url, session_id } = req.query;

    if (!source_name && !source_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: source_name or source_id',
      });
    }

    const result = await toolHandlers.handleDeleteSource({
      source_id: typeof source_id === 'string' ? source_id : undefined,
      source_name: typeof source_name === 'string' ? source_name : undefined,
      notebook_url: typeof notebook_url === 'string' ? notebook_url : undefined,
      session_id: typeof session_id === 'string' ? session_id : undefined,
    });

    if (!result.success) {
      // Return 404 if source not found
      if (result.error?.includes('not found')) {
        return res.status(404).json(result);
      }
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Declared AFTER the literal /content/sources routes on purpose: Express
// matches in declaration order, so a parameterised route placed earlier
// swallows every literal sibling. It did — DELETE /content/sources was
// unreachable, arriving here as an artifact id of "sources".
// Delete a generated Studio artifact — RPC extension.
app.delete('/content/:contentId', async (req: Request, res: Response) => {
  try {
    const { notebook_url, notebook_id } = req.query as Record<string, string | undefined>;
    res.json(
      await toolHandlers.handleDeleteContent({
        content_id: req.params.contentId,
        notebook_url,
        notebook_id,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Generate content (audio_overview, presentation, report, data_table, infographic, and video are supported)
app.post('/content/generate', async (req: Request, res: Response) => {
  try {
    const {
      content_type,
      custom_instructions,
      notebook_url,
      session_id,
      language,
      video_style,
      video_format,
      infographic_format,
      report_format,
      presentation_style,
      presentation_length,
    } = req.body;

    if (!content_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: content_type',
      });
    }

    // Validate content_type is supported
    const supportedTypes = [
      'audio_overview',
      'presentation',
      'report',
      'infographic',
      'data_table',
      'video',
    ];
    if (!supportedTypes.includes(content_type)) {
      return res.status(400).json({
        success: false,
        error:
          `Content type '${content_type}' is not supported. Supported types: ${supportedTypes.join(', ')}. ` +
          'These use real NotebookLM Studio UI buttons or the generic ContentGenerator.',
      });
    }

    // Warn if custom_instructions provided for content types that don't support it
    const noCustomInstructionsTypes = ['report']; // report and mindmap (when implemented) don't support prompts
    if (custom_instructions && noCustomInstructionsTypes.includes(content_type)) {
      return res.status(400).json({
        success: false,
        error:
          `Content type '${content_type}' does not support custom_instructions. ` +
          `Only format/language options are available for this type.`,
      });
    }

    // Validate video_style if provided (only valid for video content type)
    const validVideoStyles = [
      'classroom',
      'documentary',
      'animated',
      'corporate',
      'cinematic',
      'minimalist',
    ];
    if (video_style && !validVideoStyles.includes(video_style)) {
      return res.status(400).json({
        success: false,
        error: `Video style '${video_style}' is not supported. Supported styles: ${validVideoStyles.join(', ')}.`,
      });
    }

    if (video_style && content_type !== 'video') {
      return res.status(400).json({
        success: false,
        error: `video_style is only valid for content_type 'video', not '${content_type}'.`,
      });
    }

    // Validate video_format if provided
    if (video_format && !['brief', 'explainer'].includes(video_format)) {
      return res.status(400).json({
        success: false,
        error: `Video format '${video_format}' is not supported. Supported formats: brief, explainer.`,
      });
    }

    // Validate infographic_format if provided
    if (infographic_format && !['horizontal', 'vertical'].includes(infographic_format)) {
      return res.status(400).json({
        success: false,
        error: `Infographic format '${infographic_format}' is not supported. Supported formats: horizontal, vertical.`,
      });
    }

    // Validate report_format if provided
    if (report_format && !['summary', 'detailed'].includes(report_format)) {
      return res.status(400).json({
        success: false,
        error: `Report format '${report_format}' is not supported. Supported formats: summary, detailed.`,
      });
    }

    // Validate presentation_style if provided
    if (
      presentation_style &&
      !['detailed_slideshow', 'presenter_notes'].includes(presentation_style)
    ) {
      return res.status(400).json({
        success: false,
        error: `Presentation style '${presentation_style}' is not supported. Supported styles: detailed_slideshow, presenter_notes.`,
      });
    }

    // Validate presentation_length if provided
    if (presentation_length && !['short', 'default'].includes(presentation_length)) {
      return res.status(400).json({
        success: false,
        error: `Presentation length '${presentation_length}' is not supported. Supported lengths: short, default.`,
      });
    }

    // Note: data_table has no format options - it exports to Google Sheets

    const result = await toolHandlers.handleGenerateContent({
      content_type,
      custom_instructions,
      notebook_url,
      session_id,
      language,
      video_style,
      video_format,
      infographic_format,
      report_format,
      presentation_style,
      presentation_length,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// List sources and generated content
app.get('/content', async (req: Request, res: Response) => {
  try {
    const { notebook_url, session_id } = req.query;

    const result = await toolHandlers.handleListContent({
      notebook_url: typeof notebook_url === 'string' ? notebook_url : undefined,
      session_id: typeof session_id === 'string' ? session_id : undefined,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Download/export content (audio, video, infographic, presentation, data_table)
app.get('/content/download', async (req: Request, res: Response) => {
  try {
    const { content_type, output_path, notebook_url, session_id } = req.query;

    if (!content_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: content_type',
      });
    }

    // Validate content_type is downloadable/exportable
    // - audio_overview, video, infographic: downloadable as files
    // - presentation: exports to Google Slides
    // - data_table: exports to Google Sheets
    // - report: text-based only (no export)
    const exportableTypes = [
      'audio_overview',
      'video',
      'infographic',
      'presentation',
      'data_table',
    ];
    if (!exportableTypes.includes(content_type as string)) {
      return res.status(400).json({
        success: false,
        error:
          `Content type '${content_type}' is not exportable. Exportable types: ${exportableTypes.join(', ')}. ` +
          'Report content is text-based and returned in the generation response.',
      });
    }

    const result = await toolHandlers.handleDownloadContent({
      content_type: content_type as
        | 'audio_overview'
        | 'video'
        | 'infographic'
        | 'presentation'
        | 'data_table',
      output_path: typeof output_path === 'string' ? output_path : undefined,
      notebook_url: typeof notebook_url === 'string' ? notebook_url : undefined,
      session_id: typeof session_id === 'string' ? session_id : undefined,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Create a note in the notebook
app.post('/content/notes', async (req: Request, res: Response) => {
  try {
    const { title, content, notebook_url, session_id } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: title',
      });
    }

    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: content',
      });
    }

    const result = await toolHandlers.handleCreateNote({
      title,
      content,
      notebook_url,
      session_id,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// List notes in the notebook
app.post('/content/notes/list', async (req: Request, res: Response) => {
  try {
    const { notebook_url, session_id } = req.body;
    const result = await toolHandlers.handleListNotes({
      notebook_url,
      session_id,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get content of a specific note
app.post('/content/notes/get', async (req: Request, res: Response) => {
  try {
    const { note_title, note_id, notebook_url, session_id } = req.body;
    if (!note_title && !note_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: note_title or note_id',
      });
    }
    const result = await toolHandlers.handleGetNote({
      note_title,
      note_id,
      notebook_url,
      session_id,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Save chat/discussion to a note
app.post('/content/chat-to-note', async (req: Request, res: Response) => {
  try {
    const { title, notebook_url, session_id } = req.body;

    const result = await toolHandlers.handleSaveChatToNote({
      title,
      notebook_url,
      session_id,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Convert a note to a source
app.post('/content/notes/:noteTitle/to-source', async (req: Request, res: Response) => {
  try {
    const { noteTitle } = req.params;
    const { notebook_url, session_id } = req.body;

    if (!noteTitle) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: noteTitle',
      });
    }

    const result = await toolHandlers.handleConvertNoteToSource({
      note_title: decodeURIComponent(noteTitle),
      notebook_url,
      session_id,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Export a finished artifact to Google Docs or Sheets — RPC extension.
// Body: { notebook_id | notebook_url, target?: 'docs' | 'sheets', title? }
app.post('/content/:artifactId/export', async (req: Request, res: Response) => {
  try {
    const { notebook_id, notebook_url, target, title } = req.body || {};
    res.json(
      await toolHandlers.handleExportArtifact({
        notebook_id,
        notebook_url,
        artifact_id: req.params.artifactId,
        target,
        title,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Revise one slide of an existing deck — RPC extension.
// Body: { notebook_id | notebook_url, slide_index, prompt }
app.post('/content/:artifactId/revise-slide', async (req: Request, res: Response) => {
  try {
    const { notebook_id, notebook_url, slide_index, prompt } = req.body || {};
    if (typeof slide_index !== 'number' || typeof prompt !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'Missing required fields: slide_index, prompt' });
    }
    res.json(
      await toolHandlers.handleReviseSlide({
        notebook_id,
        notebook_url,
        artifact_id: req.params.artifactId,
        slide_index,
        prompt,
      })
    );
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Global error handler - catches any unhandled errors in async routes
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const reqId = req.requestId?.substring(0, 8) || 'unknown';
  log.error(`[${reqId}] Unhandled error: ${err.message}`);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    requestId: req.requestId,
  });
});

// Start server with startup sequence
const PORT = Number(process.env.HTTP_PORT) || 3000;
const VERSION = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
  ) as { version: string }
).version;

const startupManager = new StartupManager(authManager);

// ============================================================================
// Port management: detect and free ghost processes
// ============================================================================

/**
 * Check if a port is currently in use
 */
function checkPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true); // port is in use
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false); // port is free
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false); // port is free
    });
    socket.connect(port, host === '0.0.0.0' ? '127.0.0.1' : host);
  });
}

/**
 * Try to determine if the process on the port is a ghost (not responding to /health)
 */
async function isGhostProcess(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    // If it responds, it's a live server — not a ghost
    return !res.ok;
  } catch {
    // No response = ghost process
    return true;
  }
}

/**
 * Try to kill the process occupying a port
 */
function tryKillPort(port: number): boolean {
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      // On Windows, find PID and kill it
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lines = output.trim().split('\n');
      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
          log.info(`  Killed PID ${pid}`);
        } catch {
          // PID may already be dead
        }
      }
      return pids.size > 0;
    } else {
      // On Linux/WSL, use fuser
      execSync(`fuser -k ${port}/tcp`, { timeout: 5000 });
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Start the HTTP server with port conflict detection
 */
async function startServer(port: number, host: string): Promise<void> {
  const portBusy = await checkPort(port, host);

  if (portBusy) {
    log.warning(`Port ${port} is already in use, checking if it's a ghost process...`);

    const ghost = await isGhostProcess(port);
    if (ghost) {
      log.warning(`Ghost process detected on port ${port}, attempting to free it...`);
      const freed = tryKillPort(port);

      if (freed) {
        log.success(`Port ${port} freed successfully`);
        // Wait for OS to release the port
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Verify port is now free
        const stillBusy = await checkPort(port, host);
        if (stillBusy) {
          log.error(`Port ${port} is still in use after kill attempt.`);
          log.error(`  Manual fix:`);
          log.error(`    Linux/WSL: fuser -k ${port}/tcp`);
          log.error(`    Windows:   netstat -ano | findstr :${port}`);
          log.error(`               taskkill /F /PID <PID>`);
          process.exit(1);
        }
      } else {
        log.error(`Could not free port ${port}.`);
        log.error(`  Manual fix:`);
        log.error(`    Linux/WSL: fuser -k ${port}/tcp`);
        log.error(`    Windows PowerShell: wsl --shutdown (then retry)`);
        log.error(`    Windows:   netstat -ano | findstr :${port}`);
        log.error(`               taskkill /F /PID <PID>`);
        process.exit(1);
      }
    } else {
      // Port is busy but it's a live server responding to /health
      log.error(`Port ${port} is already used by a running NotebookLM server.`);
      log.error(`  Stop the other instance first, or use HTTP_PORT=<other_port>`);
      process.exit(1);
    }
  }

  // Start the server
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`Port ${port} became busy during startup (race condition).`);
        log.error(`  Retry or use HTTP_PORT=<other_port>`);
        process.exit(1);
      }
      reject(err);
    });

    server.once('listening', () => {
      resolve();
    });
  });
}

// Main startup
(async () => {
  // Fail before binding rather than after: a wide bind with no token is the
  // advisory itself, and a warning would scroll past while the server served.
  try {
    assertSafeBind(HOST, API_TOKEN);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  await startServer(PORT, HOST);

  log.success(`🌐 NotebookLM MCP HTTP Server v${VERSION}`);
  log.success(`   Listening on ${HOST}:${PORT}`);
  if (API_TOKEN) {
    log.success('   Token required on every route except /health');
  } else if (isLoopbackHost(HOST)) {
    log.info('   Local-only: this machine can reach the API, the network cannot.');
    log.info('   Set NOTEBOOKLM_API_KEY to require a token as well.');
  }

  // Run startup sequence (account connection, auth verification)
  const startupResult = await startupManager.startup();

  // Show quick links and endpoints after startup
  log.info('');
  log.info('📊 Quick Links:');
  log.info(`   Health check: http://localhost:${PORT}/health`);
  log.info(`   API endpoint: http://localhost:${PORT}/ask`);
  log.info('');
  log.info('📖 Available Endpoints:');
  log.info('   Authentication:');
  log.info('   POST   /setup-auth             First-time authentication');
  log.info('   POST   /de-auth                Logout (clear credentials)');
  log.info('   POST   /re-auth                Re-authenticate / switch account');
  log.info('   POST   /cleanup-data           Clean all data (requires confirm)');
  log.info('');
  log.info('   Queries:');
  log.info('   POST   /ask                    Ask a question to NotebookLM');
  log.info('   GET    /health                 Server health check');
  log.info('');
  log.info('   Notebooks:');
  log.info('   GET    /notebooks              List all notebooks');
  log.info('   POST   /notebooks              Add a new notebook');
  log.info('   POST   /notebooks/auto-discover Auto-discover notebook metadata');
  log.info('   GET    /notebooks/search       Search notebooks by query');
  log.info('   GET    /notebooks/stats        Get library statistics');
  log.info('   GET    /notebooks/scrape       Scrape real notebooks from NotebookLM');
  log.info('   GET    /notebooks/:id          Get notebook details');
  log.info('   PUT    /notebooks/:id          Update notebook metadata');
  log.info('   DELETE /notebooks/:id          Delete a notebook');
  log.info('   PUT    /notebooks/:id/activate Activate a notebook (set as default)');
  log.info('');
  log.info('   Sessions:');
  log.info('   GET    /sessions               List active sessions');
  log.info('   POST   /sessions/:id/reset     Reset session history');
  log.info('   DELETE /sessions/:id           Close a session');
  log.info('');
  log.info('   Content Management:');
  log.info('   POST   /content/sources        Add source to notebook');
  log.info('   DELETE /content/sources/:id    Delete source by ID');
  log.info('   DELETE /content/sources        Delete source by name (query param)');
  log.info('   POST   /content/generate       Generate content (audio, video, etc.)');
  log.info('   GET    /content/download       Download/export generated content');
  log.info('   POST   /content/notes          Create a note in the notebook');
  log.info('   POST   /content/chat-to-note   Save chat/discussion to a note');
  log.info('   POST   /content/notes/:title/to-source  Convert note to source');
  log.info('   GET    /content                List sources and content');
  log.info('');
  log.info('💡 Configuration:');
  log.info(
    `   Host: ${HOST} ${HOST === '0.0.0.0' ? '(accessible from network)' : '(localhost only)'}`
  );
  log.info(`   Port: ${PORT}`);

  // Show startup result summary
  log.info('');
  if (startupResult.authenticated) {
    log.success(
      `🔐 Status: Authenticated${startupResult.accountEmail ? ` as ${startupResult.accountEmail}` : ''}`
    );
  } else {
    log.warning(`🔐 Status: Not authenticated - ${startupResult.message}`);
  }
  log.info('');
  log.dim('📖 Documentation: ./deployment/docs/');
  log.dim('⏹️  Press Ctrl+C to stop');
})();

// Graceful shutdown with error handling
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down gracefully...');
  try {
    await toolHandlers.cleanup();
  } catch (error) {
    log.error(`Cleanup failed: ${error}`);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, shutting down gracefully...');
  try {
    await toolHandlers.cleanup();
  } catch (error) {
    log.error(`Cleanup failed: ${error}`);
  }
  process.exit(0);
});
