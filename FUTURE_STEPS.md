# Future Steps

This document covers two major areas of future work:

1. **Deployment options** — how to expose the 3 search tools as remote endpoints and move from a local tool-calling loop to a Foundry-managed agent
2. **Index update automation** — how to keep the AI Search index current as new videos/transcripts are added

---

## Table of Contents

- [Part 1: Deployment Options](#part-1-deployment-options)
  - [Current State](#current-state)
  - [Option A: FastAPI + OpenAPI Spec](#option-a-fastapi--openapi-spec)
  - [Option B: Azure Functions](#option-b-azure-functions)
  - [Option C: MCP Server](#option-c-mcp-server)
  - [Registering Tools on a Foundry Prompt Agent](#registering-tools-on-a-foundry-prompt-agent)
  - [Deployment Comparison](#deployment-comparison)
- [Part 2: Index Update Automation](#part-2-index-update-automation)
  - [Update Strategies](#update-strategies)
  - [Strategy 1: Push API with Pipeline Trigger](#strategy-1-push-api-with-pipeline-trigger)
  - [Strategy 2: Azure AI Search Indexer with Blob Storage](#strategy-2-azure-ai-search-indexer-with-blob-storage)
  - [Handling Different Change Types](#handling-different-change-types)
  - [Enrichment Pipeline for New Content](#enrichment-pipeline-for-new-content)
  - [Schema Changes vs Content Changes](#schema-changes-vs-content-changes)
- [Part 3: Latency Reduction](#part-3-latency-reduction)
  - [Current Latency Profile](#current-latency-profile)
  - [Strategy 1: Streaming](#strategy-1-streaming-perceived-latency)
  - [Strategy 2: Query Type Selection](#strategy-2-query-type-selection-actual-latency)
  - [Strategy 3: Result Caching](#strategy-3-result-caching-actual-latency)
  - [Strategy 4: Parallel Tool Execution](#strategy-4-parallel-tool-execution-actual-latency)
  - [Strategy 5: Co-location](#strategy-5-co-location-actual-latency)
  - [Strategy 6: Smarter Prompting](#strategy-6-reduce-iterations-via-smarter-prompting-actual-latency)
  - [Recommended Priority](#recommended-priority)

---

## Part 1: Deployment Options

### Current State

Today the chatbot uses **Approach B** — the Python backend (`backend/agent.py`) runs the entire tool-calling loop locally:

```
User → React UI → Quart backend → Azure OpenAI (gpt-5.1)
                        ↕                    ↕
                   _execute_search()    tool_calls / responses
                        ↕
                  Azure AI Search
```

The LLM, the tool-calling loop, and the search execution all live in your Python code. Foundry is used only for conversation memory (Conversations API).

**Goal**: Move to **Approach A** — a Foundry Prompt Agent manages the LLM, the tool-calling loop, memory, tracing, and evaluation. Your code only hosts the tool endpoints. This means:
- No local agent loop code
- No system prompt maintenance in Python (it lives in Foundry)
- Foundry playground works out of the box (for testing without the UI)
- Built-in tracing and evaluation

To get there, you need to:
1. **Host the 3 search tools as HTTP endpoints** (Options A, B, or C below)
2. **Register those endpoints on a Foundry Prompt Agent** (via OpenAPI spec or MCP)
3. **Update the React frontend** to call the Foundry Responses API instead of the local `/conversation` endpoint

---

### Option A: FastAPI + OpenAPI Spec

Wrap the 3 search tools in a FastAPI app that auto-generates an OpenAPI 3.0 spec.

**Structure**:
```
tool-server/
├── main.py              # FastAPI app with 3 POST endpoints
├── search.py            # _execute_search() + _fuzzify() (from agent.py)
├── models.py            # Pydantic request/response models
├── requirements.txt     # fastapi, uvicorn, azure-identity, requests
└── Dockerfile
```

**Key implementation**:
```python
# main.py
from fastapi import FastAPI
from models import SearchRequest, SearchResponse
from search import execute_search

app = FastAPI(
    title="Hierarchical Search Tools",
    description="3 search tools for the video-transcripts-hierarchical-v2 index",
    version="1.0.0",
)

@app.post("/tools/search_projects", response_model=SearchResponse)
async def search_projects(req: SearchRequest):
    return execute_search("project", **req.dict())

@app.post("/tools/search_vocs", response_model=SearchResponse)
async def search_vocs(req: SearchRequest):
    return execute_search("voc", **req.dict())

@app.post("/tools/search_chunks", response_model=SearchResponse)
async def search_chunks(req: SearchRequest):
    return execute_search("chunk", **req.dict())
```

```python
# models.py
from pydantic import BaseModel, Field
from typing import Optional

class SearchRequest(BaseModel):
    search_text: str = Field("*", description="Full-text query. '*' = match all")
    filter: Optional[str] = Field(None, description="OData $filter expression")
    select: Optional[str] = Field(None, description="Comma-separated fields to return")
    search_fields: Optional[str] = Field(None, description="Comma-separated searchable fields")
    query_type: str = Field("simple", description="simple | full | semantic")
    use_vector: bool = Field(False, description="Enable vector search")
    vector_text: Optional[str] = Field(None, description="Text to embed for vector query")
    vector_fields: Optional[str] = Field(None, description="Override default vector field")
    top: int = Field(10, description="Max results")
    orderby: Optional[str] = Field(None, description="Sort expression")
    facets: Optional[list[str]] = Field(None, description="Facet expressions")
    include_count: bool = Field(True, description="Include total match count")
    fuzzy: bool = Field(False, description="Enable Lucene fuzzy matching (~1)")
    semantic_config: Optional[str] = Field(None, description="Override semantic config")
```

**Auto-generated OpenAPI spec** is available at `/openapi.json` — this is what you register in Foundry.

**Hosting options**:
- **Local development**: `uvicorn main:app --port 8001` + [devtunnel](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/) to expose publicly
- **Production**: Azure App Service, Azure Container Apps, or Azure Container Instances

**Pros**: Auto-generated OpenAPI spec, testable in Swagger UI, Pydantic validation, familiar framework  
**Cons**: Requires a running web server, another service to manage

---

### Option B: Azure Functions

Deploy each tool as a serverless Azure Function — no server to manage, scales to zero.

**Structure**:
```
tool-functions/
├── host.json
├── local.settings.json
├── requirements.txt        # azure-functions, azure-identity, requests
├── search_projects/
│   ├── __init__.py          # Azure Function handler
│   └── function.json        # HTTP trigger config
├── search_vocs/
│   ├── __init__.py
│   └── function.json
├── search_chunks/
│   ├── __init__.py
│   └── function.json
└── shared/
    ├── search.py            # _execute_search() + _fuzzify()
    └── __init__.py
```

**Key implementation**:
```python
# search_projects/__init__.py
import azure.functions as func
import json
from shared.search import execute_search

def main(req: func.HttpRequest) -> func.HttpResponse:
    body = req.get_json()
    result = execute_search("project", **body)
    return func.HttpResponse(
        json.dumps(result),
        mimetype="application/json",
        status_code=200,
    )
```

```json
// search_projects/function.json
{
  "bindings": [
    {
      "authLevel": "function",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["post"],
      "route": "tools/search_projects"
    },
    {
      "type": "http",
      "direction": "out",
      "name": "$return"
    }
  ]
}
```

**OpenAPI spec**: Azure Functions doesn't auto-generate one like FastAPI does. You'd write a static `openapi.json` manually (or generate it from the Pydantic models and host it as a separate endpoint).

**Hosting**:
- **Local**: `func start` (Azure Functions Core Tools)
- **Production**: Deploy to Azure Functions App via `func azure functionapp publish <app-name>` or `azd up`

**Pros**: Serverless (scales to zero, no server management), pay-per-execution, easy Azure deployment  
**Cons**: Cold start latency, manual OpenAPI spec, slightly more boilerplate per function

---

### Option C: MCP Server

Expose the 3 tools as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server. Foundry supports MCP tools natively.

**Structure**:
```
tool-mcp-server/
├── server.py              # MCP server with 3 tools
├── search.py              # _execute_search() + _fuzzify()
├── requirements.txt       # mcp, azure-identity, requests
└── Dockerfile
```

**Key implementation** (using the `mcp` Python SDK):
```python
# server.py
from mcp.server.fastmcp import FastMCP
from search import execute_search

mcp = FastMCP("hierarchical-search-tools")

@mcp.tool()
def search_projects(
    search_text: str = "*",
    filter: str = None,
    select: str = None,
    query_type: str = "simple",
    use_vector: bool = False,
    top: int = 10,
    fuzzy: bool = False,
    # ... other params
) -> str:
    """Search project-level documents in the hierarchical index."""
    return execute_search("project", search_text=search_text, filter=filter,
                          select=select, query_type=query_type,
                          use_vector=use_vector, top=top, fuzzy=fuzzy)

@mcp.tool()
def search_vocs(...) -> str:
    """Search VoC/video-level documents."""
    return execute_search("voc", ...)

@mcp.tool()
def search_chunks(...) -> str:
    """Search chunk-level transcript passages."""
    return execute_search("chunk", ...)

if __name__ == "__main__":
    mcp.run(transport="sse")  # or "stdio" for local use
```

**Transport options**:
- **SSE (Server-Sent Events)**: HTTP-based, suitable for remote hosting. Start with `mcp.run(transport="sse")`, accessible at `http://host:port/sse`
- **stdio**: For local use only (VS Code, Claude Desktop, etc.)

**Hosting**: Same as Option A — App Service, Container Apps, or devtunnel for local dev.

**Pros**: Native Foundry MCP support, simpler than REST if using MCP-aware clients, tool descriptions are first-class  
**Cons**: MCP SDK is newer/less mature than FastAPI, fewer developers familiar with it, still requires remote hosting

---

### Registering Tools on a Foundry Prompt Agent

Once tools are hosted (via any option above), create a Foundry Prompt Agent that replaces the local `agent.py`:

1. **Go to** [Azure AI Foundry](https://ai.azure.com) → your project → **Agents**
2. **Create a Prompt Agent** with:
   - **Model**: gpt-5.1 (or whichever deployment you want)
   - **System prompt**: Copy from `backend/agent.py`'s `SYSTEM_PROMPT` (the full data dictionary, query toolkit, rules)
   - **Temperature**: 0
3. **Add tools**:
   - For **OpenAPI** (Options A or B): Custom tools → OpenAPI → provide the URL to your `/openapi.json` or upload a static spec file
   - For **MCP** (Option C): Custom tools → Model Context Protocol → provide the SSE endpoint URL
4. **Test in playground**: Ask a question — Foundry calls your remote tools, iterates, and returns the answer
5. **Update the React frontend**: Replace the local `/conversation` endpoint with the [Foundry Responses API](https://learn.microsoft.com/en-us/azure/ai-services/agents/quickstart) (`POST /agents/{agent_id}/responses`)

**What moves to Foundry vs. what stays in your code**:

| Component | Before (Approach B) | After (Approach A) |
|-----------|--------------------|--------------------|
| System prompt | `agent.py` SYSTEM_PROMPT string | Foundry agent config |
| Tool schemas | `agent.py` TOOLS list | Auto-discovered from OpenAPI/MCP |
| Tool-calling loop | `agent.py` run_agent() | Foundry orchestrator |
| Tool execution | `agent.py` _execute_search() | Your hosted endpoint (FastAPI/Functions/MCP) |
| Conversation memory | Foundry Conversations API | Foundry (built-in) |
| Model selection | `settings.py` CHAT_DEPLOYMENT | Foundry agent config |
| Tracing | ❌ None | ✅ Built-in |
| Evaluation | ❌ Manual | ✅ Foundry eval framework |

---

### Deployment Comparison

| | FastAPI + OpenAPI | Azure Functions | MCP Server |
|---|---|---|---|
| **Auto OpenAPI spec** | ✅ Built-in | ❌ Manual | ❌ N/A (uses MCP) |
| **Serverless** | ❌ | ✅ | ❌ |
| **Cold start** | None | Yes (~2-5s) | None |
| **Foundry registration** | OpenAPI tool | OpenAPI tool | MCP tool |
| **Local dev** | `uvicorn` + devtunnel | `func start` + devtunnel | `mcp.run()` + devtunnel |
| **Production hosting** | App Service / Container Apps | Functions App | App Service / Container Apps |
| **Complexity** | Low | Medium | Low |
| **Maturity** | High | High | Medium |

**Recommendation**: Start with **Option A (FastAPI)** — it's the fastest path to a working OpenAPI spec and Foundry integration. If serverless cost/scale matters, migrate to Azure Functions later. Use MCP if you want the tools to also work in VS Code Copilot / Claude Desktop.

---

## Part 2: Index Update Automation

### Current State

The index is populated by running scripts manually in sequence:

```
extract_transcripts.py → generate_video_metadata.py → generate_voc_summaries.py
→ generate_project_metadata.py → restructure_metadata.py
→ generate_segment_summaries.py → ingest_chunks.py → backfill_hierarchy.py
```

All scripts are resume-safe (skip already-processed items) and use `video_metadata.json` as the intermediate state file.

The question is: **how do you keep the index updated when new videos are added, transcripts change, or videos are removed?**

---

### Update Strategies

Azure AI Search supports two approaches for keeping an index current ([docs](https://learn.microsoft.com/en-us/azure/search/search-howto-reindex)):

| Strategy | How It Works | Best For |
|----------|-------------|----------|
| **Push API** | Your code calls `mergeOrUpload` / `delete` on the index directly | Complex enrichment pipelines with LLM-generated fields |
| **Indexer + Data Source** | AI Search pulls from a data source (Blob, CosmosDB, SQL) on a schedule, with built-in change detection | Simple field mappings, minimal transformation |

**For this project, Push API is the right choice** because:
- Each document requires multiple LLM calls (PII scrubbing, summary generation, segment extraction, embedding)
- Fields like `segment_chronological_summary`, `short_VoC_summary`, and `Voc_segment_summary` are GPT-generated — an indexer can't produce these
- The enrichment pipeline has dependencies (VoC summaries need project summaries, segment summaries need segment boundaries, etc.)

An indexer could work if you pre-compute all fields and store the final documents in Blob Storage as JSON — the indexer just maps fields. But the enrichment pipeline itself still needs to run externally.

---

### Strategy 1: Push API with Pipeline Trigger

**Architecture**:
```
Blob Storage (raw transcripts, categorised by project)
    │
    ▼  (Event Grid trigger on blob upload/delete)
    │
Azure Function / Logic App
    │
    ▼  (runs enrichment pipeline)
    │
Push API → Azure AI Search (mergeOrUpload / delete)
```

#### Step 1: Centralised Transcript Storage

Organise raw transcripts in Blob Storage:
```
transcripts-container/
├── ATUM/
│   ├── video1.txt
│   ├── video2.txt
│   └── ...
└── Thunderstruck/
    ├── video1.txt
    └── ...
```

The folder name = project name. Each `.txt` file = one VoC's transcript.

#### Step 2: Event-Driven Trigger

Use **Azure Event Grid** to fire on blob creates/deletes:

```python
# Azure Function triggered by blob upload
import azure.functions as func

def main(event: func.EventGridEvent):
    blob_url = event.get_json()["url"]
    # Parse project name and filename from blob path
    # e.g. "transcripts-container/ATUM/video1.txt"
    # → project = "ATUM", filename = "video1.txt"
    
    if event.event_type == "Microsoft.Storage.BlobCreated":
        # Run enrichment pipeline for this transcript
        enrich_and_index(project, filename, blob_url)
    
    elif event.event_type == "Microsoft.Storage.BlobDeleted":
        # Delete all docs for this VoC from the index
        delete_voc_documents(project, filename)
```

#### Step 3: Enrichment + Push

For a **new or updated transcript**, the enrichment function runs the same pipeline steps:

```python
def enrich_and_index(project: str, filename: str, blob_url: str):
    # 1. Download transcript from Blob Storage
    raw_text = download_blob(blob_url)
    
    # 2. PII-scrub in memory
    clean_text = normalize_transcript(raw_text)
    
    # 3. Generate video metadata (GPT call)
    #    → segment_chronological_summary, keywords, products, segments[]
    metadata = generate_video_metadata(clean_text, filename)
    
    # 4. Generate VoC summaries (GPT call)
    #    → voc_category, short_VoC_summary, long_stakeholder_VoC_summary
    summaries = generate_voc_summaries(clean_text, metadata)
    
    # 5. Generate segment summaries (GPT call)
    #    → Voc_segment_summary per segment
    segment_summaries = generate_segment_summaries(metadata)
    
    # 6. Update project-level metadata if needed (GPT call)
    #    → short_project_summary, long_stakeholder_project_summary
    update_project_metadata(project)
    
    # 7. Chunk transcript, embed, push to index
    chunks = chunk_transcript(clean_text, metadata)
    push_documents(chunks, action="mergeOrUpload")
    
    # 8. Push/update VoC doc
    voc_doc = build_voc_document(metadata, summaries, segment_summaries)
    push_documents([voc_doc], action="mergeOrUpload")
    
    # 9. Push/update project doc
    project_doc = build_project_document(project)
    push_documents([project_doc], action="mergeOrUpload")
```

**Push API call** using the Azure SDK:
```python
from azure.search.documents import SearchClient
from azure.identity import DefaultAzureCredential

client = SearchClient(
    endpoint="https://your-search-service.search.windows.net",
    index_name="video-transcripts-hierarchical-v2",
    credential=DefaultAzureCredential(),
)

# Add or update documents
result = client.merge_or_upload_documents(documents=documents)

# Delete documents
result = client.delete_documents(documents=[{"id": doc_id} for doc_id in ids_to_delete])
```

> **Batch limits**: Up to 1,000 documents per batch or ~16 MB, whichever comes first. For large VoCs with many chunks, batch in groups of 1,000.

#### Step 4: Handling Updates vs. New Content

The `mergeOrUpload` action handles both cases:
- **New document** (ID doesn't exist) → creates it
- **Existing document** (ID already exists) → overwrites it

Since document IDs are SHA-256 hashes of `(project_title, VoC_title)` or `(project_title, VoC_title, chunk_index)`, re-processing the same transcript produces the same IDs → the index is updated in place.

**Important**: If a transcript is re-processed and produces a different number of chunks (e.g. editorial changes), orphan chunks from the old version must be deleted. Query for all chunks with the VoC's `voc_id` first, compare against the new chunk set, and delete any extras:

```python
# Find existing chunks for this VoC
existing = client.search(
    search_text="*",
    filter=f"doc_type eq 'chunk' and voc_id eq '{voc_id}'",
    select="id",
)
existing_ids = {doc["id"] for doc in existing}

# Compare with new chunk IDs
new_ids = {chunk["id"] for chunk in new_chunks}
orphan_ids = existing_ids - new_ids

# Delete orphans
if orphan_ids:
    client.delete_documents(documents=[{"id": oid} for oid in orphan_ids])
```

---

### Strategy 2: Azure AI Search Indexer with Blob Storage

If you pre-compute all fields and store final documents as JSON blobs, an indexer can keep the index in sync automatically.

**Architecture**:
```
Enrichment Pipeline (external)
    │
    ▼  writes final JSON docs
    │
Blob Storage (indexed-documents-container/)
    │
    ▼  (Indexer pulls on schedule, with change detection)
    │
Azure AI Search
```

#### Setup

1. **Store final docs as JSON in Blob Storage** — one JSON file per document (or one file per batch):
   ```
   indexed-documents/
   ├── project_atum.json
   ├── voc_atum_video1.json
   ├── chunk_atum_video1_0.json
   ├── chunk_atum_video1_1.json
   └── ...
   ```

2. **Create a Data Source**:
   ```json
   {
     "name": "hierarchical-docs-datasource",
     "type": "azureblob",
     "credentials": { "connectionString": "<storage-connection-string>" },
     "container": { "name": "indexed-documents" },
     "dataDeletionDetectionPolicy": {
       "@odata.type": "#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy"
     }
   }
   ```

3. **Create an Indexer** with a schedule:
   ```json
   {
     "name": "hierarchical-docs-indexer",
     "dataSourceName": "hierarchical-docs-datasource",
     "targetIndexName": "video-transcripts-hierarchical-v2",
     "schedule": { "interval": "PT1H" },
     "parameters": {
       "configuration": {
         "parsingMode": "json"
       }
     }
   }
   ```

4. **Change detection**: Blob Storage has built-in change detection — the indexer only processes blobs modified since the last run. For deletions, enable [native blob soft delete](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview).

**When to use this**: If you want the index to stay in sync without writing any push code — just write enriched JSON blobs and the indexer handles the rest.

**Limitation**: The enrichment pipeline (GPT calls for summaries, PII scrubbing, embedding) still runs externally. The indexer only handles the final "put documents into the index" step.

---

### Handling Different Change Types

| Change | What to Do |
|--------|-----------|
| **New video added** | Run full enrichment pipeline → push chunks + VoC doc (`mergeOrUpload`) → update project doc (re-generate `short_project_summary`, update `num_VoCs`, merge keywords/products) |
| **Transcript updated** | Re-run enrichment for that VoC → push updated chunks + VoC doc → delete orphan chunks if chunk count changed → update project doc |
| **Video deleted** | Delete all chunk docs with `voc_id eq '{id}'` → delete VoC doc → update project doc |
| **New project added** | Run enrichment for all VoCs in the project → push chunks + VoC docs + new project doc |
| **Project deleted** | Delete all docs with `project_id eq '{id}'` (chunks + VoCs + project doc) |
| **Schema change (add field)** | Update index schema (no rebuild needed) → backfill new field on existing docs via `merge` |
| **Schema change (modify field type/attributes)** | Drop and recreate index → re-ingest all documents. Use [index alias](https://learn.microsoft.com/en-us/azure/search/search-how-to-alias) to minimize downtime |

---

### Enrichment Pipeline for New Content

When a new transcript arrives, these pipeline scripts must run in order:

| Step | Script | LLM? | Input | Output |
|------|--------|-------|-------|--------|
| 1 | `remove_pii.py` | ❌ | Raw transcript | Clean transcript (in-memory) |
| 2 | `generate_video_metadata.py` | ✅ GPT-4.1 | Clean transcript | `segment_chronological_summary`, segments[], keywords, products |
| 3 | `generate_voc_summaries.py` | ✅ GPT-4.1 | Clean transcript + metadata | `voc_category`, `short_VoC_summary`, `long_stakeholder_VoC_summary` |
| 4 | `generate_segment_summaries.py` | ✅ GPT-4.1 | Segments from step 2 | `Voc_segment_summary` per segment |
| 5 | `generate_project_metadata.py` | ✅ GPT-4.1 | All VoC summaries in project | `short_project_summary`, `long_stakeholder_project_summary` |
| 6 | `ingest_chunks.py` | ❌ (embed only) | Clean transcript + metadata | Chunked, embedded, pushed to index |
| 7 | `backfill_hierarchy.py` | ❌ (embed only) | Metadata + summaries | Project + VoC docs pushed to index |

For automation, refactor these scripts into importable functions and orchestrate them in a single pipeline function (as shown in the [enrich_and_index example above](#step-3-enrichment--push)).

---

### Schema Changes vs Content Changes

Per the [Azure AI Search reindexing docs](https://learn.microsoft.com/en-us/azure/search/search-howto-reindex):

#### Changes that DON'T require a rebuild
- Add a new field
- Set `retrievable` on an existing field
- Add/update/delete semantic configurations
- Add/update/delete scoring profiles
- Add/update/delete synonym maps

For these, update the index schema via the [Create or Update Index API](https://learn.microsoft.com/en-us/rest/api/searchservice/indexes/create-or-update), then push updated documents to populate new fields.

#### Changes that REQUIRE a full rebuild
- Delete a field
- Change a field's data type or attributes (searchable, filterable, etc.)
- Assign an analyzer to an existing field
- Change an analyzer definition

For these:
1. Back up existing documents (use the [Python backup/restore utility](https://github.com/Azure/azure-search-vector-samples/tree/main/demo-python/code/utilities/index-backup-restore))
2. Delete the index
3. Create a new index with the updated schema
4. Re-ingest all documents

**Tip**: Use an [index alias](https://learn.microsoft.com/en-us/azure/search/search-how-to-alias) to minimize downtime — create the new index under a different name (e.g. `v3`), populate it, then swap the alias to point to the new index. Application code references the alias, so no code changes needed.

---

## Part 3: Latency Reduction

### Current Latency Profile

A typical question takes 10-20 seconds end-to-end. The breakdown:

| Component | Time per call | Calls per question | Total |
|-----------|--------------|-------------------|-------|
| Responses API (LLM inference) | ~1.5-3s | 2-4 iterations | ~5-10s |
| Azure AI Search (semantic + vector) | ~500-1000ms | 2-6 tool calls | ~2-5s |
| Azure AI Search (simple keyword) | ~100-300ms | 0-2 tool calls | ~0-0.5s |
| Network overhead (per round-trip) | ~50-100ms | 6-10 total | ~0.5-1s |
| **Total** | | | **~8-16s** |

The bottleneck is **Azure AI Search query execution time** for semantic/vector queries (ML model inference on Search's side) compounded by **multiple serial LLM round-trips**.

### Strategy 1: Streaming (Perceived Latency)

The single most impactful change. Instead of waiting for the full agent loop to complete, stream LLM output tokens to the user as they're generated. The user sees the answer forming after the first LLM call (~2s) instead of staring at a blank screen for 15s.

**What changes:**
- `responses.create()` gets `stream=True`
- The Quart endpoint becomes an SSE (Server-Sent Events) generator
- During tool execution phases, send a "searching..." indicator
- After the final iteration, the answer has already been partially streamed

**What doesn't change:** Total wall-clock time is identical. But perceived wait drops from 10-20s to ~2s.

### Strategy 2: Query Type Selection (Actual Latency)

Not every tool call needs semantic + vector search. Latency tiers:

| Query type | Server-side cost | When to use |
|-----------|-----------------|-------------|
| `filter` only (`search_text="*"`) | ~50-100ms | Fetching by known ID: `filter="id eq '...'"` |
| `simple` with `search_fields` | ~100-300ms | Name lookups: project_title, VoC_title |
| `full` (Lucene + fuzzy) | ~200-400ms | Typo-tolerant name search |
| `semantic` | ~400-700ms | Natural language content search |
| `semantic` + `use_vector=True` | ~700-1200ms | Broad topic search, meaning-based |

Currently the LLM chooses the query type, and it often defaults to semantic+vector even for simple name lookups. Options:

1. **Strengthen system prompt guidance.** Add explicit instructions like: "For name/ID lookups, ALWAYS use simple query type with search_fields. Reserve semantic+vector for content/topic searches."
2. **Default to simple in `_execute_search()`** and only upgrade to semantic/vector when the LLM explicitly requests it (already the case, but reinforce in prompt).

**Estimated saving:** ~0.5-1s per tool call when the LLM uses simple instead of semantic for lookups. Over a 3-iteration question, that's 1-3s.

### Strategy 3: Result Caching (Actual Latency)

Cache search results for repeated or similar queries. Common patterns:

- **Project name → ID resolution** happens on nearly every question. Cache the mapping for the session or with a TTL.
- **Follow-up questions** about the same project/VoC re-execute the same search.
- **"List all projects"** always returns the same result (until the index changes).

```python
from functools import lru_cache
import hashlib

# Cache project lookups (up to 64 unique queries)
@lru_cache(maxsize=64)
def _cached_search(body_hash: str, body_json: str) -> str:
    return _search_index(json.loads(body_json))
```

A more targeted approach: maintain a `project_name → (id, num_VoCs)` cache that's populated on first lookup and reused for subsequent questions. This eliminates the "resolve project" iteration entirely for known projects.

**Estimated saving:** 1 full iteration (~2-3s) for follow-up questions about the same project.

### Strategy 4: Parallel Tool Execution (Actual Latency)

When the LLM requests multiple tool calls in a single iteration (e.g. `search_projects` and `search_chunks` simultaneously), execute them in parallel instead of sequentially:

```python
from concurrent.futures import ThreadPoolExecutor

def _execute_tool_calls(function_calls):
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {}
        for fc in function_calls:
            fn_name = fc.name
            fn_args = json.loads(fc.arguments) if fc.arguments else {}
            if fn_name in TOOL_DISPATCH:
                futures[pool.submit(TOOL_DISPATCH[fn_name], **fn_args)] = fc
            # ...
        for future in as_completed(futures):
            fc = futures[future]
            result = future.result()
            # ...
```

**Estimated saving:** When 2+ tools fire in one iteration, latency for that iteration drops from `sum(all tool times)` to `max(single tool time)`. Typical saving: 0.5-1s per iteration with parallel calls.

### Strategy 5: Co-location (Actual Latency)

If the web app runs locally or in a different Azure region than Azure AI Search, every search call pays extra network latency.

- Deploy the web app in the **same Azure region** as the Search service
- Use **Azure Container Apps** or **App Service** with VNet integration for Azure-backbone routing (no public internet hops)

**Estimated saving:** ~20-80ms per search call (small but compounds over 4-6 calls).

### Strategy 6: Reduce Iterations via Smarter Prompting (Actual Latency)

Each iteration costs 1 LLM round-trip (~2-3s) + tool execution time. Reducing from 3 iterations to 2 saves ~3-5s.

Options:
- **Pre-populate known entities**: If the system knows the available projects (could be cached at startup), include them in the system prompt so the LLM doesn't need a "list projects" call.
- **Combine lookup + content in one call**: Instead of "resolve project name → search chunks" (2 iterations), prompt the LLM to use `search_chunks` directly with `search_fields="project_title"` when it can infer the project name is in the title field.
- **Raise `top` slightly for initial searches**: Returning a few extra results in one call is cheaper than making a second call for more.

### Recommended Priority

| Priority | Strategy | Effort | Impact on user experience |
|----------|----------|--------|--------------------------|
| 1 | Streaming | Medium | **High** — perceived wait drops from 10-20s to ~2s |
| 2 | Query type selection | Low | **Medium** — saves 1-3s actual time |
| 3 | Result caching | Low | **Medium** — saves 2-3s on follow-up questions |
| 4 | Parallel tool execution | Low | **Low-Medium** — saves 0.5-1s when parallel calls occur |
| 5 | Smarter prompting | Low | **Medium** — saves 3-5s when an iteration is eliminated |
| 6 | Co-location | Medium | **Low** — marginal per-call improvement |
