/**
 * GraphStore — DynamoDB storage for the knowledge graph.
 *
 * Uses the adjacency list pattern in a single-table design:
 *
 *   Node:  PK=GRAPH#{namespace}  SK=NODE#{normalized_entity_name}
 *   Edge:  PK=GRAPH#{namespace}  SK=EDGE#{source}#REL#{relation}#TGT#{target}#DOC#{docId}#PG#{page}
 *
 * This gives O(1) node lookup and O(n) edge scan per entity — fast enough
 * for graphs with thousands of entities (typical RAG scale).
 *
 * No GSI required. All queries use PK + begins_with(SK, ...).
 */

import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

import type { Entity, Relationship, ExtractionResult, GraphNode, GraphEdge } from './types.js';
import { normalize } from './normalize.js';

/** Options for the GraphStore. */
export interface GraphStoreOptions {
  /** DynamoDB Document Client instance. */
  docClient: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /**
   * Partition key prefix for graph data.
   * @default 'GRAPH#'
   */
  pkPrefix?: string;
}

/** Result of writing graph data for one chunk. */
export interface WriteResult {
  nodesWritten: number;
  edgesWritten: number;
}

export class GraphStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly pkPrefix: string;

  constructor(options: GraphStoreOptions) {
    this.docClient = options.docClient;
    this.tableName = options.tableName;
    this.pkPrefix = options.pkPrefix ?? 'GRAPH#';
  }

  /**
   * Writes extracted entities and relationships to DynamoDB.
   * Idempotent — re-extracting the same chunk overwrites with same keys.
   */
  async writeExtractionResult(
    namespace: string,
    result: ExtractionResult,
    documentId: string,
    documentName: string,
    pageNumber: number,
    chunkPreview: string,
  ): Promise<WriteResult> {
    const now = new Date().toISOString();
    let nodesWritten = 0;
    let edgesWritten = 0;

    // Write entity nodes (upsert)
    for (const entity of result.entities) {
      const norm = normalize(entity.name);
      try {
        await this.docClient.send(new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `${this.pkPrefix}${namespace}`,
            SK: `NODE#${norm}`,
            entity_type: 'graph_node',
            namespace,
            entity_name: entity.name,
            entity_category: entity.type,
            description: entity.description ?? '',
            source_documents: [documentId],
            updated_at: now,
          },
        }));
        nodesWritten++;
      } catch (err) {
        console.warn(`[GraphStore] Failed to write node "${entity.name}": ${err}`);
      }
    }

    // Write relationship edges
    for (const rel of result.relationships) {
      const sourceNorm = normalize(rel.source);
      const targetNorm = normalize(rel.target);
      const relNorm = rel.relation.replace(/[^a-z0-9_]/g, '_').slice(0, 50);

      try {
        await this.docClient.send(new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `${this.pkPrefix}${namespace}`,
            SK: `EDGE#${sourceNorm}#REL#${relNorm}#TGT#${targetNorm}#DOC#${documentId}#PG#${pageNumber}`,
            entity_type: 'graph_edge',
            namespace,
            source_entity: rel.source,
            target_entity: rel.target,
            relation: rel.relation,
            description: rel.description ?? '',
            document_id: documentId,
            document_name: documentName,
            page_number: pageNumber,
            chunk_preview: chunkPreview.slice(0, 200),
            created_at: now,
          },
        }));
        edgesWritten++;
      } catch (err) {
        console.warn(`[GraphStore] Failed to write edge "${rel.source}" -> "${rel.target}": ${err}`);
      }
    }

    return { nodesWritten, edgesWritten };
  }

  /**
   * Looks up a single entity and all its relationships (1-hop).
   */
  async lookupEntity(namespace: string, entityName: string): Promise<{ node: GraphNode | null; edges: GraphEdge[] }> {
    const norm = normalize(entityName);
    const pk = `${this.pkPrefix}${namespace}`;

    // Get node
    const nodeResult = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: { ':pk': pk, ':sk': `NODE#${norm}` },
    }));
    const rawNode = nodeResult.Items?.[0];
    const node: GraphNode | null = rawNode ? this.toGraphNode(rawNode) : null;

    // Get outgoing edges (this entity as source)
    const outgoing = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': `EDGE#${norm}#` },
      Limit: 50,
    }));

    // Get incoming edges (this entity as target)
    const incoming = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'contains(SK, :tgt)',
      ExpressionAttributeValues: { ':pk': pk, ':skPrefix': 'EDGE#', ':tgt': `#TGT#${norm}#` },
      Limit: 50,
    }));

    const edges = [
      ...(outgoing.Items ?? []).map(e => this.toGraphEdge(e)),
      ...(incoming.Items ?? []).map(e => this.toGraphEdge(e)),
    ];

    return { node, edges };
  }

  /**
   * Multi-hop BFS traversal of the graph.
   *
   * Starts from an entity and follows relationship edges up to `maxHops` deep.
   * Returns all visited nodes, edges, and human-readable paths.
   */
  async traverse(
    namespace: string,
    startEntity: string,
    maxHops = 2,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; paths: string[] }> {
    const pk = `${this.pkPrefix}${namespace}`;
    const visited = new Set<string>();
    const allNodes: GraphNode[] = [];
    const allEdges: GraphEdge[] = [];
    const paths: string[] = [];
    const queue: Array<{ entity: string; depth: number; path: string[] }> = [
      { entity: startEntity, depth: 0, path: [startEntity] },
    ];

    while (queue.length > 0 && allEdges.length < 100) {
      const { entity, depth, path } = queue.shift()!;
      const norm = normalize(entity);

      if (visited.has(norm)) continue;
      visited.add(norm);

      // Get node info
      const nodeRes = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': pk, ':sk': `NODE#${norm}` },
      }));
      if (nodeRes.Items?.[0]) {
        allNodes.push(this.toGraphNode(nodeRes.Items[0]));
      }

      if (depth >= maxHops) {
        if (path.length > 1) paths.push(path.join(' '));
        continue;
      }

      // Outgoing edges
      if (direction === 'outgoing' || direction === 'both') {
        const outRes = await this.docClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': pk, ':sk': `EDGE#${norm}#` },
          Limit: 20,
        }));

        for (const edge of outRes.Items ?? []) {
          allEdges.push(this.toGraphEdge(edge));
          const target = edge.target_entity as string;
          if (!visited.has(normalize(target))) {
            queue.push({
              entity: target,
              depth: depth + 1,
              path: [...path, `--[${edge.relation}]-->`, target],
            });
          }
        }
      }

      // Incoming edges
      if (direction === 'incoming' || direction === 'both') {
        const inRes = await this.docClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skP)',
          FilterExpression: 'contains(SK, :tgt)',
          ExpressionAttributeValues: { ':pk': pk, ':skP': 'EDGE#', ':tgt': `#TGT#${norm}#` },
          Limit: 20,
        }));

        for (const edge of inRes.Items ?? []) {
          allEdges.push(this.toGraphEdge(edge));
          const source = edge.source_entity as string;
          if (!visited.has(normalize(source))) {
            queue.push({
              entity: source,
              depth: depth + 1,
              path: [...path, `<--[${edge.relation}]--`, source],
            });
          }
        }
      }

      if (path.length > 1) paths.push(path.join(' '));
    }

    // Deduplicate edges
    const uniqueEdges = Array.from(
      new Map(allEdges.map(e => [`${e.source}|${e.relation}|${e.target}`, e])).values(),
    );

    return { nodes: allNodes, edges: uniqueEdges, paths };
  }

  /**
   * Deletes all graph data for a specific document within a namespace.
   */
  async deleteByDocument(namespace: string, documentId: string): Promise<number> {
    const pk = `${this.pkPrefix}${namespace}`;
    let deleted = 0;
    let lastKey: Record<string, any> | undefined;

    do {
      const result = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        FilterExpression: 'contains(document_id, :docId) OR contains(source_documents, :docId)',
        ExpressionAttributeValues: { ':pk': pk, ':sk': 'EDGE#', ':docId': documentId },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: lastKey,
      }));

      const items = result.Items ?? [];
      lastKey = result.LastEvaluatedKey;

      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        await this.docClient.send(new BatchWriteCommand({
          RequestItems: {
            [this.tableName]: batch.map(item => ({
              DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
            })),
          },
        }));
        deleted += batch.length;
      }
    } while (lastKey);

    return deleted;
  }

  /**
   * Deletes ALL graph data for a namespace (nodes + edges).
   */
  async deleteByNamespace(namespace: string): Promise<number> {
    const pk = `${this.pkPrefix}${namespace}`;
    let deleted = 0;
    let lastKey: Record<string, any> | undefined;

    do {
      const result = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: lastKey,
        Limit: 250,
      }));

      const items = result.Items ?? [];
      lastKey = result.LastEvaluatedKey;

      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        await this.docClient.send(new BatchWriteCommand({
          RequestItems: {
            [this.tableName]: batch.map(item => ({
              DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
            })),
          },
        }));
        deleted += batch.length;
      }
    } while (lastKey);

    return deleted;
  }

  // ===== Private helpers =====

  private toGraphNode(item: Record<string, any>): GraphNode {
    return {
      id: normalize(item.entity_name as string),
      name: item.entity_name as string,
      type: item.entity_category as string,
      description: (item.description as string) ?? '',
      sourceDocuments: (item.source_documents as string[]) ?? [],
      updatedAt: (item.updated_at as string) ?? '',
    };
  }

  private toGraphEdge(item: Record<string, any>): GraphEdge {
    return {
      source: item.source_entity as string,
      target: item.target_entity as string,
      relation: item.relation as string,
      description: (item.description as string) ?? '',
      documentId: (item.document_id as string) ?? '',
      documentName: (item.document_name as string) ?? '',
      pageNumber: (item.page_number as number) ?? 0,
      chunkPreview: (item.chunk_preview as string) ?? '',
    };
  }
}
