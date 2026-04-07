# Development Journey

This document traces the full pipeline — from raw video recordings to a working agentic chatbot — including what was built, in what order, and key lessons learned along the way.

---

## Table of Contents

- [Pipeline Overview](#pipeline-overview)
- [Step-by-Step Build Log](#step-by-step-build-log)
  - [Phase 1: Data Extraction & Enrichment](#phase-1-data-extraction--enrichment)
  - [Phase 2: Index Schema & Ingestion](#phase-2-index-schema--ingestion)
  - [Phase 3: Agent Development (Notebook)](#phase-3-agent-development-notebook)
  - [Phase 4: Chatbot App](#phase-4-chatbot-app)
- [Foundry Integration — 3 Approaches](#foundry-integration--3-approaches)
- [Design Decisions](#design-decisions)
- [Troubleshooting Notes](#troubleshooting-notes)

---

## Pipeline Overview

```
Raw Videos (Azure Video Indexer)
    │
    ▼
extract_transcripts.py          ── 12 .txt transcript files
    │
    ▼
generate_video_metadata.py      ── segment_chronological_summary, keywords, product names, segments[]
    │
    ▼
generate_voc_summaries.py       ── short_VoC_summary, long_stakeholder_VoC_summary, voc_category
    │
    ▼
generate_project_metadata.py    ── short_project_summary, long_stakeholder_project_summary, project keywords/products
    │
    ▼
restructure_metadata.py         ── Merge flat JSON → nested {project → VoCs} structure
    │
    ▼
generate_segment_summaries.py   ── RAG-optimised Voc_segment_summary per segment
    │
    ▼
ingest_chunks.py                ── PII-scrub transcripts, chunk (~512 tokens), embed, upload to AI Search
    │
    ▼
backfill_hierarchy.py           ── Upload project + VoC docs to same index
    │
    ▼
Notebook Agent (v1 → v2)        ── Prototype MCP-style agent with iterative tool calling
    │
    ▼
Chatbot App                     ── Quart + React web app wrapping the notebook agent
```

---

## Step-by-Step Build Log

### Phase 1: Data Extraction & Enrichment

#### 1. Transcript Extraction
- **Script**: `extract_transcripts.py`
- **Source**: Azure Video Indexer (12 videos across 2 projects: ATUM and Thunderstruck)
- **Output**: `transcripts/ATUM/*.txt` (6 files), `transcripts/Thunderstruck/*.txt` (6 files)
- **Resume map**: `video_indexer_ids.json` stores Video Indexer IDs for re-extraction

#### 2. Video Metadata Generation
- **Script**: `generate_video_metadata.py`
- GPT-4.1 processes each full PII-scrubbed transcript to produce:
  - `segment_chronological_summary` — timestamped segment-by-segment summary
  - `video_key_words`, `video_product_names` — extracted keywords and product mentions
  - `segments[]` — segment boundaries with start/end times and labels
- **Output**: `video_metadata.json` with 12 entries

#### 3. VoC Summary Generation
- **Script**: `generate_voc_summaries.py`
- Classifies each VoC as `exploratory`, `operational`, or `combinational` → routes to matching prompt template
- Generates per VoC:
  - `voc_category` — classification
  - `short_VoC_summary` — 1–3 sentence summary
  - `long_stakeholder_VoC_summary` — 500–700 word structured markdown summary
- Resume-safe: skips videos that already have all fields

#### 4. Project Metadata Generation
- **Script**: `generate_project_metadata.py`
- Groups VoCs by project, generates per project:
  - `short_project_summary`, `long_stakeholder_project_summary`
  - `project_key_words`, `project_product_names` (deduplicated unions)
  - `num_VoCs`
- **Output**: `project_metadata.json`

#### 5. Metadata Restructuring
- **Script**: `restructure_metadata.py`
- Merges flat `video_metadata.json` + `project_metadata.json` into nested `{project → {project fields + vocs: {filename → VoC fields}}}`
- Backs up original to `video_metadata_flat_backup.json`

#### 6. RAG-Optimised Segment Summaries
- **Script**: `generate_segment_summaries.py`
- For each VoC, parses segment text from `segment_chronological_summary`, then GPT-4.1 rewrites each as a RAG-optimised summary
- Adds `Voc_segment_summary` to each segment in `video_metadata.json`
- 85 segments across 12 VoCs, 100% matched
- Features: `--force` flag, retry logic (3× with exponential backoff), crash-recovery (saves after each VoC)

---

### Phase 2: Index Schema & Ingestion

#### 7. V1 Index Creation + Chunk Ingestion
- **Script**: `ingest_chunks.py`
- Created index `video-transcripts-hierarchical-v1`
- PII-scrubs transcripts in-memory (originals never modified), chunks at ~512 tokens with 64-token overlap
- Embeds with `text-embedding-3-small` (1536d), uploads chunk docs

#### 8. V2 Schema Redesign + Re-Ingestion
- Azure AI Search does not allow changing existing field attributes, so the V1 index was deleted and recreated as `video-transcripts-hierarchical-v2`
- Schema improvements:
  - `project_title`: added `searchable` + `filterable`
  - `Voc_segment_start_time` / `Voc_segment_end_time`: added `filterable`
  - `short_project_summary_denorm`: added `searchable`
  - Semantic configs updated: `chunk-semantic` gained `short_VoC_summary` in content fields and `project_title` in keyword fields; `voc-semantic` gained `short_project_summary_denorm` and `project_title`
  - `voc_category`: denormalised onto chunk docs (was VoC-only)
- **Result**: 395 chunk documents (139 ATUM + 256 Thunderstruck)

#### 9. Hierarchy Backfill
- **Script**: `backfill_hierarchy.py`
- Uploaded 2 project docs + 12 VoC docs → **409 total documents**

---

### Phase 3: Agent Development (Notebook)

#### 10. V1 Notebook — Rigid Tool Agent
- **Notebook**: `hierarchical_mcp_agent.ipynb`
- 5+ hardcoded tools: `list_projects`, `list_videos`, `search_chunks`, `get_video_info`, `get_project_info`, `get_index_overview`
- Fixed select/filter/semantic configs per tool — LLM had limited control

#### 11. V2 Notebook — Generic Tool Agent (primary)
- **Notebook**: `hierarchical_mcp_agent_improved.ipynb`
- Complete rewrite: 3 generic search tools (`search_projects`, `search_vocs`, `search_chunks`) exposing the full Azure AI Search query surface as parameters
- Content-agnostic system prompt with data dictionary, query patterns, efficiency rules
- LLM decides all query parameters (query type, vector, OData filters, field selection, facets, sort, top, fuzzy)
- Validated with 8+ test queries covering overview, scoped search, cross-project comparison, topic search, product search

#### 12. Model Upgrade to gpt-5.1
- Switched from `gpt-4.1` on `r-eastus2-poc-exp` to `gpt-5.1` on `sample-proj-resource`
- Both resources are in the same resource group

#### 13. Fuzzy Search Support
- **Problem**: Semantic search failed on misspelled queries (e.g. "thiunderstruck" → 0 results) because the BM25 first-pass returns nothing on typos, and the semantic reranker has nothing to rerank
- **Solution**: Added `fuzzy` toggle — Lucene `~1` edit-distance matching. `_fuzzify()` helper appends `~1` to each word while preserving quoted phrases, boolean operators, and wildcards
- System prompt updated: model tries without fuzzy first, uses as fallback on zero results

#### 14. Query Type Combo Restrictions
- Documented in system prompt: `fuzzy + vector` ✅, `semantic + vector` ✅, `fuzzy + semantic` ❌ (both need different `queryType` values)
- Workaround: use `use_vector=True` without `fuzzy` for typo tolerance + semantic reranking

#### 15. Segment Retrieval Pattern
- **Problem**: "Summarize first 2 segments" failed because segments ≠ chunks — each segment contains a variable number of chunks, so `chunk_index` can't identify segment boundaries
- **Solution**: 2-step pattern in system prompt: (1) get `segment_chronological_summary` to learn segment titles → (2) filter chunks by `Voc_segment_title`

---

### Phase 4: Chatbot App

#### 16. Web App Created
- Full Quart backend + React frontend replicating the notebook agent as a chatbot
- Same 3 generic search tools, tool-calling loop, and system prompt
- Citation rendering: bold VoC names as clickable pills, product names highlighted in gold
- Initially used CosmosDB for conversation memory

#### 17. Foundry Conversations API Integration
- Migrated from CosmosDB to Foundry Conversations API for chat history (Approach B)
- `backend/history/foundry_threads.py` replaced `cosmosdbservice.py` as primary
- Agent pulls history from Foundry thread before each turn, writes assistant response after

#### 18. System Prompt Sync
- Applied all notebook improvements back to the chatbot app:
  - Fuzzy search toggle + `_fuzzify()` function
  - Query type combo restrictions (COMPATIBILITY NOTE)
  - Segment retrieval pattern
  - Multi-turn context rules (Rules 4, 13, 14, 15 — chatbot-only)

---

## Foundry Integration — 3 Approaches

| Feature | A: Full Foundry | B: Foundry Memory (current) | C: Manual |
|---|---|---|---|
| Tool-calling loop | Foundry | Local Python | Local Python |
| Memory | Foundry Conversations API | Foundry Conversations API | CosmosDB |
| Playground support | ✅ | ❌ | ❌ |
| Tracing | ✅ Built-in | ❌ | ❌ |
| Tools hosted remotely | ✅ Required | ❌ Local functions | ❌ Local functions |
| Deployment complexity | High | Low | Medium |
| Control over tool loop | Limited | Full | Full |

### Approach A: Full Foundry (not yet tried)
Foundry runs everything — tool-calling loop, memory, model selection. Tools must be hosted remotely (FastAPI or Azure Functions) and registered as OpenAPI or MCP tools on a Foundry Prompt Agent.

### Approach B: Foundry as Memory Only (current) ✅
Local Python runs the tool-calling loop. Foundry is used purely for conversation memory via the Conversations API. Simplest to set up, full control over tool-calling, no remote hosting required.

### Approach C: Fully Manual (original, before Approach B)
Everything managed locally — CosmosDB for memory, no Foundry at all. To revert: swap `foundry_threads.py` back to `cosmosdbservice.py` and restore CosmosDB env vars.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Original transcripts never modified** | PII removal happens in-memory at index time only |
| **3-level hierarchy in a single flat index** | Azure AI Search has no joins — denormalised parent fields keep each level self-contained |
| **Denormalised text fields are searchable** | `short_VoC_summary` and `project_title` on chunk docs are included in `chunk-semantic` config, so the semantic reranker uses VoC-level context even in flat queries |
| **Vector fields NOT denormalised to chunks** | In the MCP agent workflow, the agent queries VoC and chunk levels separately. Adding `short_VoC_summary_vector` to 395 chunks would only help flat single-shot RAG — a future optimisation if recall testing shows a gap |
| **Content-agnostic system prompt** | No hardcoded names or counts — the agent discovers everything through its tools. Scales to new data without prompt changes |
| **3 generic tools instead of 5+ specialised ones** | Fewer tools = simpler schema, less confusion. Full query surface exposed as parameters gives the LLM more flexibility |
| **No result truncation** | Previous 6000-char truncation silently cut off results. `select` controls result size instead |
| **Title resolution before OData filters** | Prevents mismatches like `project_title eq 'ATUM'` when the actual title is `'ATUM (Ra III 1500V Solar)'` |
| **Fuzzy as a model-controlled toggle** | Not mandatory — model tries without fuzzy first, uses as fallback on zero results |
| **Segment retrieval via title lookup** | Segments ≠ chunks; `chunk_index` cannot identify segment boundaries. Using `segment_chronological_summary` → `Voc_segment_title` filter is reliable |

---

## Troubleshooting Notes

### Unicode escape error in Python docstrings
**Symptom**: `SyntaxError: (unicode error) 'unicodeescape' codec can't decode bytes` on scripts containing Windows paths like `C:\Users\...` in docstrings.
**Fix**: Replace backslashes with forward slashes in docstring paths (`C:/Users/...`).

### GPT returns malformed JSON with literal newlines
**Symptom**: `json.loads()` fails on LLM-generated JSON because the model puts actual newlines inside string values.
**Fix**: Add a fallback JSON parser that escapes literal newlines before parsing.

### PII extraction 400 error on large samples
**Symptom**: Azure OpenAI returns HTTP 400 when the PII extraction module sends too large a text sample.
**Fix**: Retry with a smaller text sample on 400 errors.

### Segment count anchoring
**Symptom**: All 12 VoCs produce exactly 7 segments despite transcript sizes ranging from 24KB to 214KB.
**Cause**: The prompt said "Aim for 3–7 segments" — GPT anchored on the upper bound.
**Fix**: Removed the fixed range from the prompt. Now instructs GPT to divide based on natural topic progression. Existing segments are not regenerated — takes effect on new runs or with `--force`.

### Azure AI Search field attribute constraint
**Symptom**: Cannot add `searchable: True` to an existing field that was created without it.
**Cause**: Azure AI Search does not allow changing existing field attributes after index creation.
**Fix**: Delete and recreate the index with the corrected schema, then re-ingest all documents. For long embedding runs, disable laptop sleep with `powercfg /change standby-timeout-ac 0`.

### Fuzzy + semantic are mutually exclusive
**Symptom**: Setting `fuzzy=True` with `query_type="semantic"` silently upgrades `queryType` to `"full"`, losing the semantic reranker.
**Cause**: `queryType` is a single enum — `"full"` (required for Lucene `~1` syntax) and `"semantic"` cannot coexist.
**Workaround**: Use `use_vector=True` without `fuzzy` to get both typo tolerance (via embeddings) and semantic reranking.

### Semantic search fails on typos
**Symptom**: Searching for "thiunderstruck" returns 0 results even with `query_type="semantic"`.
**Cause**: Semantic search is a 2-stage pipeline — BM25 keyword retrieval first, then transformer reranker. If BM25 returns nothing (no keyword match), the reranker has nothing to work with.
**Fix**: Enable `fuzzy=True` (Lucene edit-distance matching) or `use_vector=True` (embedding similarity handles misspellings).

### "Summarize first N segments" returns wrong content
**Symptom**: Agent fetches chunks by `chunk_index` order, but the returned chunks don't align with segment boundaries.
**Cause**: Segments ≠ chunks. Each segment contains a variable number of chunks—`chunk_index` is a global position, not a segment identifier.
**Fix**: Use the 2-step segment retrieval pattern: (1) get `segment_chronological_summary` from the VoC doc to learn segment titles, (2) filter chunks by `Voc_segment_title eq '<exact title>'`.
