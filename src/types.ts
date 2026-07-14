/**
 * Core types for the GraphRAG library.
 */

/** An entity extracted from text. */
export interface Entity {
  /** Short name (1-5 words, exact notation from source text) */
  name: string;
  /** Category of the entity */
  type: string;
  /** One-sentence description */
  description?: string;
}

/** A relationship between two entities. */
export interface Relationship {
  /** Source entity name */
  source: string;
  /** Verb phrase describing the relationship (e.g. "requires", "triggers", "uses") */
  relation: string;
  /** Target entity name */
  target: string;
  /** One-sentence description of the relationship */
  description?: string;
}

/** Result of entity/relationship extraction from a text segment. */
export interface ExtractionResult {
  entities: Entity[];
  relationships: Relationship[];
}

/**
 * Pluggable extractor function.
 *
 * You provide this — call any LLM (OpenAI, Anthropic, Bedrock, Ollama, etc.)
 * and return structured entities + relationships.
 *
 * @param text - The text segment to extract from (typically 500-2000 tokens)
 * @returns Extracted entities and relationships
 */
export type ExtractorFn = (text: string) => Promise<ExtractionResult>;

/** A stored entity node in the graph. */
export interface GraphNode {
  /** Slugified entity name (key-safe) */
  id: string;
  /** Original entity name */
  name: string;
  /** Entity category/type */
  type: string;
  /** Description */
  description: string;
  /** Document IDs this entity was extracted from */
  docIds: string[];
  /** Last update timestamp */
  updatedAt: string;
}

/** A stored relationship edge in the graph. */
export interface GraphEdge {
  /** Source entity name */
  source: string;
  /** Target entity name */
  target: string;
  /** Relationship verb */
  relation: string;
  /** Description */
  description: string;
  /** Document this edge was extracted from */
  docId: string;
  /** Human-readable document name */
  docName: string;
  /** Page/section number */
  page: number;
  /** Preview of the source text */
  preview: string;
}

/** Result of fetching a single entity + its edges. */
export interface EntityResult {
  node: GraphNode | null;
  edges: GraphEdge[];
}

/** Result of a multi-hop graph walk. */
export interface WalkResult {
  /** All entity nodes visited */
  nodes: GraphNode[];
  /** All relationship edges discovered */
  edges: GraphEdge[];
  /** Human-readable paths (e.g. ["A -[requires]-> B -[triggers]-> C"]) */
  paths: string[];
}
