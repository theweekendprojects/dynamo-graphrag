/**
 * GraphBuilder — orchestrates extraction and storage of knowledge graph data.
 *
 * This is the high-level ingestion API. You give it text chunks and a pluggable
 * extractor function, and it handles:
 *   1. Calling your extractor to get entities + relationships
 *   2. Validating and filtering garbage (too short, too long, no relationships)
 *   3. Writing to the GraphStore
 *
 * The extractor is yours to implement — call any LLM you want.
 */

import type { ExtractorFn, ExtractionResult, Entity, Relationship } from './types.js';
import { GraphStore } from './graph-store.js';

/** Options for the GraphBuilder. */
export interface GraphBuilderOptions {
  /** The GraphStore instance (DynamoDB-backed). */
  store: GraphStore;
  /** Your entity/relationship extraction function. */
  extractor: ExtractorFn;
  /**
   * Minimum entity name length to accept.
   * @default 2
   */
  minEntityLength?: number;
  /**
   * Maximum entity name length to accept.
   * @default 100
   */
  maxEntityLength?: number;
  /**
   * Maximum entities per chunk.
   * @default 15
   */
  maxEntitiesPerChunk?: number;
  /**
   * Maximum relationships per chunk.
   * @default 20
   */
  maxRelationshipsPerChunk?: number;
}

/** Input for processing a single chunk. */
export interface ChunkInput {
  /** Text content of the chunk */
  text: string;
  /** Namespace (e.g. tenant ID, project ID) */
  namespace: string;
  /** Document identifier */
  documentId: string;
  /** Human-readable document name */
  documentName: string;
  /** Page/section number */
  pageNumber: number;
}

/** Result of processing a single chunk. */
export interface ProcessResult {
  /** Number of entity nodes written */
  nodesWritten: number;
  /** Number of relationship edges written */
  edgesWritten: number;
  /** Number of entities the extractor found (before filtering) */
  rawEntities: number;
  /** Number of relationships the extractor found (before filtering) */
  rawRelationships: number;
}

export class GraphBuilder {
  private readonly store: GraphStore;
  private readonly extractor: ExtractorFn;
  private readonly minEntityLength: number;
  private readonly maxEntityLength: number;
  private readonly maxEntitiesPerChunk: number;
  private readonly maxRelationshipsPerChunk: number;

  constructor(options: GraphBuilderOptions) {
    this.store = options.store;
    this.extractor = options.extractor;
    this.minEntityLength = options.minEntityLength ?? 2;
    this.maxEntityLength = options.maxEntityLength ?? 100;
    this.maxEntitiesPerChunk = options.maxEntitiesPerChunk ?? 15;
    this.maxRelationshipsPerChunk = options.maxRelationshipsPerChunk ?? 20;
  }

  /**
   * Processes a single text chunk: extracts entities/relationships and writes to the graph.
   *
   * Safe to call concurrently for different chunks — DynamoDB handles writes atomically.
   * For sequential processing (rate-limit friendly), process chunks one at a time.
   */
  async processChunk(input: ChunkInput): Promise<ProcessResult> {
    // 1. Extract
    let raw: ExtractionResult;
    try {
      raw = await this.extractor(input.text);
    } catch (err) {
      console.warn(`[GraphBuilder] Extraction failed for doc="${input.documentName}" page=${input.pageNumber}: ${err}`);
      return { nodesWritten: 0, edgesWritten: 0, rawEntities: 0, rawRelationships: 0 };
    }

    // 2. Validate and filter
    const filtered = this.filter(raw);

    if (filtered.entities.length === 0) {
      return { nodesWritten: 0, edgesWritten: 0, rawEntities: raw.entities.length, rawRelationships: raw.relationships.length };
    }

    // 3. Write to store
    const writeResult = await this.store.writeExtractionResult(
      input.namespace,
      filtered,
      input.documentId,
      input.documentName,
      input.pageNumber,
      input.text.slice(0, 200),
    );

    return {
      ...writeResult,
      rawEntities: raw.entities.length,
      rawRelationships: raw.relationships.length,
    };
  }

  /**
   * Processes multiple chunks sequentially.
   * Good for rate-limited LLM APIs — processes one at a time to avoid throttling.
   *
   * @param chunks - Array of chunk inputs
   * @param onProgress - Optional callback after each chunk
   */
  async processChunks(
    chunks: ChunkInput[],
    onProgress?: (index: number, total: number, result: ProcessResult) => void,
  ): Promise<{ totalNodes: number; totalEdges: number; chunksProcessed: number }> {
    let totalNodes = 0;
    let totalEdges = 0;

    for (let i = 0; i < chunks.length; i++) {
      const result = await this.processChunk(chunks[i]);
      totalNodes += result.nodesWritten;
      totalEdges += result.edgesWritten;
      onProgress?.(i, chunks.length, result);
    }

    return { totalNodes, totalEdges, chunksProcessed: chunks.length };
  }

  // ===== Private: validation & filtering =====

  private filter(raw: ExtractionResult): ExtractionResult {
    // Filter entities
    const entities: Entity[] = raw.entities
      .filter(e => e.name && e.type)
      .filter(e => e.name.length >= this.minEntityLength && e.name.length <= this.maxEntityLength)
      .slice(0, this.maxEntitiesPerChunk)
      .map(e => ({
        name: e.name.trim(),
        type: e.type,
        description: e.description?.slice(0, 200),
      }));

    // Build set of known entity names for relationship validation
    const entityNames = new Set(entities.map(e => e.name.toLowerCase()));

    // Filter relationships — at least one endpoint must be a known entity
    const relationships: Relationship[] = raw.relationships
      .filter(r => r.source && r.relation && r.target)
      .filter(r => entityNames.has(r.source.toLowerCase()) || entityNames.has(r.target.toLowerCase()))
      .slice(0, this.maxRelationshipsPerChunk)
      .map(r => ({
        source: r.source.trim(),
        relation: r.relation.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 50),
        target: r.target.trim(),
        description: r.description?.slice(0, 200),
      }));

    return { entities, relationships };
  }
}
