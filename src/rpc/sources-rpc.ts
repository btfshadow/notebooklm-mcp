/**
 * Source management over the internal `batchexecute` RPC API.
 *
 * Add (URL / YouTube / text) and delete sources. The add RPC returns the new
 * source id directly, so there is no post-upload polling / false-negative like
 * the DOM flow. Payloads verified against NotebookLM (2026-07).
 */

import { BatchExecuteClient, RpcError } from './batchexecute.js';

export interface RpcSource {
  id: string;
  title: string;
}

/** A source's full indexed content, as returned by {@link SourcesRpc.getSourceFulltext}. */
export interface SourceFulltext {
  id: string;
  title: string;
  content: string;
  charCount: number;
}

/** Whether a URL / Drive source has drifted from what it points at. */
export interface SourceFreshness {
  id: string;
  /** `true` = needs a resync, `false` = current, `null` = the server did not say. */
  stale: boolean | null;
}

/** NotebookLM's own summary of a single source. */
export interface SourceGuide {
  id: string;
  summary: string;
  keyTopics: string[];
}

/**
 * Flatten a document tree to its text leaves, in traversal order.
 *
 * Whitespace-only leaves are dropped: the tree carries a fair number of them
 * and, once the leaves are newline-joined, each one would show up as a blank
 * line. Leaves that do carry text are kept verbatim, spacing included — this
 * is a source's exact indexed content, so it is not ours to tidy up.
 * Depth is bounded so a malformed (or cyclic-looking) payload cannot hang.
 */
function collectStrings(node: unknown, depth = 0): string[] {
  if (typeof node === 'string') return node.trim() ? [node] : [];
  if (!Array.isArray(node) || depth > 100) return [];
  const out: string[] = [];
  for (const child of node) out.push(...collectStrings(child, depth + 1));
  return out;
}

/** Parse the source-creation result: `result[0][0]` → `[0][0]`=id, `[1]`=title. */
function parseSourceResult(result: unknown): RpcSource | null {
  const list = Array.isArray(result) ? (result[0] as unknown) : undefined;
  const first = Array.isArray(list) ? (list[0] as unknown) : undefined;
  if (!Array.isArray(first)) return null;
  const idHolder = first[0];
  const id = Array.isArray(idHolder) ? (idHolder[0] as string) : undefined;
  if (typeof id !== 'string') return null;
  const title = typeof first[1] === 'string' ? first[1] : 'Untitled';
  return { id, title };
}

const CREATE_TAIL = [1, null, null, null, null, null, null, null, null, null, [1]];

export class SourcesRpc {
  /** Cached URL-add rollout version ('v1' | 'v2') once discovered. */
  private urlVersion: 'v1' | 'v2' | null = null;

  constructor(private readonly client: BatchExecuteClient) {}

  /** Add a URL (or YouTube) source. Tries the legacy izAoDd RPC, falls back to the new ozz5Z rollout. */
  async addUrlSource(notebookId: string, url: string): Promise<RpcSource | null> {
    const path = `/notebook/${notebookId}`;
    const runV1 = () => this.client.call('ADD_SOURCE', this.urlParamsV1(notebookId, url), path);
    const runV2 = () => this.client.call('ADD_SOURCE_URL_V2', this.urlParamsV2(url), path);

    let result: unknown;
    if (this.urlVersion === 'v2') {
      result = await runV2();
    } else if (this.urlVersion === 'v1') {
      result = await runV1();
    } else {
      // First call: try v1, fall back to v2 on failure; cache the winner.
      try {
        result = await runV1();
        this.urlVersion = 'v1';
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        result = await runV2();
        this.urlVersion = 'v2';
      }
    }
    return parseSourceResult(result);
  }

  /** Add a pasted-text source. */
  async addTextSource(notebookId: string, title: string, text: string): Promise<RpcSource | null> {
    const sourceData = [
      null,
      [title || 'Pasted Text', text],
      null,
      2,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
    ];
    const params = [[sourceData], notebookId, [2], CREATE_TAIL];
    const result = await this.client.call('ADD_SOURCE', params, `/notebook/${notebookId}`);
    return parseSourceResult(result);
  }

