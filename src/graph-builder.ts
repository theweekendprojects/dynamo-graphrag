/**
 * GraphBuilder — orchestrates extraction and storage of knowledge graph data.
 *
 * This is the high-level ingestion API. You give it text segments and a pluggable
 * extractor function, and it handles:
 *   1. Calling your extractor to get entities + relationships
 *   2. Validating and filtering noise (too short, too long, dangling relationships)
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
  minNameLength?: number;
  /**
   * Maximum entity name length to accept.
   * @default 100
   */
  maxNameLength?: number;
  /**
   * Maximum entities per segment.
   * @default 15
   */
  maxEntities?: number;
  /**
   * Maximum relationships per segment.
   * @default 20
   */
  maxRelationships?: number;
}

/** Input for processing a single segment. */
export interface SegmentInput {
  /** Text content of the segment */
  text: string;
  /** Namespace (e.g. tenant ID, project ID) */
  namespace: string;
  /** Document identifier */
  docId: string;
  /** Human-readable document name */
  docName: string;
  /** Page/section number */
  page: number;
}

/** Result of processing a single segment. */
export interface SegmentResult {
  /** Number of entity nodes written */
  nodes: number;
  /** Number of relationship edges written */
  edges: number;
  /** Number of entities the extractor found (before filtering) */
  rawEntities: number;
  /** Number of relationships the extractor found (before filtering) */
  rawRelationships: number;
}

export class GraphBuilder {
  private readonly store: GraphStore;
  private readonly extractor: ExtractorFn;
  private readonly minNameLength: number;
  private readonly maxNameLength: number;
  private readonly maxEntities: number;
  private readonly maxRelationships: number;

  constructor(options: GraphBuilderOptions) {
    this.store = options.store;
    this.extractor = options.extractor;
    this.minNameLength = options.minNameLength ?? 2;
    this.maxNameLength = options.maxNameLength ?? 100;
    this.maxEntities = options.maxEntities ?? 15;
    this.maxRelationships = options.maxRelationships ?? 20;
  }

  /**
   * Processes a single text segment: extracts entities/relationships and writes to the graph.
   *
   * Safe to call concurrently for different segments — DynamoDB handles writes atomically.
   * For sequential processing (rate-limit friendly), process segments one at a time.
   */
  async processSegment(input: SegmentInput): Promise<SegmentResult> {
    // 1. Extract
    let raw: ExtractionResult;
    try {
      raw = await this.extractor(input.text);
    } catch (err) {
      console.warn(`[GraphBuilder] Extraction failed for doc="${input.docName}" page=${input.page}: ${err}`);
      return { nodes: 0, edges: 0, rawEntities: 0, rawRelationships: 0 };
    }

    // 2. Validate and filter
    const clean = this.clean(raw);

    if (clean.entities.length === 0) {
      return { nodes: 0, edges: 0, rawEntities: raw.entities.length, rawRelationships: raw.relationships.length };
    }

    // 3. Write to store
    const stats = await this.store.writeGraph(
      input.namespace,
      clean,
      input.docId,
      input.docName,
      input.page,
      input.text.slice(0, 200),
    );

    return {
      nodes: stats.nodes,
      edges: stats.edges,
      rawEntities: raw.entities.length,
      rawRelationships: raw.relationships.length,
    };
  }

  /**
   * Processes multiple segments sequentially.
   * Good for rate-limited LLM APIs — processes one at a time to avoid throttling.
   *
   * @param segments - Array of segment inputs
   * @param onProgress - Optional callback after each segment
   */
  async processSegments(
    segments: SegmentInput[],
    onProgress?: (index: number, total: number, result: SegmentResult) => void,
  ): Promise<{ totalNodes: number; totalEdges: number; processed: number }> {
    let totalNodes = 0;
    let totalEdges = 0;

    for (let i = 0; i < segments.length; i++) {
      const result = await this.processSegment(segments[i]);
      totalNodes += result.nodes;
      totalEdges += result.edges;
      onProgress?.(i, segments.length, result);
    }

    return { totalNodes, totalEdges, processed: segments.length };
  }

  // ===== Private: validation & filtering =====

  private clean(raw: ExtractionResult): ExtractionResult {
    // Filter entities
    const entities: Entity[] = raw.entities
      .filter(e => e.name && e.type)
      .filter(e => e.name.length >= this.minNameLength && e.name.length <= this.maxNameLength)
      .slice(0, this.maxEntities)
      .map(e => ({
        name: e.name.trim(),
        type: e.type,
        description: e.description?.slice(0, 200),
      }));

    // Build set of known entity names for relationship validation
    const known = new Set(entities.map(e => e.name.toLowerCase()));

    // Filter relationships — at least one endpoint must be a known entity
    const relationships: Relationship[] = raw.relationships
      .filter(r => r.source && r.relation && r.target)
      .filter(r => known.has(r.source.toLowerCase()) || known.has(r.target.toLowerCase()))
      .slice(0, this.maxRelationships)
      .map(r => ({
        source: r.source.trim(),
        relation: r.relation.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 50),
        target: r.target.trim(),
        description: r.description?.slice(0, 200),
      }));

    return { entities, relationships };
  }
}
