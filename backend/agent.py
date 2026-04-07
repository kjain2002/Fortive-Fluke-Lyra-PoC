"""
Hierarchical Search Agent — tool-calling agent that mirrors the notebook logic exactly.

The agent has 3 generic search tools (search_projects, search_vocs, search_chunks)
with full Azure AI Search query surface as toggles. The LLM crafts queries, inspects
results, and iterates until it has enough context — true MCP-style tool use.
"""
import json
import os
import re
import requests
from typing import Optional

from azure.identity import DefaultAzureCredential
from azure.ai.projects import AIProjectClient

from backend.settings import AppSettings

# ── Globals initialised at import time ──────────────────────────────────────────

_credential = DefaultAzureCredential()
_settings: Optional[AppSettings] = None
_client = None  # OpenAI client obtained from Foundry project

DEFAULT_SEMANTIC = {"project": "project-semantic", "voc": "voc-semantic", "chunk": "chunk-semantic"}
DEFAULT_VECTOR = {
    "project": "short_project_summary_vector",
    "voc": "short_VoC_summary_vector",
    "chunk": "chunk_text_vector",
}


def init_agent(settings: AppSettings):
    """Initialise the OpenAI client via Foundry project. Called once from app startup."""
    global _settings, _client
    _settings = settings
    project_client = AIProjectClient(
        endpoint=settings.foundry.project_endpoint,
        credential=_credential,
    )
    _client = project_client.get_openai_client()


def create_conversation() -> str:
    """Create a new Foundry conversation and return its ID."""
    return _client.conversations.create().id


# ── Search helpers ──────────────────────────────────────────────────────────────

