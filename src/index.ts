// Core types
export type {
  Entity,
  Relationship,
  ExtractionResult,
  ExtractorFn,
  GraphNode,
  GraphEdge,
  EntityResult,
  WalkResult,
} from './types.js';

// Graph store (DynamoDB adjacency list)
export { GraphStore, type GraphStoreOptions, type WriteStats } from './graph-store.js';

// Graph builder (extraction orchestrator)
export { GraphBuilder, type GraphBuilderOptions, type SegmentInput, type SegmentResult } from './graph-builder.js';

// Utility
export { slugify } from './slugify.js';
