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