def _search_headers():
    token = _credential.get_token("https://search.azure.com/.default").token
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _search_index(body: dict) -> dict:
    url = (
        f"{_settings.search.endpoint}/indexes/{_settings.search.index}"
        f"/docs/search?api-version={_settings.search.api_version}"
    )
    r = requests.post(url, headers=_search_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def _fuzzify(search_text: str) -> str:
    """Append ~1 to each word for Lucene fuzzy matching. Preserves quoted phrases."""
    if search_text == "*":
        return search_text
    parts = []
    in_quote = False
    for token in re.split(r'(\s+|")', search_text):
        if token == '"':
            in_quote = not in_quote
            parts.append(token)
        elif in_quote or not token.strip():
            parts.append(token)
        elif token.endswith("~") or token.endswith("~1") or token.endswith("~2"):
            parts.append(token)  # already fuzzy
        elif token in ("+", "-", "|", "AND", "OR", "NOT"):
            parts.append(token)  # boolean operators
        else:
            parts.append(f"{token}~1")
    return "".join(parts)


def _execute_search(
    doc_type: str,
    search_text: str = "*",
    filter: str = None,
    select: str = None,
    search_fields: str = None,
    query_type: str = "simple",
    semantic_config: str = None,
    use_vector: bool = False,
    vector_text: str = None,
    vector_fields: str = None,
    top: int = 10,
    orderby: str = None,
    facets: list = None,
    include_count: bool = True,
    fuzzy: bool = False,
) -> str:
    """Build and execute an Azure AI Search query scoped to a doc_type."""
    base_filter = f"doc_type eq '{doc_type}'"
    if filter:
        base_filter += f" and ({filter})"

    effective_query_type = query_type
    effective_search_text = search_text

    if fuzzy and search_text != "*":
        effective_search_text = _fuzzify(search_text)
        if query_type == "simple":
            effective_query_type = "full"  # fuzzy requires Lucene syntax

    body = {
        "search": effective_search_text,
        "filter": base_filter,
        "top": top,
        "count": include_count,
    }
    if select:
        body["select"] = select
    if search_fields:
        body["searchFields"] = search_fields
    if orderby:
        body["orderby"] = orderby

    if effective_query_type == "semantic":
        body["queryType"] = "semantic"
        body["semanticConfiguration"] = semantic_config or DEFAULT_SEMANTIC[doc_type]
    elif effective_query_type == "full":
        body["queryType"] = "full"

    if use_vector:
        v_fields = vector_fields or DEFAULT_VECTOR[doc_type]
        v_text = vector_text or search_text  # use original text for vector, not fuzzified
        body["vectorQueries"] = [{"kind": "text", "text": v_text, "fields": v_fields, "k": top}]

    if facets:
        body["facets"] = facets if isinstance(facets, list) else [facets]

    resp = _search_index(body)
    results = resp.get("value", [])

    output = {}
    if include_count:
        output["count"] = resp.get("@odata.count")
    if facets and "@search.facets" in resp:
        output["facets"] = resp["@search.facets"]
    output["results"] = results

    return json.dumps(output, indent=2)


TOOL_DISPATCH = {
    "search_projects": lambda **kw: _execute_search("project", **kw),
    "search_vocs": lambda **kw: _execute_search("voc", **kw),
    "search_chunks": lambda **kw: _execute_search("chunk", **kw),
}


# ── Tool schemas (identical to notebook) ────────────────────────────────────────

_SEARCH_PARAMS = {
    "search_text": {
        "type": "string",
        "description": "Full-text search query. Use '*' for match-all. Simple syntax supports +required -excluded | OR \"exact phrase\". Full (Lucene) syntax adds field:value, wildcards, fuzzy~, proximity~N, regex /pattern/.",
    },
    "filter": {
        "type": "string",
        "description": "OData $filter expression (AND'd with the auto doc_type filter). Examples: \"project_id eq 'abc123'\", \"voc_category eq 'exploratory'\", \"Video_key_words/any(k: k eq 'IV curve')\". See data dictionary for filterable fields.",
    },
    "select": {
        "type": "string",
        "description": "Comma-separated field names to return. Omit to get all retrievable fields. Use this to keep responses small — request only what you need.",
    },
    "search_fields": {
        "type": "string",
        "description": "Comma-separated searchable fields to target with search_text. Omit to search all searchable fields. Use for precision: e.g. 'VoC_title' to match on title only.",
    },
    "query_type": {
        "type": "string",
        "enum": ["simple", "full", "semantic"],
        "description": "simple: keyword matching (default). full: Lucene syntax (field:, regex, fuzzy). semantic: activates AI semantic reranker for meaning-based relevance.",
    },
    "semantic_config": {
        "type": "string",
        "description": "Override semantic configuration. Only used when query_type='semantic'. Defaults: project-semantic, voc-semantic, chunk-semantic.",
    },
    "use_vector": {
        "type": "boolean",
        "description": "Enable vector (embedding) search alongside text search for hybrid retrieval. Default false.",
    },
    "vector_text": {
        "type": "string",
        "description": "Text to embed for vector search. Defaults to search_text. Set separately when search_text uses filter syntax or '*'.",
    },
    "vector_fields": {
        "type": "string",
        "description": "Vector field to search. Defaults per level: short_project_summary_vector (project), short_VoC_summary_vector (voc), chunk_text_vector (chunk). Chunks also have Voc_segment_summary_vector.",
    },
    "top": {
        "type": "integer",
        "description": "Max results to return.",
    },
    "orderby": {
        "type": "string",
        "description": "Sort expression, e.g. 'chunk_index asc'. Only works on sortable fields.",
    },
    "facets": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Facet expressions for aggregation, e.g. ['voc_category', 'project_title']. Returns value counts.",
    },
    "include_count": {
        "type": "boolean",
        "description": "Include total matching document count in response. Default true.",
    },
    "fuzzy": {
        "type": "boolean",
        "description": "Enable fuzzy matching (edit distance 1) for typo tolerance. Recommended when searching by name or title (project_title, VoC_title) and you suspect typos or get zero results. Automatically converts to Lucene syntax. Default false.",
    },
}

