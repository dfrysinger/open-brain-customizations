# Hybrid Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add keyword search alongside vector search in Open Brain, merged via Reciprocal Ranked Fusion (RRF), so short queries like "Ashby" find thoughts containing that word.

**Architecture:** Add a PostgreSQL `tsvector` generated column to the `thoughts` table, create a `hybrid_search` RPC that runs both full-text and vector search and merges via RRF, then update the MCP `search_thoughts` tool to call it.

**Tech Stack:** PostgreSQL (full-text search, pgvector), Supabase Edge Functions (Deno/TypeScript), Supabase CLI

**Spec:** `docs/superpowers/specs/2026-03-22-hybrid-search-design.md`

---

### Task 1: Create the SQL migration

**Files:**
- Create: `open-brain-customizations/schema/hybrid-search.sql`

- [ ] **Step 1: Write the SQL file**

```sql
-- Add full-text search column (auto-generated from content)
ALTER TABLE thoughts ADD COLUMN
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX thoughts_fts_idx ON thoughts USING GIN (fts);

-- Hybrid search function: combines full-text + vector via RRF
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
    -- websearch_to_tsquery can throw on malformed input
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

- [ ] **Step 2: Run the SQL against Supabase**

Open the Supabase dashboard SQL Editor and run the contents of `schema/hybrid-search.sql`.

Verify:
1. `SELECT column_name FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'fts';` returns one row
2. `SELECT indexname FROM pg_indexes WHERE tablename = 'thoughts' AND indexname = 'thoughts_fts_idx';` returns one row
3. `SELECT proname FROM pg_proc WHERE proname = 'hybrid_search';` returns one row

- [ ] **Step 3: Quick smoke test in SQL Editor**

Run a keyword search to verify the fts column populated correctly:

```sql
SELECT content FROM thoughts WHERE fts @@ websearch_to_tsquery('Ashby') LIMIT 3;
```

Expected: returns the "Ashby ATS tip" thought.

---

### Task 2: Update the MCP search_thoughts tool

**Files:**
- Modify: `open-brain-customizations/functions/open-brain-mcp-modified.ts` (lines 84-163, the `search_thoughts` tool registration)

- [ ] **Step 1: Update the tool registration**

Replace the `search_thoughts` tool (lines 84-163) with:

```typescript
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
    },
  },
  async ({ query, limit }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("hybrid_search", {
        query_text: query,
        query_embedding: qEmb,
        match_count: limit,
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
        };
      }

      const results = data.map(
        (
          t: {
            id: string;
            content: string;
            metadata: Record<string, unknown>;
            created_at: string;
          },
          i: number
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} ---`,
            `ID: ${t.id}`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[search_thoughts] Error:`, err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);
```

Key changes from the original:
- Removed `threshold` parameter
- Calls `hybrid_search` RPC instead of `match_thoughts`
- Removed similarity percentage from output header (`--- Result N ---` instead of `--- Result N (X% match) ---`)
- Added `ID: ${t.id}` to output
- Added `id: string` to the type annotation

- [ ] **Step 2: Deploy the Edge Function**

```bash
supabase functions deploy open-brain-mcp --project-ref <your-project-ref>
```

Note: The function name in Supabase may differ from the local filename. Check what the deployed function is named and use that.

- [ ] **Step 3: Verify with live searches**

Use the MCP tool (via Claude Code) to run the verification searches from the spec:

1. `search_thoughts` with query "Ashby" - should find the Ashby ATS tip thought
2. `search_thoughts` with query "Ashby ATS tip" - should find it
3. `search_thoughts` with query "Ashby ATS tips" - should find it
4. `search_thoughts` with query "how to click yes no buttons on Ashby forms" - should find it (already worked before)

- [ ] **Step 4: Commit**

```bash
git add schema/hybrid-search.sql functions/open-brain-mcp-modified.ts
git commit -m "feat: add hybrid search (keyword + vector) via RRF"
```
