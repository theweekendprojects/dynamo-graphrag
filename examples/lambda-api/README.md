# Lambda API Example

A minimal Lambda handler with three endpoints:

- **POST /ingest** — extract entities + relationships from text and write to the knowledge graph
- **POST /entity** — look up one entity and its direct relationships (1-hop)
- **POST /walk** — multi-hop graph traversal from a starting entity

## Setup

1. Create a DynamoDB table (on-demand billing):

```bash
aws dynamodb create-table \
  --table-name rag-table \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

2. Set environment variables on your Lambda:
   - `TABLE_NAME` — your DynamoDB table
   - `OPENAI_API_KEY` — for the extraction LLM (or swap the extractor for any provider)

## Usage

### Ingest segments from a document

```bash
curl -X POST https://your-api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": "my-project",
    "docId": "doc-001",
    "docName": "architecture.md",
    "segments": [
      { "text": "AuthService authenticates users via JWT tokens and validates sessions against Redis.", "page": 1 },
      { "text": "RateLimiter protects AuthService from abuse. It allows 100 requests per minute per IP.", "page": 2 },
      { "text": "UserSession objects are stored in Redis with a 24-hour TTL.", "page": 3 }
    ]
  }'
```

Response:

```json
{ "message": "Processed 3 segments → 6 nodes, 5 edges" }
```

### Look up an entity

```bash
curl -X POST https://your-api/entity \
  -H "Content-Type: application/json" \
  -d '{ "namespace": "my-project", "entity": "AuthService" }'
```

Response:

```json
{
  "found": true,
  "node": { "name": "AuthService", "type": "service", "description": "Authenticates users via JWT" },
  "relationships": [
    { "from": "AuthService", "relation": "uses", "to": "JWT", "doc": "architecture.md", "page": 1 },
    { "from": "AuthService", "relation": "validates", "to": "UserSession", "doc": "architecture.md", "page": 1 },
    { "from": "RateLimiter", "relation": "protects", "to": "AuthService", "doc": "architecture.md", "page": 2 }
  ]
}
```

### Walk the graph (multi-hop)

```bash
curl -X POST https://your-api/walk \
  -H "Content-Type: application/json" \
  -d '{ "namespace": "my-project", "startEntity": "AuthService", "maxHops": 2 }'
```

Response:

```json
{
  "startEntity": "AuthService",
  "hops": 2,
  "nodes": [
    { "name": "AuthService", "type": "service", "description": "Authenticates users via JWT" },
    { "name": "JWT", "type": "protocol", "description": "JSON Web Token standard" },
    { "name": "UserSession", "type": "entity", "description": "Active user session" },
    { "name": "Redis", "type": "service", "description": "In-memory data store" }
  ],
  "edges": [
    { "from": "AuthService", "relation": "uses", "to": "JWT" },
    { "from": "AuthService", "relation": "validates", "to": "UserSession" },
    { "from": "UserSession", "relation": "stored_in", "to": "Redis" }
  ],
  "paths": [
    "AuthService -[uses]-> JWT",
    "AuthService -[validates]-> UserSession -[stored_in]-> Redis"
  ]
}
```

## Swapping the LLM

The example uses OpenAI `gpt-4o-mini` for entity extraction. To use a different provider, replace the `extractor` function in `handler.ts`. The only contract:

```ts
type ExtractorFn = (text: string) => Promise<{
  entities: Array<{ name: string; type: string; description?: string }>;
  relationships: Array<{ source: string; relation: string; target: string; description?: string }>;
}>;
```

Works with Anthropic, Bedrock, Mistral, Ollama — anything that can return JSON.

## Deploying

Just a handler file — deploy however you deploy Lambdas:

- **CDK**: `new NodejsFunction(this, 'GraphRAG', { entry: 'handler.ts', environment: { TABLE_NAME, OPENAI_API_KEY } })`
- **SAM / Serverless Framework**: standard TypeScript handler
- **Function URL**: enable in Lambda console for instant HTTPS endpoint
