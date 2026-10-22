/**
 * Notebook CRUD over the internal `batchexecute` RPC API.
 *
 * Replaces the browser-DOM implementations of list / create / delete. Payload
 * shapes and result offsets verified live against NotebookLM (2026-07-30).
 */

import { BatchExecuteClient } from './batchexecute.js';
import { NOTEBOOK_PRIMARY_HOST } from '../utils/notebook-domain.js';

export interface RpcNotebook {
  id: string;
  name: string;
  url: string;
}

function notebookUrl(id: string): string {
  return `https://${NOTEBOOK_PRIMARY_HOST}/notebook/${id}`;
}

/** A question NotebookLM suggests asking, with the prompt it would send. */
export interface SuggestedTopic {
  question: string;
  prompt: string;
}

/** A notebook's own summary of its sources, plus the questions it suggests. */
export interface NotebookSummary {
  summary: string;
  suggestedTopics: SuggestedTopic[];
}

export class NotebookRpc {
  constructor(private readonly client: BatchExecuteClient) {}

  /**
   * List all owned notebooks. Returns them regardless of the homepage's
   * view/filter state (the DOM scrape misses filtered notebooks).
   * Result shape: `result[0]` = rows; row[0]=title, row[2]=uuid.
   */
  async listNotebooks(): Promise<RpcNotebook[]> {
    const result = (await this.client.call('LIST_NOTEBOOKS', [null, 1, null, [2]])) as unknown;
    const rows = Array.isArray((result as unknown[])?.[0])
      ? ((result as unknown[])[0] as unknown[])
      : Array.isArray(result)
        ? (result as unknown[])
        : [];
    const out: RpcNotebook[] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const id = typeof row[2] === 'string' ? row[2] : undefined;
      if (!id) continue;
      const name = typeof row[0] === 'string' ? row[0] : '';
      out.push({ id, name, url: notebookUrl(id) });
    }
    return out;
  }

  /**
   * Create a notebook. Unlike the browser flow, the RPC sets the title at
   * creation (no separate rename). Result: `result[2]` = new uuid.
   */
  async createNotebook(title: string): Promise<RpcNotebook> {
    const params = [
      title || '',
      null,
      null,
      [2],
      [1, null, null, null, null, null, null, null, null, null, [1]],
    ];
    const result = (await this.client.call('CREATE_NOTEBOOK', params)) as unknown[];
    const id = Array.isArray(result) && typeof result[2] === 'string' ? result[2] : undefined;
    if (!id) {
      throw new Error('CREATE_NOTEBOOK returned no notebook id');
    }
    return { id, name: title || 'Untitled notebook', url: notebookUrl(id) };
  }

  /**
   * Get a notebook's sources (id + title). get_notebook result: `data[0][1]` =
   * sources; each source `[[id], title, …]`.
   */
  async getSources(notebookId: string): Promise<Array<{ id: string; title: string }>> {
    const result = (await this.client.call(
      'GET_NOTEBOOK',
      [notebookId, null, [2], null, 0],
      `/notebook/${notebookId}`
    )) as unknown;
    const info = Array.isArray((result as unknown[])?.[0])
      ? ((result as unknown[])[0] as unknown[])
      : undefined;
    const sources = info && Array.isArray(info[1]) ? (info[1] as unknown[]) : [];
    const out: Array<{ id: string; title: string }> = [];
    for (const s of sources) {
      if (!Array.isArray(s)) continue;
      const wrapper = s[0];
      const id = Array.isArray(wrapper) ? (wrapper[0] as string) : undefined;
      if (typeof id !== 'string') continue;
      out.push({ id, title: typeof s[1] === 'string' ? s[1] : '' });
    }
    return out;
  }

  /** Source ids of a notebook (needed to scope a query). */
  async getSourceIds(notebookId: string): Promise<string[]> {
    return (await this.getSources(notebookId)).map((s) => s.id);
  }

  /**
   * The notebook's own summary of its sources and the questions it suggests —
   * what the NotebookLM home card shows, which nothing here exposed before.
   *
   * Envelope positions read from teng-lin/notebooklm-py (MIT,
   * `_web/notebooks.py::get_summary`): the record sits at `result[0]`, the
   * summary text at `[0][0]`, the suggested question/prompt pairs at `[1][0]`.
   */
  async getSummary(notebookId: string): Promise<NotebookSummary> {
    const result = (await this.client.call(
      'GET_SUMMARY',
      [notebookId, [2]],
      `/notebook/${notebookId}`
    )) as unknown;

    const record = Array.isArray(result) ? result[0] : undefined;
    if (!Array.isArray(record)) return { summary: '', suggestedTopics: [] };

    const summaryBlock = record[0];
    const summary =
      Array.isArray(summaryBlock) && typeof summaryBlock[0] === 'string' ? summaryBlock[0] : '';

    const topicBlock = record[1];
    const rows = Array.isArray(topicBlock) && Array.isArray(topicBlock[0]) ? topicBlock[0] : [];
    const suggestedTopics: SuggestedTopic[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
      suggestedTopics.push({
        question: row[0],
        prompt: typeof row[1] === 'string' ? row[1] : row[0],
      });
    }
    return { summary, suggestedTopics };
  }

  /** Delete a single notebook by id. */
  async deleteNotebook(id: string): Promise<void> {
    await this.client.call('DELETE_NOTEBOOK', [[id], [2]]);
  }

  /** Rename a notebook. */
  async renameNotebook(id: string, newTitle: string): Promise<void> {
    await this.client.call(
      'RENAME_NOTEBOOK',
      [id, [[null, null, null, [null, newTitle]]]],
      `/notebook/${id}`
    );
  }
}