TOOLS = [
    {
        "type": "function",
        "name": "search_projects",
        "description": (
            "Search project-level documents (doc_type='project'). "
            "Searchable fields: project_title, short_project_summary, project_key_words, project_product_names. "
            "Filterable: id, project_title, num_VoCs, project_key_words, project_product_names. "
            "Vector: short_project_summary_vector. Semantic config: project-semantic. "
            "Key retrievable fields: id, project_title, short_project_summary, long_stakeholder_project_summary, num_VoCs, project_key_words, project_product_names."
        ),
        "parameters": {
            "type": "object",
            "properties": _SEARCH_PARAMS,
            "required": [],
        },
    },
    {
        "type": "function",
        "name": "search_vocs",
        "description": (
            "Search VoC/video-level documents (doc_type='voc'). "
            "Searchable fields: VoC_title, short_VoC_summary, segment_chronological_summary, short_project_summary_denorm, project_title, Video_key_words, Video_product_names. "
            "Filterable: id, voc_id, project_id, project_title, VoC_title, voc_category, Video_product_names, Video_key_words. "
            "Vector: short_VoC_summary_vector. Semantic config: voc-semantic (title=VoC_title, content=short_VoC_summary+segment_chronological_summary+short_project_summary_denorm+project_title). "
            "Key retrievable fields: id, voc_id, VoC_title, project_title, short_VoC_summary, segment_chronological_summary, long_stakeholder_VoC_summary, voc_category, Video_key_words, Video_product_names."
        ),
        "parameters": {
            "type": "object",
            "properties": _SEARCH_PARAMS,
            "required": [],
        },
    },
    {
        "type": "function",
        "name": "search_chunks",
        "description": (
            "Search chunk-level documents (doc_type='chunk') — timestamped transcript passages. "
            "Searchable fields: chunk_text, VoC_title, project_title, Voc_segment_title, Voc_segment_summary, short_VoC_summary. "
            "Filterable: id, project_id, voc_id, project_title, VoC_title, Voc_segment_title, chunk_index, chunk_start_time, chunk_end_time, voc_category. "
            "Vectors: chunk_text_vector (default), Voc_segment_summary_vector. Semantic config: chunk-semantic. "
            "Key retrievable fields: id, chunk_index, chunk_text, chunk_start_time, chunk_end_time, VoC_title, project_title, Voc_segment_title, Voc_segment_summary, short_VoC_summary, voc_category."
        ),
        "parameters": {
            "type": "object",
            "properties": _SEARCH_PARAMS,
            "required": [],
        },
    },
]


# ── System prompt (identical to notebook) ───────────────────────────────────────

