/**
 * GraphStore — DynamoDB storage for the knowledge graph.
 *
 * Uses the adjacency list pattern in a single-table design:
 *
 *   Node:  PK=KG#{namespace}  SK=N#{slug}
 *   Edge:  PK=KG#{namespace}  SK=E#{src}#R#{rel}#T#{tgt}#D#{docId}#P#{page}
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

import type { ExtractionResult, GraphNode, GraphEdge } from './types.js';
import { slugify } from './slugify.js';

/** Options for the GraphStore. */
export interface GraphStoreOptions {
  /** DynamoDB Document Client instance. */
  docClient: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /**
   * Partition key prefix for graph data.
   * @default 'KG#'
   */
  keyPrefix?: string;
}

/** Result of writing graph data for one segment. */
export interface WriteStats {
  nodes: number;
  edges: number;
}

export class GraphStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly keyPrefix: string;

  constructor(options: GraphStoreOptions) {
    this.docClient = options.docClient;
    this.tableName = options.tableName;
    this.keyPrefix = options.keyPrefix ?? 'KG#';
  }

  /**
   * Writes extracted entities and relationships to DynamoDB.
   * Idempotent — re-extracting the same segment overwrites with the same keys.
   */
  async writeGraph(
    namespace: string,
    result: ExtractionResult,
    docId: string,
    docName: string,
    page: number,
    preview: string,
  ): Promise<WriteStats> {
    const now = new Date().toISOString();
    let nodes = 0;
    let edges = 0;

    // Write entity nodes (upsert)
    for (const entity of result.entities) {
      const slug = slugify(entity.name);
      try {
        await this.docClient.send(new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `${this.keyPrefix}${namespace}`,
            SK: `N#${slug}`,
            kind: 'node',
            namespace,
            name: entity.name,
            category: entity.type,
            description: entity.description ?? '',
            doc_ids: [docId],
            updated_at: now,
          },
        }));
        nodes++;
      } catch (err) {
        console.warn(`[GraphStore] Failed to write node "${entity.name}": ${err}`);
      }
    }

    // Write relationship edges
    for (const rel of result.relationships) {
      const srcSlug = slugify(rel.source);
      const tgtSlug = slugify(rel.target);
      const relSlug = rel.relation.replace(/[^a-z0-9_]/g, '_').slice(0, 50);

      try {
        await this.docClient.send(new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `${this.keyPrefix}${namespace}`,
            SK: `E#${srcSlug}#R#${relSlug}#T#${tgtSlug}#D#${docId}#P#${page}`,
            kind: 'edge',
            namespace,
            src: rel.source,
            tgt: rel.target,
            rel: rel.relation,
            description: rel.description ?? '',
            doc_id: docId,
            doc_name: docName,
            page,
            preview: preview.slice(0, 200),
            created_at: now,
          },
        }));
        edges++;
      } catch (err) {
        console.warn(`[GraphStore] Failed to write edge "${rel.source}" -> "${rel.target}": ${err}`);
      }
    }

    return { nodes, edges };
  }

  /**
   * Fetches a single entity and all its relationships (1-hop).
   */
  async getEntity(namespace: string, entityName: string): Promise<{ node: GraphNode | null; edges: GraphEdge[] }> {
    const slug = slugify(entityName);
    const pk = `${this.keyPrefix}${namespace}`;

    // Get node
    const nodeResult = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: { ':pk': pk, ':sk': `N#${slug}` },
    }));
    const rawNode = nodeResult.Items?.[0];
    const node: GraphNode | null = rawNode ? this.toNode(rawNode) : null;

    // Get outgoing edges (this entity as source)
    const outgoing = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': `E#${slug}#` },
      Limit: 50,
    }));

    // Get incoming edges (this entity as target)
    const incoming = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :edgePrefix)',
      FilterExpression: 'contains(SK, :tgt)',
      ExpressionAttributeValues: { ':pk': pk, ':edgePrefix': 'E#', ':tgt': `#T#${slug}#` },
      Limit: 50,
    }));

    const edges = [
      ...(outgoing.Items ?? []).map(e => this.toEdge(e)),
      ...(incoming.Items ?? []).map(e => this.toEdge(e)),
    ];

    return { node, edges };
  }

  /**
   * Multi-hop BFS walk of the graph.
   *
   * Starts from an entity and follows relationship edges up to `maxHops` deep.
   * Returns all visited nodes, edges, and human-readable paths.
   */
  async walk(
    namespace: string,
    startEntity: string,
    maxHops = 2,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; paths: string[] }> {
    const pk = `${this.keyPrefix}${namespace}`;
    const seen = new Set<string>();
    const foundNodes: GraphNode[] = [];
    const foundEdges: GraphEdge[] = [];
    const paths: string[] = [];
    const frontier: Array<{ entity: string; depth: number; trail: string[] }> = [
      { entity: startEntity, depth: 0, trail: [startEntity] },
    ];

    while (frontier.length > 0 && foundEdges.length < 100) {
      const { entity, depth, trail } = frontier.shift()!;
      const slug = slugify(entity);

      if (seen.has(slug)) continue;
      seen.add(slug);

      // Get node info
      const nodeRes = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': pk, ':sk': `N#${slug}` },
      }));
      if (nodeRes.Items?.[0]) {
        foundNodes.push(this.toNode(nodeRes.Items[0]));
      }

      if (depth >= maxHops) {
        if (trail.length > 1) paths.push(trail.join(' '));
        continue;
      }

      // Outgoing edges
      if (direction === 'outgoing' || direction === 'both') {
        const outRes = await this.docClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': pk, ':sk': `E#${slug}#` },
          Limit: 20,
        }));

        for (const raw of outRes.Items ?? []) {
          foundEdges.push(this.toEdge(raw));
          const next = raw.tgt as string;
          if (!seen.has(slugify(next))) {
            frontier.push({
              entity: next,
              depth: depth + 1,
              trail: [...trail, `-[${raw.rel}]->`, next],
            });
          }
        }
      }

      // Incoming edges
      if (direction === 'incoming' || direction === 'both') {
        const inRes = await this.docClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :edgePrefix)',
          FilterExpression: 'contains(SK, :tgt)',
          ExpressionAttributeValues: { ':pk': pk, ':edgePrefix': 'E#', ':tgt': `#T#${slug}#` },
          Limit: 20,
        }));

        for (const raw of inRes.Items ?? []) {
          foundEdges.push(this.toEdge(raw));
          const prev = raw.src as string;
          if (!seen.has(slugify(prev))) {
            frontier.push({
              entity: prev,
              depth: depth + 1,
              trail: [...trail, `<-[${raw.rel}]-`, prev],
            });
          }
        }
      }

      if (trail.length > 1) paths.push(trail.join(' '));
    }

    // Deduplicate edges
    const uniqueEdges = Array.from(
      new Map(foundEdges.map(e => [`${e.source}|${e.relation}|${e.target}`, e])).values(),
    );

    return { nodes: foundNodes, edges: uniqueEdges, paths };
  }

  /**
   * Deletes all graph data for a specific document within a namespace.
   */
  async deleteByDocument(namespace: string, docId: string): Promise<number> {
    const pk = `${this.keyPrefix}${namespace}`;
    let deleted = 0;
    let lastKey: Record<string, any> | undefined;

    do {
      const result = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        FilterExpression: 'contains(doc_id, :docId) OR contains(doc_ids, :docId)',
        ExpressionAttributeValues: { ':pk': pk, ':sk': 'E#', ':docId': docId },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: lastKey,
      }));

      const items = result.Items ?? [];
      lastKey = result.LastEvaluatedKey;
      deleted += await this.batchDelete(items);
    } while (lastKey);

    return deleted;
  }

  /**
   * Deletes ALL graph data for a namespace (nodes + edges).
   */
  async deleteByNamespace(namespace: string): Promise<number> {
    const pk = `${this.keyPrefix}${namespace}`;
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
      deleted += await this.batchDelete(items);
    } while (lastKey);

    return deleted;
  }

  // ===== Private helpers =====

  private async batchDelete(items: Record<string, any>[]): Promise<number> {
    let deleted = 0;
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
    return deleted;
  }

  private toNode(item: Record<string, any>): GraphNode {
    return {
      id: slugify(item.name as string),
      name: item.name as string,
      type: item.category as string,
      description: (item.description as string) ?? '',
      docIds: (item.doc_ids as string[]) ?? [],
      updatedAt: (item.updated_at as string) ?? '',
    };
  }

  private toEdge(item: Record<string, any>): GraphEdge {
    return {
      source: item.src as string,
      target: item.tgt as string,
      relation: item.rel as string,
      description: (item.description as string) ?? '',
      docId: (item.doc_id as string) ?? '',
      docName: (item.doc_name as string) ?? '',
      page: (item.page as number) ?? 0,
      preview: (item.preview as string) ?? '',
    };
  }
}