  /**
   * Read a source's indexed content — the text NotebookLM actually reasons
   * over, which the web UI never lets you see in full.
   *
   * Called with the bare id, `GET_SOURCE` answers with metadata only; the two
   * trailing render selectors are what request the content itself — `[2]` for
   * the plain-text rendition, `[3]` for the HTML one. The envelope is
   * `[descriptor, ?, ?, textBlock, htmlBlock]`: the title sits at
   * `descriptor[1]`, the HTML is the plain string `result[4][1]`, and the text
   * lives under `result[3][0]` as a structured document tree, so its strings
   * are collected in traversal order and newline-joined (offsets are lost —
   * that is inherent to flattening, not a shortcut).
   *
   * The selectors and envelope positions were read from teng-lin/notebooklm-py
   * (MIT), which documents this endpoint; the code here is our own.
   */
  async getSourceFulltext(
    notebookId: string,
    sourceId: string,
    format: 'text' | 'html' = 'text'
  ): Promise<SourceFulltext | null> {
    const selector = format === 'html' ? 3 : 2;
    const result = await this.client.call(
      'GET_SOURCE',
      [[sourceId], [selector], [selector]],
      `/notebook/${notebookId}`
    );
    if (!Array.isArray(result)) return null;

    const descriptor = Array.isArray(result[0]) ? (result[0] as unknown[]) : undefined;
    const title = typeof descriptor?.[1] === 'string' ? (descriptor[1] as string) : '';

    let content = '';
    if (format === 'html') {
      const block = Array.isArray(result[4]) ? (result[4] as unknown[]) : undefined;
      content = typeof block?.[1] === 'string' ? (block[1] as string) : '';
    } else {
      const doc = Array.isArray(result[3]) ? (result[3] as unknown[]) : undefined;
      const body = Array.isArray(doc?.[0]) ? (doc[0] as unknown[]) : undefined;
      content = body ? collectStrings(body).join('\n') : '';
    }
    if (!content) return null;
    return { id: sourceId, title, content, charCount: content.length };
  }

  /**
   * Rename a source.
   *
   * Payload shape read from teng-lin/notebooklm-py (MIT,
   * `_web/sources/__init__.py::rename`): nothing at 0, the id single-nested at
   * 1, the new title triple-nested at 2. Our implementation is our own.
   */
  async renameSource(notebookId: string, sourceId: string, newTitle: string): Promise<void> {
    await this.client.call(
      'RENAME_SOURCE',
      [null, [sourceId], [[[newTitle]]]],
      `/notebook/${notebookId}`
    );
  }

  /**
   * Is a URL / Drive source still in step with what it points at?
   *
   * The reply shape depends on the source type (same MIT reference,
   * `check_freshness`): an empty array for a URL source that is current, a
   * `[[null, boolean, [id]]]` row for a Drive source, and a bare boolean on
   * older accounts. Anything else leaves `stale` at `null` — we report "not
   * known" rather than guessing fresh, because a wrong "fresh" is the answer
   * that makes a caller skip the resync it needed.
   */
  async checkFreshness(notebookId: string, sourceId: string): Promise<SourceFreshness> {
    const result = (await this.client.call(
      'CHECK_SOURCE_FRESHNESS',
      [null, [sourceId], [2]],
      `/notebook/${notebookId}`
    )) as unknown;

    if (Array.isArray(result) && result.length === 0) return { id: sourceId, stale: false };
    if (typeof result === 'boolean') return { id: sourceId, stale: !result };
    const row = Array.isArray(result) ? result[0] : undefined;
    if (Array.isArray(row) && typeof row[1] === 'boolean') {
      return { id: sourceId, stale: !row[1] };
    }
    return { id: sourceId, stale: null };
  }

  /**
   * The per-source guide: NotebookLM's own summary of one source plus the key
   * topics it pulled out. Positions from the same MIT reference
   * (`_web/rows/sources.py::SourceGuideRow`): the record is at `result[0][0]`,
   * the summary at `[1][0]`, the topics at `[2][0]`. A source NotebookLM has
   * not summarised yet legitimately answers with neither.
   */
  async getSourceGuide(notebookId: string, sourceId: string): Promise<SourceGuide> {
    const result = (await this.client.call(
      'GET_SOURCE_GUIDE',
      [[[[sourceId]]]],
      `/notebook/${notebookId}`
    )) as unknown;

    const outer = Array.isArray(result) ? result[0] : undefined;
    const inner = Array.isArray(outer) ? outer[0] : undefined;
    if (!Array.isArray(inner)) return { id: sourceId, summary: '', keyTopics: [] };

    const summaryBlock = inner[1];
    const summary =
      Array.isArray(summaryBlock) && typeof summaryBlock[0] === 'string' ? summaryBlock[0] : '';

    const topicBlock = inner[2];
    const rawTopics =
      Array.isArray(topicBlock) && Array.isArray(topicBlock[0]) ? topicBlock[0] : [];
    const keyTopics = rawTopics.filter((t): t is string => typeof t === 'string');

    return { id: sourceId, summary, keyTopics };
  }

  /** Delete a source from a notebook. */
  async deleteSource(notebookId: string, sourceId: string): Promise<void> {
    await this.client.call('DELETE_SOURCE', [[[sourceId]], [2]], `/notebook/${notebookId}`);
  }

  private urlParamsV1(notebookId: string, url: string): unknown {
    const isYoutube = /youtube\.com|youtu\.be/i.test(url);
    const sourceData = isYoutube
      ? [null, null, null, null, null, null, null, [url], null, null, 1]
      : [null, null, [url], null, null, null, null, null, null, null, 1];
    return [[sourceData], notebookId, [2], CREATE_TAIL];
  }

  private urlParamsV2(url: string): unknown {
    const sourceData = [
      [null, url, 627],
      [null, null, null, null, null, null, null, null, null, [null, null, 1]],
      1,
    ];
    return [[sourceData]];
  }
}