SYSTEM_PROMPT = """You are a research assistant with access to a hierarchical Azure AI Search index
of meeting video transcripts. You have 3 search tools and full control over how to query.
Think of yourself as an MCP client: craft the right query, inspect results, refine, and iterate
until you have enough context to answer.

You do NOT know what projects, videos, or content exist in the index. You must discover
everything through your tools.

═══════════════════════════════════════════════════════════════
TOOLS
═══════════════════════════════════════════════════════════════

1. search_projects(...)  — search project-level docs
2. search_vocs(...)      — search VoC/video-level docs
3. search_chunks(...)    — search chunk-level docs (transcript passages)

All 3 tools share the same query toggles. You control the full search surface:
text queries, OData filters, field selection, query type, vector search, facets, etc.

═══════════════════════════════════════════════════════════════
DATA DICTIONARY
═══════════════════════════════════════════════════════════════

The index has 3 hierarchy levels, all in one flat index differentiated by doc_type:

PROJECT (doc_type='project')
  Searchable:  project_title, short_project_summary, project_key_words, project_product_names
  Filterable:  id, project_title, num_VoCs, project_key_words, project_product_names
  Retrievable: id, project_title, short_project_summary, long_stakeholder_project_summary,
               num_VoCs, project_key_words, project_product_names
  Vector:      short_project_summary_vector (1536d, source: short_project_summary)
  Semantic:    project-semantic (content=short_project_summary, title=project_title,
               keywords=project_key_words+project_product_names)

VOC (doc_type='voc') — one doc per video recording
  Searchable:  VoC_title, short_VoC_summary, segment_chronological_summary,
               short_project_summary_denorm, project_title, Video_key_words, Video_product_names
  Filterable:  id, voc_id, project_id, project_title, VoC_title, voc_category,
               Video_product_names, Video_key_words
  Retrievable: id, voc_id, VoC_title, project_title, short_VoC_summary,
               segment_chronological_summary, long_stakeholder_VoC_summary, voc_category,
               short_project_summary_denorm, Video_product_names, Video_key_words
  Vector:      short_VoC_summary_vector (1536d, source: short_VoC_summary)
  Semantic:    voc-semantic (content=short_VoC_summary+segment_chronological_summary
               +short_project_summary_denorm+project_title, title=VoC_title,
               keywords=Video_key_words+Video_product_names)
  Categories:  voc_category ∈ {exploratory, operational, combinational}

CHUNK (doc_type='chunk') — timestamped transcript passages
  Searchable:  chunk_text, VoC_title, project_title, Voc_segment_title,
               Voc_segment_summary, short_VoC_summary
  Filterable:  id, project_id, voc_id, project_title, VoC_title, Voc_segment_title,
               chunk_index (sortable), chunk_start_time, chunk_end_time, voc_category,
               Voc_segment_start_time, Voc_segment_end_time
  Retrievable: id, chunk_index, chunk_text, chunk_start_time, chunk_end_time,
               VoC_title, project_title, Voc_segment_title, Voc_segment_summary,
               Voc_segment_start_time, Voc_segment_end_time, short_VoC_summary, voc_category
  Vectors:     chunk_text_vector (1536d, source: chunk_text) — DEFAULT
               Voc_segment_summary_vector (1536d, source: Voc_segment_summary)
  Semantic:    chunk-semantic (content=chunk_text+Voc_segment_summary+short_VoC_summary,
               title=VoC_title, keywords=Voc_segment_title+project_title)

LINKING FIELDS (present on VoC + Chunk docs):
  project_id → project doc's id    |  voc_id → VoC doc's id
  parent_id  → immediate parent's id

IDs are opaque SHA-256 hashes (48 chars), NOT human-readable titles.

IMPORTANT — TITLE FORMATS:
  project_title and VoC_title are full descriptive names, NOT short codes.
  You do NOT know their exact values. A user saying "project X" does NOT mean
  project_title eq 'X' — titles may be longer or formatted differently.
  NEVER hard-code a title value in an OData eq filter. Always resolve the exact
  value first via a search (see SCOPED SEARCH pattern below).

═══════════════════════════════════════════════════════════════
QUERY TOOLKIT — HOW TO USE THE TOGGLES
═══════════════════════════════════════════════════════════════

Each search tool accepts the same toggles. Pick the combination that fits your goal:

FINDING A VIDEO BY NAME:
  → search_vocs(search_text="<user's term>", search_fields="VoC_title",
      select="id,VoC_title", top=3)
  → If zero results or unsure about spelling, retry with fuzzy=True
     and/or use_vector=True for typo tolerance
  → Then get full summary: search_vocs(filter="id eq '<id_from_above>'",
      select="id,VoC_title,long_stakeholder_VoC_summary")

SUMMARIZING A PROJECT:
  → search_projects(search_text="<user's term>", search_fields="project_title",
      select="id,project_title", top=3)
  → If zero results or unsure about spelling, retry with fuzzy=True
     and/or use_vector=True for typo tolerance
  → Then: search_projects(filter="id eq '<resolved_id>'",
      select="id,project_title,long_stakeholder_project_summary")

TOPIC SEARCH ACROSS ALL CHUNKS:
  → search_chunks(search_text="<natural language question>", query_type="semantic",
      use_vector=True, top=10,
      select="id,chunk_text,VoC_title,project_title,chunk_start_time,chunk_end_time")

SCOPED SEARCH (within a specific project):
  Step 1 — resolve the project's exact title, id, and num_VoCs:
  → search_projects(search_text="<user's term>", search_fields="project_title",
      select="id,project_title,num_VoCs", top=3)
  → If zero results, retry with fuzzy=True and/or use_vector=True
  Step 2 — search with the resolved id (use num_VoCs to calibrate top):
  → search_chunks(search_text="<topic>", filter="project_id eq '<id_from_step1>'",
      query_type="semantic", use_vector=True, top=<adjust based on scope>,
      select="id,chunk_text,VoC_title,chunk_start_time,chunk_end_time,Voc_segment_title")

RETRIEVING SPECIFIC SEGMENTS OF A VIDEO:
  Segments ≠ chunks. Each segment contains multiple chunks. You do NOT know how
  many chunks each segment has, so you cannot use chunk_index to identify segments.
  Step 1 — resolve the VoC and get its segment structure:
  → search_vocs(search_text="<user's term>", search_fields="VoC_title",
      select="id,VoC_title,segment_chronological_summary", top=3)
  → The segment_chronological_summary field lists all segments in chronological
    order with their titles and timestamp ranges. Read it to identify the
    exact Voc_segment_title values for the requested segments (e.g. "first 2
    segments" = the first 2 segment titles listed in the summary).
  Step 2 — fetch chunks for those specific segments:
  → search_chunks(search_text="*",
      filter="voc_id eq '<id>' and Voc_segment_title eq '<segment_title>'",
      orderby="chunk_index asc", top=10,
      select="id,chunk_text,Voc_segment_title,Voc_segment_summary,chunk_start_time,chunk_end_time,chunk_index")
  → For multiple segments, make one call per segment or use:
    filter="voc_id eq '<id>' and (Voc_segment_title eq '<title1>' or Voc_segment_title eq '<title2>')"

LISTING ALL PROJECTS:
  → search_projects(search_text="*", select="id,project_title,num_VoCs",
      include_count=True)

LISTING VoCs IN A PROJECT:
  → search_vocs(search_text="*", filter="project_id eq '<id>'",
      select="id,VoC_title,voc_category", include_count=True)

COLLECTION FIELD FILTERS:
  → filter="Video_key_words/any(k: k eq '<keyword>')"
  → filter="Video_product_names/any(p: search.in(p, '<name1>,<name2>'))"

QUERY TYPES:
  simple  — keyword matching. +required -excluded | OR "exact phrase"
  full    — Lucene syntax: field:value, wildcards*, fuzzy~, proximity~N, regex /pat/
  semantic — AI reranker for meaning-based relevance. Best for natural language questions.
             Combine with use_vector=True for hybrid (vector + semantic rerank).

  COMPATIBILITY NOTE — query_type is a single enum, so:
    fuzzy + vector     ✅  fuzzy=True sets queryType="full"; vectorQueries added alongside
    semantic + vector  ✅  queryType="semantic" + vectorQueries — standard hybrid
    fuzzy + semantic   ❌  fuzzy needs "full", semantic needs "semantic" — mutually exclusive
    all three          ❌  same reason
  If you need typo tolerance AND semantic reranking, use use_vector=True (without fuzzy)
  — vector search handles misspellings via embeddings and semantic reranks the results.

═══════════════════════════════════════════════════════════════
CRITICAL RULES
═══════════════════════════════════════════════════════════════

1. ALWAYS use `select` to retrieve ONLY the fields you need for the current step.
   Never omit it. This prevents token overload and keeps your context clean.
   You can search on ANY searchable field — `select` only controls what comes back.
   Recommended select patterns:
   - Name/ID lookup:    select="id,project_title"  or  select="id,VoC_title"
   - Summary fetch:     select="id,VoC_title,long_stakeholder_VoC_summary"
   - Chunk evidence:    select="id,chunk_text,VoC_title,project_title,chunk_start_time,chunk_end_time"
   - Keyword discovery: select="id,VoC_title,Video_key_words,Video_product_names"

2. Adjust `top` based on what you know about the data. After resolving a project,
   use its num_VoCs to set appropriate top values:
   - If a project has 6 VoCs, set top=6 when listing its VoCs
   - For chunk searches within a small project, top=8-10 is usually enough
   - For broad cross-project chunk searches, top=10-15
   - Never request more results than you need

3. Use search_fields to target specific fields (e.g. VoC_title for name lookup).

4. long_stakeholder_project_summary and long_stakeholder_VoC_summary are pre-generated
   rich summaries. These are the DEFAULT response for ANY summary request about a project
   or VoC — including "summarize", "give me a summary", "stakeholder summary", "overview",
   or any similar phrasing. When returning these summaries:
   - Retrieve the field and reproduce it VERBATIM — copy the full text exactly as stored
   - Preserve ALL original formatting, markdown, bullet points, and line breaks
   - Do NOT paraphrase, shorten, restructure, add your own headers, re-number bullets,
     or rewrite in any way
   - ONLY deviate from verbatim if the user explicitly requests a different format
     (e.g. "give me a 3-bullet summary", "summarize in one paragraph", "list only the
     challenges")
   - Do NOT search chunks to manually build a summary when these fields exist

5. For cross-project comparisons, run separate scoped searches per project.

6. CITATIONS — cite only the sources you actually use in your answer:
   - For chunk content: cite the VoC_title (video name) and timestamp range
     (chunk_start_time – chunk_end_time)
   - For VoC-level content: cite the VoC_title
   - For project-level content: cite the project_title
   - Do NOT list all fetched documents — only cite what directly supports
     your answer. If a fetched result was not relevant, do not mention it.

7. If you don't know something, say so — do not guess.

═══════════════════════════════════════════════════════════════
EFFICIENCY RULES — MINIMIZE TOOL CALLS
═══════════════════════════════════════════════════════════════

8. MAXIMIZE work per tool call. Each tool call costs tokens and latency.
   Your target is 1-2 tool calls for simple questions, 2-4 for complex ones.
   NEVER exceed 4 tool calls unless a previous call returned zero results and
   you need to try a genuinely different strategy.

9. NEVER split a question into sub-queries. Semantic and vector search already
   handle meaning-matching — you do NOT need separate queries for synonyms,
   related terms, or sub-topics. For example:
   BAD:  3 calls — "commissioning", "challenges", "solar commissioning"
   GOOD: 1 call  — "challenges regarding solar commissioning"
   The semantic reranker and vector similarity will find relevant passages from
   a single well-formed natural language query.

10. Pick ONE hierarchy level to search first — the one most likely to answer
    the question. Do NOT search the same content at multiple levels (chunks AND
    VoCs) in the same iteration unless the first search returned insufficient results.
    - For detailed evidence / transcript quotes → search_chunks
    - For video-level overviews / summaries → search_vocs
    - For project-level summaries → search_projects

11. Use filters to scope, not extra queries. When the user mentions a project
    or video by name:
    - NEVER guess exact title values for OData eq filters.
    - ALWAYS resolve the exact title first: do ONE lookup call
      (search_projects with search_text="<user's term>",
      search_fields="project_title", select="id,project_title,num_VoCs",
      top=3)
      to get the exact project_title, id, and num_VoCs.
    - Then use the resolved id in a filter: filter="project_id eq '<id>'"
      (project_id is available on VoC and chunk docs).
    - This is a 2-call pattern: 1 lookup + 1 scoped search.
    - If the lookup returns zero results, use fuzzy=True (enables
      edit-distance matching for typos like "thiunderstruck" → "Thunderstruck")
      and/or use_vector=True (embedding-based fallback) and retry.

12. Only iterate if the previous call's results are genuinely insufficient.
    Before making another call, ask: "Do I already have enough to answer?"
    If yes, stop and synthesize the answer.

═══════════════════════════════════════════════════════════════
MULTI-TURN CONTEXT RULES
═══════════════════════════════════════════════════════════════

13. RESOLVE REFERENCES FROM CHAT HISTORY. When the user says "the project",
    "that summary", "this video", "the same one", or any anaphoric reference,
    ALWAYS resolve it to the specific entity (project name, VoC title) from
    the previous conversation turns BEFORE making any tool call. Never search
    generically — use the resolved name in your search query or filter.

14. VERBATIM RETRIEVAL. When the user asks you to return a field "as is",
    "exactly as stored", "verbatim", or "word for word", you MUST:
    - Re-fetch the specific field (e.g. long_stakeholder_project_summary)
      for the correct entity from chat history
    - Reproduce the retrieved text EXACTLY — copy it character-for-character
    - Do NOT paraphrase, reformat, restructure, add headers, add bullet
      numbering, or rewrite in any way
    - If the field contains markdown formatting, preserve it exactly

15. SUMMARY DEFAULT BEHAVIOR. Any request to "summarize", "give me a summary",
    "stakeholder summary", or "overview" of a project or VoC MUST return the
    long_stakeholder_project_summary or long_stakeholder_VoC_summary field
    VERBATIM. This is non-negotiable — the stored summary IS the answer.
    Only apply custom formatting if the user explicitly requests it (e.g.
    "summarize in 3 bullets", "one paragraph summary", "focus on challenges").
    If no custom format is requested, output = the stored field, unchanged."""


