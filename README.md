<div align="center">

# 🕸️ dynamo-graphrag

### Give your AI agent a knowledge graph it can *walk* — on DynamoDB. No Neo4j, no Neptune, no cluster.

Extract entities and relationships from your documents, store them as a graph,
and let your agent traverse multi-hop connections at query time. **Scales to zero.**

[![npm](https://img.shields.io/npm/v/dynamo-graphrag?color=cb3837&logo=npm)](https://www.npmjs.com/package/dynamo-graphrag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Serverless](https://img.shields.io/badge/serverless-scales%20to%20zero-232f3e?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/dynamodb/)

</div>

---

## 🤖 Why agents need a graph, not just a vector store

Vector RAG hands your agent a pile of *similar-looking* text and hopes the answer is in there. That works for "what does this say?" It falls apart on the questions agents are actually asked:

- *"If I change `AuthService`, what breaks downstream?"*
- *"What's connected to this incident, across all the runbooks?"*
- *"Trace every dependency between billing and the payment gateway."*

These are **multi-hop** questions — the answer isn't in one passage, it's in the *path between passages*. A vector store can't follow that path. A knowledge graph can.

> 🧠 Research consistently shows that connecting facts through a graph beats flat vector retrieval on complex, multi-hop questions — with the bonus that the walk path is **explainable and traceable**, so your agent can show its reasoning instead of asserting it. *(See [Neo4j's multi-hop reasoning writeup](https://neo4j.com/blog/genai/knowledge-graph-llm-multi-hop-reasoning/); summarized for compliance.)*

`dynamo-graphrag` gives your agent two tools it can call — **fetch an entity** and **walk the graph** — backed by DynamoDB. No graph database to run, no cluster to pay for when the agent is idle.

## 🧐 Why DynamoDB (and not Neo4j / Neptune)?

Every existing GraphRAG library needs Neo4j, Neptune, or an in-memory graph. Those shine for billion-edge graphs. But a RAG knowledge graph is *small* — hundreds to low-thousands of entities per tenant — and you shouldn't pay cluster prices for it:

| Approach | Minimum cost | Scales to zero? | Managed? |
| :--- | :--- | :---: | :---: |
| Neo4j Aura | ~$65 / mo | ❌ | ✅ |
| Amazon Neptune | ~$180 / mo | ❌ | ✅ |
| Self-hosted graph DB | ~$50 / mo + ops | ❌ | ❌ |
| **DynamoDB on-demand** | **$0 / mo at rest** | ✅ | ✅ |

DynamoDB's adjacency-list pattern gives O(1) entity lookup and O(edges) traversal per hop — plenty fast for graph sizes RAG produces. And you pay *nothing* when no agent is querying.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Ingestion                                               │
│                                                          │
│  Segments ─── Your Extractor (any LLM) ─── GraphBuilder  │
│                   ↓                            ↓         │
│          { entities, relationships }    GraphStore       │
│                                          (DynamoDB)      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Query  (your agent calls these as tools)                │
│                                                          │
│  getEntity("AuthService")  ──►  node + direct edges      │
│  walk("AuthService", 2)    ──►  multi-hop paths          │
│                              ↓                           │
│         { nodes, edges, paths } ─── into agent context   │
└─────────────────────────────────────────────────────────┘
```

## ✨ Features

- 🤖 **Two agent-ready tools** — `getEntity` (1-hop) and `walk` (multi-hop). Drop them into any tool-calling loop or MCP server.
- 🧩 **Pluggable extraction** — bring your own LLM. OpenAI, Anthropic, Mistral, Ollama, Bedrock… just return `{ entities, relationships }`.
- 🪶 **Serverless & scale-to-zero** — DynamoDB on-demand. Zero cost at rest.
- 🔗 **Multi-hop traversal** — BFS graph walk with configurable depth (1–3 hops) and direction control.
- 🧾 **Explainable paths** — every traversal returns human-readable chains (`A --[uses]--> B --[expires]--> C`) your agent can cite.
- 📦 **Single-table design** — shares your existing DynamoDB table. Configurable key prefixes.
- 🏢 **Multi-tenant** — every namespace is isolated by partition key.
- 🛡️ **Fail-open** — extraction errors never crash your pipeline. Bad segments are skipped gracefully.
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

// Example using OpenAI (any provider works)
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

### 2️⃣ Ingest — build the graph from document segments

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GraphStore, GraphBuilder } from 'dynamo-graphrag';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const store = new GraphStore({ docClient: db, tableName: 'my-rag-table' });
const builder = new GraphBuilder({ store, extractor });

// Process segments one by one (rate-limit friendly)
await builder.processSegments(
  mySegments.map(seg => ({
    text: seg.text,
    namespace: 'project-alpha',
    docId: seg.docId,
    docName: seg.fileName,
    page: seg.page,
  })),
  (i, total) => console.log(`${i + 1}/${total}`),
);
```

### 3️⃣ Query — fetch entities and walk the graph

```ts
// Fetch a single entity and its direct relationships
const { node, edges } = await store.getEntity('project-alpha', 'AuthService');
// → node: { name: 'AuthService', type: 'service', ... }
// → edges: [
//     { source: 'AuthService', relation: 'uses', target: 'JWT', ... },
//     { source: 'AuthService', relation: 'validates', target: 'UserSession', ... },
//     { source: 'RateLimiter', relation: 'protects', target: 'AuthService', ... },
//   ]

// Multi-hop walk — discover chains of dependencies
const { nodes, edges, paths } = await store.walk('project-alpha', 'AuthService', 2);
// → paths: [
//     "AuthService -[uses]-> JWT -[expires_after]-> 24h",
//     "AuthService -[validates]-> UserSession -[stored_in]-> Redis",
//     "RateLimiter -[protects]-> AuthService",
//   ]
```

## 🛠️ Wire it as agent tools

This is where GraphRAG earns its keep. Expose the graph as **two tools** and let the agent reason its way across your knowledge — first pinpointing an entity, then walking outward. Shown with the Vercel AI SDK; the same shape works for LangChain, OpenAI function calling, or an MCP server.

```ts
import { tool } from 'ai';
import { z } from 'zod';

const findEntity = tool({
  description: 'Look up one entity and its direct relationships. Use to find what a ' +
               'specific thing connects to (services, configs, modules, people).',
  parameters: z.object({ entity: z.string() }),
  execute: async ({ entity }) => {
    const { node, edges } = await store.getEntity(currentTenant, entity);
    if (!node && edges.length === 0) return { found: false };
    return {
      found: true,
      entity: node,
      relationships: edges.map(e => ({ from: e.source, relation: e.relation, to: e.target,
                                       source: `${e.docName} p.${e.page}` })),
    };
  },
});

const walkGraph = tool({
  description: 'Walk the knowledge graph from a starting entity, following relationships ' +
               'up to N hops. Use for "what depends on X" / "what breaks if X changes" questions.',
  parameters: z.object({
    startEntity: z.string(),
    maxHops: z.number().min(1).max(3).default(2),
  }),
  execute: async ({ startEntity, maxHops }) => {
    const { paths } = await store.walk(currentTenant, startEntity, maxHops);
    return { paths }; // human-readable chains the model can cite
  },
});
```

**Why agents reason better with these tools:**
- **Chaining is natural** — the agent calls `findEntity("AuthService")`, spots an edge to `JWT`, then calls `walkGraph("JWT", 2)` to go deeper. It builds a reasoning chain instead of guessing.
- **Answers become traceable** — every path is a citable chain of facts with document + page provenance. No more "trust me" answers.
- **It fills vector RAG's blind spot** — pair these graph tools with a semantic `search` tool and the agent picks the right instrument: semantics for "what does it say," graph for "how does it connect."
- **Cheap to explore** — at DynamoDB on-demand prices, an agent can walk freely during a reasoning loop without running up a cluster bill.

> 💡 **Pro combo:** run `dynamo-graphrag` alongside [`dynamo-bm25-hybrid`](https://www.npmjs.com/package/dynamo-bm25-hybrid) and your agent gets the full trifecta — keyword, semantic, and graph — all serverless, all scale-to-zero, all on the same DynamoDB table.

## 🎯 When to reach for this

| You're building… | Why a graph helps |
| :--- | :--- |
| A **dev/ops copilot** over runbooks & architecture docs | "What breaks if I change X" is a traversal, not a similarity search |
| A **compliance / policy agent** | Trace which rules depend on which clauses across documents |
| A **research assistant** | Connect findings scattered across many papers |
| An **incident-response agent** | Walk from a symptom to related systems, owners, and past incidents |
| Any **agent that gets "how are these related?" questions** | That's literally what a graph answers |

## 🗄️ DynamoDB Table Design

Single-table, adjacency-list pattern:

| PK | SK | Holds |
| :--- | :--- | :--- |
| `KG#{namespace}` | `N#{slug}` | Entity node (name, category, description) |
| `KG#{namespace}` | `E#{src}#R#{rel}#T#{tgt}#D#{docId}#P#{page}` | Relationship edge with provenance |

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
| `GraphStore` | DynamoDB read/write — `getEntity`, `walk`, delete by document or namespace |
| `GraphBuilder` | Orchestrates extraction → validation → storage |
| `slugify(name)` | Entity name slugifier (lowercase, key-safe) |
| `ExtractorFn` | The type signature for your pluggable extractor |

## 🧠 Extraction Tips

Your extractor quality determines your graph quality. Some tips:

- **Use a cheap, fast model** for extraction (GPT-4o-mini, Claude Haiku, Mistral Small). You call it once per segment — cost matters more than reasoning depth.
- **Limit output** — cap at 8–15 entities and 10–20 relationships per segment. More is noise.
- **Be specific about entity types** — tell the model your domain's types (service, API, config, module…).
- **Relationship verbs matter** — "uses", "depends_on", "triggers", "requires" are far more useful than "is_related_to".
- **Preserve exact notation** — entity names should match how they appear in the source ("AuthService", not "authentication service").

## ⚖️ Good to Know

- **Scale** — DynamoDB handles thousands of entities per namespace easily. The BFS walk does N DynamoDB queries (one per hop × edges), so keep `maxHops ≤ 3` for snappy latency.
- **Deduplication** — the SK pattern stores each unique (source, relation, target, document, page) combination exactly once. Re-extracting the same segment is idempotent.
- **Provenance** — every edge records the document and page it came from, so your agent can cite sources.
- **No graph database needed** — for RAG-scale graphs (hundreds to low-thousands of entities), DynamoDB's adjacency list is fast and cheap. If you outgrow it (millions of nodes), the `GraphStore` interface is small enough to swap for Neptune.

## 🤝 Contributing

Issues and PRs welcome. Keep it typed, keep it serverless, keep it simple.

## 📄 License

[MIT](./LICENSE)

<div align="center">
<sub>The first TypeScript GraphRAG library that doesn't need a graph database — built so your agent can <em>reason across</em> knowledge, not just retrieve it.</sub>
</div>
