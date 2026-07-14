import { describe, it, expect, vi } from 'vitest';
import { GraphBuilder } from './graph-builder.js';
import type { ExtractorFn } from './types.js';
import type { GraphStore } from './graph-store.js';

// Mock GraphStore
function mockStore(): GraphStore {
  return {
    writeGraph: vi.fn().mockResolvedValue({ nodes: 2, edges: 1 }),
    getEntity: vi.fn(),
    walk: vi.fn(),
    deleteByDocument: vi.fn(),
    deleteByNamespace: vi.fn(),
  } as unknown as GraphStore;
}

describe('GraphBuilder', () => {
  it('extracts and writes to store', async () => {
    const store = mockStore();
    const extractor: ExtractorFn = async () => ({
      entities: [
        { name: 'AuthService', type: 'service', description: 'Handles authentication' },
        { name: 'JWT', type: 'protocol', description: 'JSON Web Token' },
      ],
      relationships: [
        { source: 'AuthService', relation: 'uses', target: 'JWT', description: 'Auth uses JWT for tokens' },
      ],
    });

    const builder = new GraphBuilder({ store, extractor });
    const result = await builder.processSegment({
      text: 'AuthService uses JWT for token-based authentication.',
      namespace: 'project-1',
      docId: 'doc-123',
      docName: 'architecture.md',
      page: 1,
    });

    expect(result.nodes).toBe(2);
    expect(result.edges).toBe(1);
    expect(result.rawEntities).toBe(2);
    expect(result.rawRelationships).toBe(1);
    expect(store.writeGraph).toHaveBeenCalledOnce();
  });

  it('filters entities with names too short or too long', async () => {
    const store = mockStore();
    const extractor: ExtractorFn = async () => ({
      entities: [
        { name: 'A', type: 'x' },                  // too short (< 2)
        { name: 'OK', type: 'valid' },              // exactly 2, OK
        { name: 'x'.repeat(101), type: 'long' },    // too long (> 100)
      ],
      relationships: [],
    });

    const builder = new GraphBuilder({ store, extractor });
    await builder.processSegment({
      text: 'test', namespace: 'ns', docId: 'doc', docName: 'test.md', page: 1,
    });

    // Only "OK" passes the filter
    const call = (store.writeGraph as any).mock.calls[0];
    expect(call[1].entities).toHaveLength(1);
    expect(call[1].entities[0].name).toBe('OK');
  });

  it('filters relationships where neither endpoint is a known entity', async () => {
    const store = mockStore();
    const extractor: ExtractorFn = async () => ({
      entities: [
        { name: 'ServiceA', type: 'service' },
      ],
      relationships: [
        { source: 'ServiceA', relation: 'calls', target: 'ServiceB' },  // ServiceA is known → keep
        { source: 'Unknown1', relation: 'x', target: 'Unknown2' },      // neither known → drop
      ],
    });

    const builder = new GraphBuilder({ store, extractor });
    await builder.processSegment({
      text: 'test', namespace: 'ns', docId: 'doc', docName: 'test.md', page: 1,
    });

    const call = (store.writeGraph as any).mock.calls[0];
    expect(call[1].relationships).toHaveLength(1);
    expect(call[1].relationships[0].target).toBe('ServiceB');
  });

  it('handles extractor errors gracefully', async () => {
    const store = mockStore();
    const extractor: ExtractorFn = async () => { throw new Error('LLM timeout'); };

    const builder = new GraphBuilder({ store, extractor });
    const result = await builder.processSegment({
      text: 'test', namespace: 'ns', docId: 'doc', docName: 'test.md', page: 1,
    });

    expect(result.nodes).toBe(0);
    expect(result.edges).toBe(0);
    expect(store.writeGraph).not.toHaveBeenCalled();
  });

  it('processSegments runs sequentially and reports progress', async () => {
    const store = mockStore();
    const calls: number[] = [];
    const extractor: ExtractorFn = async () => {
      calls.push(Date.now());
      return { entities: [{ name: 'Test', type: 'entity' }], relationships: [] };
    };

    const builder = new GraphBuilder({ store, extractor });
    const progress: number[] = [];

    await builder.processSegments(
      [
        { text: 'a', namespace: 'ns', docId: 'd1', docName: 'a.md', page: 1 },
        { text: 'b', namespace: 'ns', docId: 'd1', docName: 'a.md', page: 2 },
        { text: 'c', namespace: 'ns', docId: 'd1', docName: 'a.md', page: 3 },
      ],
      (index) => { progress.push(index); },
    );

    expect(progress).toEqual([0, 1, 2]);
    expect(calls).toHaveLength(3);
  });
});
