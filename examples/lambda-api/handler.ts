/**
 * Example: Lambda API for GraphRAG.
 *
 * Three endpoints:
 *   POST /ingest  — extract entities/relationships from a text segment and write to graph
 *   POST /entity  — look up one entity + its direct relationships
 *   POST /walk    — multi-hop graph traversal from a starting entity
 *
 * Deploy this as a Lambda behind API Gateway or a Function URL.
 * Requires: DynamoDB table with PK/SK string keys, on-demand billing.
 *
 * Environment variables:
 *   TABLE_NAME     — DynamoDB table name
 *   OPENAI_API_KEY — API key for the extraction LLM (example uses OpenAI; swap for any provider)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  GraphStore,
  GraphBuilder,
  type ExtractorFn,
} from 'dynamo-graphrag';

// --- Setup (runs once per Lambda cold start) ---

const TABLE = process.env.TABLE_NAME ?? 'rag-table';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const store = new GraphStore({ docClient: db, tableName: TABLE });

// --- Extractor: calls an LLM to extract entities + relationships ---
// This example uses OpenAI. Replace with Anthropic, Bedrock, Ollama, etc.

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';

const extractor: ExtractorFn = async (text) => {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: `Extract entities and relationships from this text.

Return JSON:
{
  "entities": [{"name": "...", "type": "service|config|api|module|concept|person|team", "description": "one sentence"}],
  "relationships": [{"source": "entity_name", "relation": "verb_phrase", "target": "entity_name", "description": "one sentence"}]
}

Rules:
- Max 10 entities, max 12 relationships
- Entity names: short (1-5 words), use EXACT notation from text
- Relationship verbs: uses, requires, triggers, depends_on, calls, owns, configures, produces, consumes
- Every relationship must reference at least one entity from the entities list

Text:
"""
${text.slice(0, 2000)}
"""`,
      }],
    }),
  });

  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content);
  return {
    entities: parsed.entities ?? [],
    relationships: parsed.relationships ?? [],
  };
};

const builder = new GraphBuilder({ store, extractor });

// --- Handler ---

interface LambdaEvent {
  httpMethod?: string;
  requestContext?: { http?: { method?: string; path?: string } };
  path?: string;
  body?: string;
}

export async function handler(event: LambdaEvent) {
  const method = event.httpMethod ?? event.requestContext?.http?.method ?? 'GET';
  const path = event.path ?? event.requestContext?.http?.path ?? '/';

  try {
    if (method === 'POST' && path.includes('/ingest')) {
      return await handleIngest(JSON.parse(event.body ?? '{}'));
    }
    if (method === 'POST' && path.includes('/entity')) {
      return await handleEntity(JSON.parse(event.body ?? '{}'));
    }
    if (method === 'POST' && path.includes('/walk')) {
      return await handleWalk(JSON.parse(event.body ?? '{}'));
    }
    return respond(404, { error: 'Not found. Use POST /ingest, /entity, or /walk' });
  } catch (err: any) {
    console.error(err);
    return respond(500, { error: err.message });
  }
}

// --- Ingest ---

interface IngestBody {
  namespace: string;
  docId: string;
  docName: string;
  segments: Array<{ text: string; page: number }>;
}

async function handleIngest(body: IngestBody) {
  const { namespace, docId, docName, segments: segs } = body;

  if (!namespace || !docId || !segs?.length) {
    return respond(400, { error: 'Required: namespace, docId, segments[]' });
  }

  let totalNodes = 0;
  let totalEdges = 0;

  for (const seg of segs) {
    const result = await builder.processSegment({
      text: seg.text,
      namespace,
      docId,
      docName: docName ?? docId,
      page: seg.page ?? 1,
    });
    totalNodes += result.nodes;
    totalEdges += result.edges;
  }

  return respond(200, {
    message: `Processed ${segs.length} segments → ${totalNodes} nodes, ${totalEdges} edges`,
  });
}

// --- Entity lookup ---

interface EntityBody {
  namespace: string;
  entity: string;
}

async function handleEntity(body: EntityBody) {
  const { namespace, entity } = body;

  if (!namespace || !entity) {
    return respond(400, { error: 'Required: namespace, entity' });
  }

  const { node, edges } = await store.getEntity(namespace, entity);

  if (!node && edges.length === 0) {
    return respond(200, { found: false, entity });
  }

  return respond(200, {
    found: true,
    node,
    relationships: edges.map(e => ({
      from: e.source,
      relation: e.relation,
      to: e.target,
      doc: e.docName,
      page: e.page,
    })),
  });
}

// --- Graph walk ---

interface WalkBody {
  namespace: string;
  startEntity: string;
  maxHops?: number;
}

async function handleWalk(body: WalkBody) {
  const { namespace, startEntity, maxHops = 2 } = body;

  if (!namespace || !startEntity) {
    return respond(400, { error: 'Required: namespace, startEntity' });
  }

  const { nodes, edges, paths } = await store.walk(namespace, startEntity, Math.min(maxHops, 3));

  return respond(200, {
    startEntity,
    hops: maxHops,
    nodes: nodes.map(n => ({ name: n.name, type: n.type, description: n.description })),
    edges: edges.map(e => ({ from: e.source, relation: e.relation, to: e.target })),
    paths,
  });
}

// --- Utility ---

function respond(statusCode: number, body: object) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
