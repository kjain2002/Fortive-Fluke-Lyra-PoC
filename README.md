# Hierarchical Search Chatbot

An MCP-style agentic chatbot that uses a **hierarchical Azure AI Search index** (`video-transcripts-hierarchical-v2`) to answer questions about solar project meeting recordings. The agent has 3 generic search tools — one per hierarchy level (projects, VoCs/videos, transcript chunks) — with full control over query type, vector search, OData filters, field selection, facets, and more. The LLM decides how to craft each query, inspects results, and iterates until it has enough context to answer.

A standalone **notebook version** is also included for experimentation and development without the web UI.

![Chatbot Demo](Animation.gif)

---

## Table of Contents

- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [File Structure](#file-structure)
- [AI Search Index Data Dictionary](#ai-search-index-data-dictionary)
- [Agent Tools](#agent-tools)
- [Running the Notebook](#running-the-notebook)
- [Running the Web App](#running-the-web-app)
- [Environment Variables](#environment-variables)

---

## How It Works

### Architecture

The app implements an **iterative tool-calling agent loop**:

1. The user asks a question via the React frontend.
2. The Quart backend sends the question (plus chat history) to Azure OpenAI with 3 tool definitions.
3. The LLM reads the data dictionary in its system prompt and decides which tool(s) to call and with what parameters.
4. The backend executes the tool call(s) against Azure AI Search and returns the results to the LLM.
5. The LLM inspects results — if it has enough context, it synthesizes an answer; otherwise it makes more tool calls (up to 8 iterations).
6. The final answer is returned with citations extracted from all documents fetched across all tool calls.
7. Conversation history is persisted via the Foundry Conversations API (or CosmosDB as a fallback).

### Key Design Decisions

- **Content-agnostic system prompt** — contains no hardcoded project/video names or document counts. All examples use `<user's term>` placeholders. The agent discovers everything through its tools.
- **Title resolution pattern** — the agent always searches first to resolve exact titles before using OData `eq` filters (prevents mismatches when titles are longer than expected).
- **No result truncation** — `select` controls result size instead of post-hoc truncation that could silently cut off search results.
- **Fuzzy search toggle** — the agent can enable Lucene fuzzy matching (`~1` edit distance) when it suspects typos or gets zero results.
- **Segment retrieval pattern** — to retrieve specific segments (e.g. "first 2 segments"), the agent reads `segment_chronological_summary` first to learn segment titles, then filters chunks by `Voc_segment_title`. Segments ≠ chunks — each segment contains a variable number of chunks.
- **Efficiency rules** — the system prompt targets 1–2 tool calls for simple questions, 2–4 for complex ones.
- **Verbatim summary retrieval** — pre-generated `long_stakeholder_*_summary` fields are returned as-is for summary requests instead of searching chunks to manually build one.

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Backend** | Python 3.11+, [Quart](https://quart.palletsprojects.com/) (async Flask-compatible) |
| **Frontend** | React 18, TypeScript, Vite |
| **LLM** | Azure OpenAI (gpt-4.1 / gpt-5.1 — configurable via `CHAT_DEPLOYMENT`) |
| **Search** | Azure AI Search (REST API, `2024-07-01`) |
| **Embeddings** | `text-embedding-3-small` (1536d) via integrated vectorizer on the index |
| **Auth** | Azure DefaultAzureCredential (RBAC — no API keys) |
| **Chat history** | Foundry Conversations API (primary) or Azure CosmosDB (fallback) |
| **Containerisation** | Docker (multi-stage: Node build → Python runtime) |

### Python Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `quart` | 0.19.4 | Async web framework |
| `gunicorn` | 22.0.0 | Production WSGI server |
| `openai` | 1.98.0 | Azure OpenAI SDK (chat completions + tool calling) |
| `azure-identity` | 1.19.0 | DefaultAzureCredential for RBAC auth |
| `azure-cosmos` | 4.9.0 | CosmosDB client (fallback for chat history) |
| `requests` | 2.32.3 | HTTP calls to Azure AI Search REST API |
| `python-dotenv` | 1.0.1 | Load `.env` files |

---

## File Structure

```
hierarchical-search-chatbot/
├── app.py                          # Quart web server — API endpoints, static file serving
├── requirements.txt                # Python dependencies
├── .env.example                    # Environment variable template
├── gunicorn.conf.py                # Gunicorn config for production deployment
├── start.cmd / start.sh            # Launch scripts (Windows / Linux)
├── WebApp.Dockerfile               # Multi-stage Docker build (frontend + backend)
├── create_foundry_agent.py         # Script to create a Foundry agent (Approach A)
│
├── backend/
│   ├── __init__.py
│   ├── agent.py                    # Core agent logic: _execute_search(), _fuzzify(),
│   │                               #   tool schemas, system prompt, run_agent() loop,
│   │                               #   _build_citations()
│   ├── settings.py                 # Dataclass-based config (env var overrides)
│   ├── auth/
│   │   └── auth_utils.py           # Azure EasyAuth header extraction
│   └── history/
│       ├── foundry_threads.py      # Foundry Conversations API client (current)
│       └── cosmosdbservice.py      # CosmosDB conversation CRUD (fallback)
│
├── frontend/
│   ├── package.json                # Node dependencies and scripts
│   ├── vite.config.ts              # Vite dev server config (proxies /api to backend)
│   ├── index.html                  # HTML entry point
│   ├── tsconfig.json               # TypeScript config
│   └── src/
│       ├── index.tsx               # React entry point
│       ├── api/                    # API client functions
│       ├── assets/                 # Static assets (logos, icons)
│       ├── components/
│       │   ├── Answer/             # Citation rendering with hierarchical highlights
│       │   ├── ChatHistory/        # Conversation list sidebar
│       │   └── QuestionInput/      # Chat input box
│       ├── pages/
│       │   ├── chat/               # Main chat interface
│       │   └── layout/             # App layout wrapper
│       └── state/                  # AppProvider + reducer (React context)
│
├── notebook_version/
│   ├── .env                        # Notebook-specific env vars
│   └── hierarchical_mcp_agent_improved.ipynb
│                                   # Standalone notebook version of the agent
│                                   #   — same tools, system prompt, and search logic
│                                   #   — single-turn (no chat history)
│
└── static/                         # Built frontend output (generated by npm run build)
    ├── index.html
    └── assets/
```

---

## AI Search Index Data Dictionary

**Index**: `video-transcripts-hierarchical-v2`
**API Version**: `2024-07-01`

The index has **3 hierarchy levels** in a single flat index, differentiated by `doc_type`:

```
Project (doc_type='project')  ──  2 docs
   └── VoC (doc_type='voc')   ──  12 docs  (one per video recording)
        └── Chunk (doc_type='chunk')  ──  395 docs  (timestamped transcript passages)
                                          Total: 409 documents
```

### Shared Fields (all levels)

| Field | Type | Filterable | Searchable | Description |
|-------|------|------------|------------|-------------|
| `id` | String | ✅ | — | SHA-256 hash (48 chars) |
| `doc_type` | String | ✅ | — | `"project"`, `"voc"`, or `"chunk"` |
| `parent_id` | String | ✅ | — | Immediate parent's `id` |
| `project_id` | String | ✅ | — | Project doc's `id` (all levels) |
| `project_title` | String | ✅ | ✅ | Human-readable project name (denormalised) |

### Project Level

| Field | Type | Filterable | Searchable | Vector | Description |
|-------|------|------------|------------|--------|-------------|
| `short_project_summary` | String | — | ✅ | ✅ (1536d) | 1–3 sentence summary |
| `long_stakeholder_project_summary` | String | — | — | — | 500–700 word structured markdown summary |
| `num_VoCs` | Int32 | ✅ | — | — | Count of VoCs in this project |
| `project_key_words` | Collection(String) | ✅ | ✅ | — | Aggregated keywords |
| `project_product_names` | Collection(String) | ✅ | ✅ | — | Aggregated product names |

**Semantic config**: `project-semantic` — content: `short_project_summary`, title: `project_title`

### VoC Level (one doc per video)

| Field | Type | Filterable | Searchable | Vector | Description |
|-------|------|------------|------------|--------|-------------|
| `voc_id` | String | ✅ | — | — | Self-referencing ID (same as `id`) |
| `VoC_title` | String | ✅ | ✅ | — | Video/meeting recording title |
| `short_VoC_summary` | String | — | ✅ | ✅ (1536d) | 1–3 sentence summary |
| `segment_chronological_summary` | String | — | ✅ | — | Full segment-by-segment timestamped summary |
| `long_stakeholder_VoC_summary` | String | — | — | — | 500–700 word structured markdown summary |
| `voc_category` | String | ✅ | — | — | `"exploratory"` / `"operational"` / `"combinational"` |
| `short_project_summary_denorm` | String | — | ✅ | — | Denormalised from parent project |
| `Video_key_words` | Collection(String) | ✅ | ✅ | — | Keywords from this video |
| `Video_product_names` | Collection(String) | ✅ | ✅ | — | Product names from this video |

**Semantic config**: `voc-semantic` — content: `short_VoC_summary` + `segment_chronological_summary` + `short_project_summary_denorm` + `project_title`, title: `VoC_title`

### Chunk Level (transcript passages)

| Field | Type | Filterable | Searchable | Vector | Description |
|-------|------|------------|------------|--------|-------------|
| `chunk_index` | Int32 | ✅ (sortable) | — | — | 0-based position within VoC |
| `chunk_text` | String | — | ✅ | ✅ (1536d) | PII-scrubbed transcript passage (~512 tokens) |
| `chunk_start_time` | String | ✅ | — | — | Timestamp of first line (`hh:mm:ss`) |
| `chunk_end_time` | String | ✅ | — | — | Timestamp of last line |
| `VoC_title` | String | ✅ | ✅ | — | Denormalised from parent VoC |
| `Voc_segment_title` | String | ✅ | ✅ | — | Segment label this chunk belongs to |
| `Voc_segment_summary` | String | — | ✅ | ✅ (1536d) | RAG-optimised segment summary |
| `Voc_segment_start_time` | String | ✅ | — | — | Segment start timestamp |
| `Voc_segment_end_time` | String | ✅ | — | — | Segment end timestamp |
| `short_VoC_summary` | String | — | ✅ | — | Denormalised from parent VoC |
| `voc_category` | String | ✅ | — | — | Denormalised from parent VoC |

**Semantic config**: `chunk-semantic` — content: `chunk_text` + `Voc_segment_summary` + `short_VoC_summary`, title: `VoC_title`, keywords: `Voc_segment_title` + `project_title`

### Linking Fields

| Direction | Filter Expression |
|-----------|-------------------|
| All projects | `doc_type eq 'project'` |
| VoCs in a project | `doc_type eq 'voc' and project_id eq '{id}'` |
| Chunks in a VoC | `doc_type eq 'chunk' and voc_id eq '{id}'` |
| Chunks in a project | `doc_type eq 'chunk' and project_id eq '{id}'` |

---

## Agent Tools

The agent has **3 generic search tools**, one per hierarchy level. All share the same parameter schema:

| Tool | Purpose |
|------|---------|
| `search_projects` | Search project-level docs (summaries, keywords, product names) |
| `search_vocs` | Search VoC/video-level docs (titles, summaries, categories) |
| `search_chunks` | Search chunk-level docs (timestamped transcript passages) |

### Shared Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `search_text` | string | Full-text query. `"*"` = match all |
| `filter` | string | OData `$filter` expression (AND'd with auto `doc_type` filter) |
| `select` | string | Comma-separated fields to return |
| `search_fields` | string | Comma-separated searchable fields to target |
| `query_type` | enum | `"simple"` (keyword), `"full"` (Lucene), `"semantic"` (AI reranker) |
| `use_vector` | boolean | Enable embedding-based vector search alongside text search |
| `vector_text` | string | Text to embed (defaults to `search_text`) |
| `vector_fields` | string | Override default vector field |
| `top` | integer | Max results to return |
| `orderby` | string | Sort expression (e.g. `chunk_index asc`) |
| `facets` | array | Facet expressions for aggregation |
| `include_count` | boolean | Include total matching count (default: true) |
| `fuzzy` | boolean | Enable Lucene fuzzy matching (~1 edit distance) for typo tolerance |
| `semantic_config` | string | Override default semantic config |

### Query Type Compatibility

| Combination | Possible? | Notes |
|-------------|-----------|-------|
| fuzzy + vector | ✅ | `queryType="full"` with `term~1` + `vectorQueries` |
| semantic + vector | ✅ | `queryType="semantic"` + `vectorQueries` — standard hybrid |
| fuzzy + semantic | ❌ | Both need different `queryType` values — mutually exclusive |
| All three | ❌ | Same reason |

> **Workaround**: If you need typo tolerance AND semantic reranking, use `use_vector=True` without `fuzzy` — vector search handles misspellings via embeddings, and the semantic reranker still ranks the results.

---

## Running the Notebook

The notebook version (`notebook_version/hierarchical_mcp_agent_improved.ipynb`) is a standalone single-turn agent — same tools, system prompt, and search logic as the web app, but without chat history or a UI.

### 1. Create a Python environment

Using conda:
```bash
conda create -n hierarchical-search python=3.11 ipykernel -y
conda activate hierarchical-search
pip install openai azure-identity requests python-dotenv pandas
```

Or using venv:
```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/Mac:
source .venv/bin/activate
pip install openai azure-identity requests python-dotenv pandas ipykernel
```

### 2. Configure the `.env` file

Create `notebook_version/.env` with:
```ini
SEARCH_ENDPOINT=https://your-search-service.search.windows.net
SEARCH_INDEX=video-transcripts-hierarchical-v2
AOAI_ENDPOINT=https://your-aoai-resource.openai.azure.com
CHAT_DEPLOYMENT=gpt-4.1
```

**Finding your model deployment**:
1. Go to [Azure AI Foundry](https://ai.azure.com) → select your project
2. Go to **Models + endpoints** → **Deployments**
3. Find or create a deployment of `gpt-4.1` (or `gpt-4o`, `gpt-5.1`, etc.)
4. Copy the deployment name → use as `CHAT_DEPLOYMENT`
5. Copy the endpoint URL → use as `AOAI_ENDPOINT`

> The AI Search index (`video-transcripts-hierarchical-v2`) is shared — you only need to configure your own AOAI endpoint and deployment.

### 3. Authenticate

Make sure you're logged in with the correct identity:
```bash
az login
```

Your identity needs:
- **Cognitive Services OpenAI User** on the Azure OpenAI resource
- **Search Index Data Reader** on the Azure AI Search service

### 4. Run the notebook

Open `notebook_version/hierarchical_mcp_agent_improved.ipynb` in VS Code and run all cells.

---

## Running the Web App

### 1. Create a Python environment

```bash
conda create -n hierarchical-search python=3.11 -y
conda activate hierarchical-search
pip install -r requirements.txt
```

Or using venv:
```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/Mac:
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure the `.env` file

Copy `.env.example` to `.env` and fill in your values:

```ini
# Required
SEARCH_ENDPOINT=https://your-search-service.search.windows.net
AOAI_ENDPOINT=https://your-aoai-resource.openai.azure.com
CHAT_DEPLOYMENT=gpt-4.1

# Optional — for conversation history via Foundry
FOUNDRY_PROJECT_ENDPOINT=https://your-project.services.ai.azure.com
FOUNDRY_AGENT_NAME=your-agent-name
```

See [Finding your model deployment](#2-configure-the-env-file) in the notebook section above for how to locate your AOAI endpoint and deployment name.

### 3. Install and build the frontend

```bash
cd frontend
npm install
npm run build
cd ..
```

This outputs built files to `static/` which the Quart server serves directly.

### 4. Authenticate

```bash
az login
```

Same RBAC roles as the notebook (Cognitive Services OpenAI User + Search Index Data Reader).

### 5. Start the app

```bash
python app.py
```

The app starts on `http://localhost:5000`.

### Development mode (with hot reload)

```bash
# Terminal 1: Backend
python app.py

# Terminal 2: Frontend dev server (proxies to backend)
cd frontend
npm run dev
```

The Vite dev server runs on `http://localhost:5173` and proxies API calls to the backend.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SEARCH_ENDPOINT` | ✅ | — | Azure AI Search endpoint URL |
| `SEARCH_INDEX` | — | `video-transcripts-hierarchical-v2` | Index name |
| `AOAI_ENDPOINT` | ✅ | — | Azure OpenAI endpoint URL |
| `CHAT_DEPLOYMENT` | — | `gpt-5.1` | Chat model deployment name |
| `AZURE_OPENAI_TEMPERATURE` | — | `0` | LLM temperature |
| `AZURE_OPENAI_MAX_TOKENS` | — | `4096` | Max output tokens |
| `MAX_ITERATIONS` | — | `8` | Max tool-calling iterations |
| `FOUNDRY_PROJECT_ENDPOINT` | — | — | Foundry project endpoint (for chat history) |
| `FOUNDRY_AGENT_NAME` | — | `lyra-testing` | Foundry agent name |
| `AUTH_ENABLED` | — | `false` | Enable Azure EasyAuth |
| `UI_TITLE` | — | `Hierarchical Search` | Browser tab title |
| `UI_CHAT_TITLE` | — | `Video Transcript Explorer` | Chat header title |
