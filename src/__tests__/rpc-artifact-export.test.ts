/**
 * Unit tests for exporting an artifact to Drive and revising one slide
 * (no network).
 *
 * Nobody documents where the created document's link sits in the export
 * reply, so we search the envelope for it. These lock that search — including
 * the case that matters most: a reply with no link reports `null` instead of
 * handing back a plausible-looking URL.
 */
import { StudioRpc } from '../rpc/studio-rpc.js';

function rpcReturning(result: unknown) {
  const calls: Array<{ method: string; params: unknown; path: string }> = [];
  const client = {
    call: async (method: string, params: unknown, path: string) => {
      calls.push({ method, params, path });
      return result;
    },
  };
  return { studio: new StudioRpc(client as never), calls };
}

const NB = '11111111-2222-3333-4444-555555555555';
const ART = 'artifact-1';
const DOC = 'https://docs.google.com/document/d/abc123/edit';

describe('StudioRpc.exportArtifact', () => {
  it('sends the Docs type code and finds the created document', async () => {
    const { studio, calls } = rpcReturning([null, [[null, DOC]]]);

    await expect(studio.exportArtifact(NB, ART, 'docs', 'My report')).resolves.toEqual({
      artifactId: ART,
      target: 'docs',
      documentUrl: DOC,
    });
    expect(calls[0].method).toBe('EXPORT_ARTIFACT');
    expect(calls[0].params).toEqual([null, ART, null, 'My report', 1]);
    expect(calls[0].path).toBe(`/notebook/${NB}`);
  });

  it('sends the Sheets type code', async () => {
    const { studio, calls } = rpcReturning([]);
    await studio.exportArtifact(NB, ART, 'sheets', 'Table');
    expect((calls[0].params as unknown[])[4]).toBe(2);
  });

  it('reports no link rather than inventing one', async () => {
    const { studio } = rpcReturning([null, [['not a url']]]);
    const result = await studio.exportArtifact(NB, ART, 'docs', 'T');
    expect(result.documentUrl).toBeNull();
  });

  it('ignores a non-Drive URL in the envelope', async () => {
    const { studio } = rpcReturning([['https://example.com/doc']]);
    const result = await studio.exportArtifact(NB, ART, 'docs', 'T');
    expect(result.documentUrl).toBeNull();
  });
});

describe('StudioRpc.reviseSlide', () => {
  it('sends the zero-based index with the prompt and reads back the status', async () => {
    const { studio, calls } = rpcReturning([[ART, 'Deck', 8, null, 1]]);

    await expect(studio.reviseSlide(NB, ART, 0, 'Make it shorter')).resolves.toEqual({
      artifactId: ART,
      status: 'in_progress',
    });
    expect(calls[0].method).toBe('REVISE_SLIDE_DECK');
    expect(calls[0].params).toEqual([[2], ART, [[[0, 'Make it shorter']]]]);
  });

  it('refuses a negative or fractional slide number before calling', async () => {
    const { studio, calls } = rpcReturning([]);
    await expect(studio.reviseSlide(NB, ART, -1, 'x')).rejects.toThrow('non-negative integer');
    await expect(studio.reviseSlide(NB, ART, 1.5, 'x')).rejects.toThrow('non-negative integer');
    expect(calls).toHaveLength(0);
  });
});
