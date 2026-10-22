/**
 * Unit tests for the source-level calls added alongside the chat history:
 * rename, freshness, and the per-source guide (no network).
 *
 * The freshness reply changes shape with the source type, and the dangerous
 * answer is a confident "fresh" for a reply we did not recognise — a caller
 * that believes it skips the resync it needed. These lock the three known
 * shapes and the "did not say" fallback.
 */
import { SourcesRpc } from '../rpc/sources-rpc.js';
import { NotebookRpc } from '../rpc/notebooks-rpc.js';

function rpcReturning(result: unknown) {
  const calls: Array<{ method: string; params: unknown; path: string }> = [];
  const client = {
    call: async (method: string, params: unknown, path: string) => {
      calls.push({ method, params, path });
      return result;
    },
  };
  return {
    sources: new SourcesRpc(client as never),
    notebooks: new NotebookRpc(client as never),
    calls,
  };
}

const NB = '11111111-2222-3333-4444-555555555555';
const SRC = 'src-1';

describe('SourcesRpc.renameSource', () => {
  it('nests the id once and the title three times', async () => {
    const { sources, calls } = rpcReturning([]);
    await sources.renameSource(NB, SRC, 'Chapter 4');
    expect(calls[0].method).toBe('RENAME_SOURCE');
    expect(calls[0].params).toEqual([null, [SRC], [[['Chapter 4']]]]);
    expect(calls[0].path).toBe(`/notebook/${NB}`);
  });
});

describe('SourcesRpc.checkFreshness', () => {
  it('reads an empty reply as a current URL source', async () => {
    const { sources } = rpcReturning([]);
    await expect(sources.checkFreshness(NB, SRC)).resolves.toEqual({ id: SRC, stale: false });
  });

  it('reads the Drive row', async () => {
    const fresh = rpcReturning([[null, true, [SRC]]]);
    await expect(fresh.sources.checkFreshness(NB, SRC)).resolves.toEqual({ id: SRC, stale: false });

    const stale = rpcReturning([[null, false, [SRC]]]);
    await expect(stale.sources.checkFreshness(NB, SRC)).resolves.toEqual({ id: SRC, stale: true });
  });

  it('reads the legacy bare boolean', async () => {
    const { sources } = rpcReturning(false);
    await expect(sources.checkFreshness(NB, SRC)).resolves.toEqual({ id: SRC, stale: true });
  });

  it('says "not known" rather than "fresh" on an unrecognised reply', async () => {
    const { sources } = rpcReturning([['something', 'new']]);
    await expect(sources.checkFreshness(NB, SRC)).resolves.toEqual({ id: SRC, stale: null });
  });
});

describe('SourcesRpc.getSourceGuide', () => {
  it('reads the summary and the key topics from the nested record', async () => {
    const { sources, calls } = rpcReturning([
      [[null, ['A short summary.'], [['retrieval', 'citations']]]],
    ]);

    await expect(sources.getSourceGuide(NB, SRC)).resolves.toEqual({
      id: SRC,
      summary: 'A short summary.',
      keyTopics: ['retrieval', 'citations'],
    });
    expect(calls[0].params).toEqual([[[[SRC]]]]);
  });

  it('returns empty fields for a source NotebookLM has not summarised', async () => {
    const { sources } = rpcReturning([[[]]]);
    await expect(sources.getSourceGuide(NB, SRC)).resolves.toEqual({
      id: SRC,
      summary: '',
      keyTopics: [],
    });
  });

  it('drops non-string topics instead of passing them through', async () => {
    const { sources } = rpcReturning([[[null, ['S'], [['ok', 7, null, 'fine']]]]]);
    const guide = await sources.getSourceGuide(NB, SRC);
    expect(guide.keyTopics).toEqual(['ok', 'fine']);
  });
});

describe('NotebookRpc.getSummary', () => {
  it('reads the summary text and the suggested question/prompt pairs', async () => {
    const { notebooks, calls } = rpcReturning([
      [
        ['Six papers on retrieval.'],
        [
          [
            ['What do they agree on?', 'Summarise the points of agreement'],
            ['Where do they disagree?', 'List the disagreements'],
          ],
        ],
      ],
    ]);

    await expect(notebooks.getSummary(NB)).resolves.toEqual({
      summary: 'Six papers on retrieval.',
      suggestedTopics: [
        { question: 'What do they agree on?', prompt: 'Summarise the points of agreement' },
        { question: 'Where do they disagree?', prompt: 'List the disagreements' },
      ],
    });
    expect(calls[0].params).toEqual([NB, [2]]);
  });

  it('falls back to the question when no prompt is carried', async () => {
    const { notebooks } = rpcReturning([[['S'], [[['Just a question']]]]]);
    const summary = await notebooks.getSummary(NB);
    expect(summary.suggestedTopics).toEqual([
      { question: 'Just a question', prompt: 'Just a question' },
    ]);
  });

  it('returns empty fields for a notebook with no summary yet', async () => {
    const { notebooks } = rpcReturning([null]);
    await expect(notebooks.getSummary(NB)).resolves.toEqual({ summary: '', suggestedTopics: [] });
  });
});