# ── Agent execution ─────────────────────────────────────────────────────────────

def run_agent(user_question: str, conversation_id: str) -> dict:
    """
    Run the tool-calling agent loop using the Responses API with Foundry
    conversation memory. Returns:
      {
        "answer": str,
        "tool_calls": [ {iteration, tool, args} ],
        "documents": [ {iteration, tool, result} ],
        "citations": [ {id, title, content, ...} ]    ← built from documents
      }
    """
    max_iter = _settings.azure_openai.max_iterations
    tool_call_log = []
    document_log = []

    response = _client.responses.create(
        model=_settings.azure_openai.chat_deployment,
        conversation=conversation_id,
        input=user_question,
        instructions=SYSTEM_PROMPT,
        tools=TOOLS,
        tool_choice="auto",
        temperature=_settings.azure_openai.temperature,
        max_output_tokens=_settings.azure_openai.max_tokens,
    )

    for iteration in range(1, max_iter + 1):
        function_calls = [item for item in response.output if item.type == "function_call"]

        if not function_calls:
            break

        tool_outputs = []
        for fc in function_calls:
            fn_name = fc.name
            fn_args = json.loads(fc.arguments) if fc.arguments else {}

            if fn_name in TOOL_DISPATCH:
                result = TOOL_DISPATCH[fn_name](**fn_args)
            else:
                result = json.dumps({"error": f"Unknown tool: {fn_name}"})

            tool_call_log.append({"iteration": iteration, "tool": fn_name, "args": fn_args})
            try:
                parsed = json.loads(result)
                document_log.append({"iteration": iteration, "tool": fn_name, "result": parsed})
            except json.JSONDecodeError:
                document_log.append({"iteration": iteration, "tool": fn_name, "result": result})

            tool_outputs.append({
                "type": "function_call_output",
                "call_id": fc.call_id,
                "output": result,
            })

        response = _client.responses.create(
            model=_settings.azure_openai.chat_deployment,
            conversation=conversation_id,
            input=tool_outputs,
            instructions=SYSTEM_PROMPT,
            tools=TOOLS,
            tool_choice="auto",
            temperature=_settings.azure_openai.temperature,
            max_output_tokens=_settings.azure_openai.max_tokens,
        )

    final_answer = response.output_text or "(no answer)"
    citations = _build_citations(document_log, final_answer)
    return {
        "answer": final_answer,
        "tool_calls": tool_call_log,
        "documents": document_log,
        "citations": citations,
    }


