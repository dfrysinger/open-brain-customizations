# Hybrid Search for Open Brain

## Problem

The `search_thoughts` tool uses purely vector-based semantic search. Short keyword-style queries like "Ashby ATS tips" fail to find thoughts that literally contain those words, because the embedding similarity score falls below the default threshold of 0.5. Longer natural language queries work, but agents and users naturally reach for short keyword queries first.

## Solution

Add PostgreSQL full-text search alongside the existing vector search, combining results using Reciprocal Ranked Fusion (RRF). This leverages capabilities already built into the Supabase/PostgreSQL stack with zero new dependencies.

## Changes

### 1. Database: Add full-text search column

Add a generated `tsvector` column to the `thoughts` table that auto-populates from `content`. No backfill needed, existing rows populate automatically.

```sql
ALTER TABLE thoughts ADD COLUMN
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX thoughts_fts_idx ON thoughts USING GIN (fts);
```

### 2. Database: Create `hybrid_search` RPC function

A new PostgreSQL function that runs both search methods and merges results via RRF.

Parameters:
- `query_text` (text) - raw search string for full-text matching
- `query_embedding` (vector(1536)) - pre-computed embedding for semantic matching
- `match_count` (int) - max results to return
- `full_text_weight` (float, default 1) - weight for keyword ranking signal
- `semantic_weight` (float, default 1) - weight for vector ranking signal
- `rrf_k` (int, default 50) - RRF smoothing constant

Returns: `id`, `content`, `metadata`, `created_at`

```sql
create or replace function hybrid_search(
  query_text text,
  query_embedding vector(1536),
  match_count int,
  full_text_weight float default 1,
  semantic_weight float default 1,
  rrf_k int default 50
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  with full_text as (
    select
      t.id,
      row_number() over(
        order by ts_rank_cd(t.fts, websearch_to_tsquery(query_text)) desc
      ) as rank_ix
    from thoughts t
    where t.fts @@ websearch_to_tsquery(query_text)
    order by rank_ix
    limit least(match_count * 5, 100)
  ),
  semantic as (
    select
      t.id,
      row_number() over(
        order by t.embedding <=> query_embedding
      ) as rank_ix
    from thoughts t
    order by rank_ix
    limit least(match_count * 5, 100)
  )
  select
    t.id,
    t.content,
    t.metadata,
    t.created_at
  from full_text
  full outer join semantic on full_text.id = semantic.id
  join thoughts t on coalesce(full_text.id, semantic.id) = t.id
  order by
    coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
    desc
  limit match_count;

exception
  when syntax_error or undefined_function then
    -- websearch_to_tsquery can throw on malformed input (unmatched quotes, etc.)
    -- Fall back to vector-only search
    return query
    select
      t.id,
      t.content,
      t.metadata,
      t.created_at
    from thoughts t
    order by t.embedding <=> query_embedding
    limit match_count;
end;
$$;
```

Key design decisions:
- Each side is limited to `match_count * 5` (capped at 100) candidates for performance. The HNSW index on embeddings and GIN index on fts keep these scans fast.
- NULL ranks from the full outer join are handled by `coalesce(..., 0.0)`, meaning results that only appear in one search get zero contribution from the other, but still rank based on their single signal.
- `websearch_to_tsquery` is wrapped in an exception handler. If the query text contains malformed syntax (unmatched quotes, etc.), the function falls back to vector-only search rather than failing.
- Stop-word-only queries (e.g., "the") produce an empty tsquery, so the full-text side returns zero rows and ranking falls back to vector-only. This is expected behavior.

### 3. MCP tool: Update `search_thoughts`

File: `open-brain-customizations/functions/open-brain-mcp-modified.ts`

Changes:
- Remove `threshold` parameter
- Keep `query` (string) and `limit` (number, default 10)
- Embed the query via `getEmbedding(query)` as before
- Call `hybrid_search` RPC with both raw query text and embedding
- Remove similarity percentage from result output (RRF scores are not meaningful to display)
- Add thought `id` to result output (enables update/delete workflows)
- Keep the rest of the output format: type, topics, people, actions, content

TypeScript RPC call:
```typescript
const { data, error } = await supabase.rpc("hybrid_search", {
  query_text: query,
  query_embedding: qEmb,
  match_count: limit,
});
```

### 4. What stays the same

- `capture_thought` - no changes. The `fts` column auto-generates from `content`.
- `update_thought` - no changes, same reason.
- `delete_thought` - no changes.
- `list_thoughts` - no changes.
- `thought_stats` - no changes.
- `match_thoughts` RPC - left in place, not deleted. Not called by anything after this change.

## Files to modify

1. `open-brain-customizations/schema/hybrid-search.sql` - new file with ALTER TABLE, CREATE INDEX, CREATE FUNCTION
2. `open-brain-customizations/functions/open-brain-mcp-modified.ts` - update `search_thoughts` tool

## Verification

After deployment, these searches should all find the "Ashby ATS tip" thought:
- "Ashby" (single keyword)
- "Ashby ATS tip" (exact match)
- "Ashby ATS tips" (near-exact match)
- "how to click yes no buttons on Ashby forms" (semantic, already works today)
