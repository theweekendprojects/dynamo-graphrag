// Core types
export type {
  Entity,
  Relationship,
  ExtractionResult,
  ExtractorFn,
  GraphNode,
  GraphEdge,
  LookupResult,
  TraversalResult,
} from './types.js';

// Graph store (DynamoDB adjacency list)
export { GraphStore, type GraphStoreOptions, type WriteResult } from './graph-store.js';

// Graph builder (extraction orchestrator)
export { GraphBuilder, type GraphBuilderOptions, type ChunkInput, type ProcessResult } from './graph-builder.js';

// Utility
export { normalize } from './normalize.js';
