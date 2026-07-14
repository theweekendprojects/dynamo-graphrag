<div align="center">

# 🕸️ dynamo-graphrag

### Knowledge graphs for RAG — on DynamoDB. No Neo4j, no Neptune, no cluster.

Extract entities and relationships from your documents, store them as a graph,
and traverse multi-hop connections at query time. **Scales to zero.**

[![npm](https://img.shields.io/npm/v/dynamo-graphrag?color=cb3837&logo=npm)](https://www.npmjs.com/package/dynamo-graphrag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Serverless](https://img.shields.io/badge/serverless-scales%20to%20zero-232f3e?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/dynamodb/)

</div>

---

## 🤔 Why GraphRAG?

Standard vector RAG answers "what does this paragraph say?" — it finds the most *similar* chunks.
But it can't answer **"what's connected to this?"** — questions that require hopping across documents:

- *"What depends on this config value?"*
- *"If I change ServiceA, what else breaks?"*
- *"Show me everything related to the auth module"*

GraphRAG solves this by building a **knowledge graph** from your documents — entities connected by typed relationships — and traversing it at query time.

## 🧐 Why DynamoDB?

Every existing GraphRAG library requires Neo4j, Neptune, or an in-memory graph. Those are great for massive graphs, but for RAG workloads (hundreds to low thousands of entities per tenant):

| Approach | Minimum cost | Scales to zero? | Managed? |
| :--- | :--- | :---: | :---: |
| Neo4j Aura | ~$65 / mo | ❌ | ✅ |
| Amazon Neptune | ~$180 / mo | ❌ | ✅ |
| Self-hosted graph DB | ~$50 / mo + ops | ❌ | ❌ |
| **DynamoDB on-demand** | **$0 / mo at rest** | ✅ | ✅ |

DynamoDB's adjacency list pattern gives you O(1) entity lookup and O(edges) traversal per hop — plenty fast for the graph sizes RAG produces. And you pay *nothing* when nobody's querying.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Ingestion                                               │
│                                                          │
│  Chunks ─── Your Extractor (any LLM) ─── GraphBuilder   │
│                   ↓                            ↓         │
│          { entities, relationships }    GraphStore       │
│                                          (DynamoDB)      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Query                                                   │
│                                                          │
│  "What connects to X?" ─── GraphStore.lookupEntity()     │
│  "Trace dependencies"  ─── GraphStore.traverse()         │
│                              ↓                           │
│         { nodes, edges, paths } ─── feed to LLM context  │
└─────────────────────────────────────────────────────────┘
```

## ✨ Features

- 🧩 **Pluggable extraction** — bring your own LLM. OpenAI, Anthropic, Mistral, Ollama, Bedrock… just return `{ entities, relationships }`.
- 🪶 **Serverless & scale-to-zero** — DynamoDB on-demand. Zero cost at rest.
- 🔗 **Multi-hop traversal** — BFS graph walk with configurable depth (1–3 hops), direction control.
- 📦 **Single-table design** — shares your existing DynamoDB table. Configurable key prefixes.
- 🏢 **Multi-tenant** — every namespace is isolated by partition key.
- 🛡️ **Fail-open** — extraction errors never crash your pipeline. Bad chunks are skipped gracefully.
- 🔒 **Fully typed** — strict TypeScript, ESM, zero `any` in the public API.
- 🐣 **Tiny** — no graph DB driver, no heavy dependencies. Just `@aws-sdk/lib-dynamodb`.

## 📦 Install

```bash
npm install dynamo-graphrag
```

## 🚀 Quick Start

### 1️⃣ Define your extractor

The extractor is any async function that takes text and returns entities + relationships. Call whatever LLM you want:

```ts
import type { ExtractorFn } from 'dynamo-graphrag';

// Example using OpenAI (you can use any provider)
const extractor: ExtractorFn = async (text) => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Extract entities and relationships from this text.
Return JSON: { "entities": [{"name": "...", "type": "...", "description": "..."}],
               "relationships": [{"source": "...", "relation": "...", "target": "...", "description": "..."}] }

Text: """${text}"""`
    }],
    response_format: { type: 'json_object' },
  });
  return JSON.parse(response.choices[0].message.content!);
};
```

### 2️⃣ Ingest — build the graph from document chunks

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GraphStore, GraphBuilder } from 'dynamo-graphrag';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const store = new GraphStore({ docClient: db, tableName: 'my-rag-table' });
const builder = new GraphBuilder({ store, extractor });

// Process chunks one by one (rate-limit friendly)
await builder.processChunks(
  myChunks.map(chunk => ({
    text: chunk.text,
    namespace: 'project-alpha',
    documentId: chunk.docId,
    documentName: chunk.fileName,
    pageNumber: chunk.page,
  })),
  (i, total) => console.log(`${i + 1}/${total}`),
);
```

### 3️⃣ Query — look up entities and traverse

```ts
// Find a single entity and its direct relationships
const { node, edges } = await store.lookupEntity('project-alpha', 'AuthService');
// → node: { name: 'AuthService', type: 'service', ... }
// → edges: [
//     { source: 'AuthService', relation: 'uses', target: 'JWT', ... },
//     { source: 'AuthService', relation: 'validates', target: 'UserSession', ... },
//     { source: 'RateLimiter', relation: 'protects', target: 'AuthService', ... },
//   ]

// Multi-hop traversal — discover chains of dependencies
const { nodes, edges, paths } = await store.traverse('project-alpha', 'AuthService', 2);
// → paths: [
//     "AuthService --[uses]--> JWT --[expires_after]--> 24h",
//     "AuthService --[validates]--> UserSession --[stored_in]--> Redis",
//     "RateLimiter --[protects]--> AuthService",
//   ]
```

### 4️⃣ Feed into your RAG prompt

```ts
const context = paths.join('\n');
const prompt = `Use this knowledge graph context to answer the question.

Graph relationships:
${context}

Question: ${userQuestion}`;
```

## 🗄️ DynamoDB Table Design

Single-table, adjacency list pattern:

| PK | SK | Holds |
| :--- | :--- | :--- |
| `GRAPH#{namespace}` | `NODE#{entity_name}` | Entity node (name, type, description) |
| `GRAPH#{namespace}` | `EDGE#{source}#REL#{relation}#TGT#{target}#DOC#{docId}#PG#{page}` | Relationship edge with provenance |

**Required table schema:**
- Partition key: `PK` (String)
- Sort key: `SK` (String)
- Billing: On-demand (pay-per-request)

```bash
aws dynamodb create-table \
  --table-name my-rag-table \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

No GSI needed. All queries use `PK` + `begins_with(SK, ...)`.

## 📚 API

| Export | What it does |
| :--- | :--- |
| `GraphStore` | DynamoDB read/write — lookup, traverse, delete by document or namespace |
| `GraphBuilder` | Orchestrates extraction → validation → storage |
| `normalize(name)` | Entity name normalizer (lowercase, safe for SK) |
| `ExtractorFn` | The type signature for your pluggable extractor |

## 🧠 Extraction Tips

Your extractor quality determines your graph quality. Some tips:

- **Use a cheap, fast model** for extraction (GPT-4o-mini, Claude Haiku, Mistral Small). You'll call it once per chunk — cost matters more than reasoning depth.
- **Limit output** — cap at 8-15 entities and 10-20 relationships per chunk. More is noise.
- **Be specific about entity types** — tell the model your domain's types (service, API, config, module…).
- **Relationship verbs matter** — "uses", "depends_on", "triggers", "requires" are more useful than "is_related_to".
- **Preserve exact notation** — entity names should match how they appear in the source ("AuthService", not "authentication service").

## ⚖️ Good to Know

- **Scale** — DynamoDB handles thousands of entities per namespace easily. The BFS traversal does N DynamoDB queries (one per hop × edges), so keep `maxHops ≤ 3` for snappy latency.
- **Deduplication** — the SK pattern ensures each unique (source, relation, target, document, page) combination is stored exactly once. Re-extracting the same chunk is idempotent.
- **Provenance** — every edge stores which document and page it came from. Your LLM can cite sources.
- **No graph database needed** — for RAG-scale graphs (hundreds to low-thousands of entities), DynamoDB's adjacency list is fast and cheap. If you outgrow it (millions of nodes), the `GraphStore` interface is small enough to swap for Neptune.

## 🤝 Contributing

Issues and PRs welcome. Keep it typed, keep it serverless, keep it simple.

## 📄 License

[MIT](./LICENSE)

<div align="center">
<sub>The first TypeScript GraphRAG library that doesn't need a graph database.</sub>
</div>