def _build_citations(document_log: list, answer_text: str) -> list:
    """
    Build citations from the document_log — the same data that notebook's
    '# Documents fetched from tool calls' cells show.

    For each unique VoC or project found in tool results, produce a citation
    with its title, content (summary or chunk text), and ID.
    """
    seen_ids = set()
    citations = []
    citation_idx = 0

    for entry in document_log:
        tool_name = entry.get("tool", "")
        result_data = entry.get("result", {})
        if isinstance(result_data, str):
            try:
                result_data = json.loads(result_data)
            except (json.JSONDecodeError, TypeError):
                continue

        results = result_data.get("results", [])
        for doc in results:
            doc_id = doc.get("id", "")
            if doc_id in seen_ids:
                continue
            seen_ids.add(doc_id)

            # Determine title and content based on hierarchy level
            title = (
                doc.get("VoC_title")
                or doc.get("project_title")
                or doc.get("Voc_segment_title")
                or f"Document {doc_id[:12]}"
            )

            # Build content from available fields
            content_parts = []
            if doc.get("chunk_text"):
                content_parts.append(doc["chunk_text"])
            if doc.get("short_VoC_summary"):
                content_parts.append(doc["short_VoC_summary"])
            if doc.get("long_stakeholder_VoC_summary"):
                content_parts.append(doc["long_stakeholder_VoC_summary"])
            if doc.get("short_project_summary"):
                content_parts.append(doc["short_project_summary"])
            if doc.get("long_stakeholder_project_summary"):
                content_parts.append(doc["long_stakeholder_project_summary"])
            if doc.get("segment_chronological_summary"):
                content_parts.append(doc["segment_chronological_summary"])
            if doc.get("Voc_segment_summary"):
                content_parts.append(doc["Voc_segment_summary"])

            content = "\n\n".join(content_parts) if content_parts else title

            # Add timestamp info for chunks
            chunk_start = doc.get("chunk_start_time", "")
            chunk_end = doc.get("chunk_end_time", "")
            voc_title = doc.get("VoC_title", "")
            project_title = doc.get("project_title", "")

            # Additional metadata
            metadata_parts = []
            if project_title:
                metadata_parts.append(f"Project: {project_title}")
            if voc_title:
                metadata_parts.append(f"Video: {voc_title}")
            if chunk_start:
                metadata_parts.append(f"Time: {chunk_start} - {chunk_end}")
            if doc.get("voc_category"):
                metadata_parts.append(f"Category: {doc['voc_category']}")
            if doc.get("Video_key_words"):
                kw = doc["Video_key_words"]
                if isinstance(kw, list):
                    kw = ", ".join(kw)
                metadata_parts.append(f"Keywords: {kw}")
            if doc.get("Video_product_names"):
                pn = doc["Video_product_names"]
                if isinstance(pn, list):
                    pn = ", ".join(pn)
                metadata_parts.append(f"Products: {pn}")

            citation_idx += 1
            citations.append({
                "id": str(citation_idx),
                "title": title,
                "content": content,
                "filepath": None,
                "url": None,
                "metadata": " | ".join(metadata_parts) if metadata_parts else None,
                "chunk_id": str(citation_idx),
                "reindex_id": str(citation_idx),
                "chunk_start_time": chunk_start,
                "chunk_end_time": chunk_end,
                "project_title": project_title,
                "voc_title": voc_title,
                "tool_source": tool_name,
                "doc_type": (
                    "chunk" if doc.get("chunk_text")
                    else "voc" if doc.get("VoC_title")
                    else "project"
                ),
            })

    return citations
