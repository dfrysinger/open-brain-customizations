# Open Brain Customizations

Custom extensions and modifications for Open Brain.

## Job Hunt Extension Customizations

This repo contains customizations layered on top of the upstream [Job Hunt Pipeline](https://github.com/open-brain/extensions/job-hunt) extension. The customizations add source attribution tracking throughout the pipeline.

### The `attribution_log` Table

All `job_postings` and `applications` mutations write an event to the `attribution_log` table. This table is defined in `schema.sql` alongside the core extension tables.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `entity_type` | TEXT | `'job_posting'` or `'application'` |
| `entity_id` | UUID | ID of the record that changed |
| `action` | TEXT | What happened (`created`, `status_changed`, `enriched`, `enrichment_failed`, `deleted`) |
| `actor` | TEXT | Identifier for who or what caused the change |
| `reason` | TEXT | Optional free-text explanation |
| `created_at` | TIMESTAMPTZ | When the event was recorded |

The table uses a permissive RLS policy (`USING (true)`) because it does not have a `user_id` column. Access is controlled at the MCP server layer.

### New and Changed MCP Tool Parameters

#### `add_job_posting`

Added parameter:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `created_by` | string | Yes | Identifier for the actor creating the posting (e.g., `"claude-desktop"`, `"slack-ingest"`) |

The MCP server writes a `created` event to `attribution_log` on successful insert, using the `created_by` value as the `actor`.

#### `submit_application`

Added parameter:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `created_by` | string | Yes | Identifier for the actor submitting the application |

The MCP server writes a `created` event to `attribution_log` on successful insert.

#### `update_application`

Added parameter:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `actor` | string | Yes | Identifier for the actor making the update |

When `status` changes, the MCP server writes a `status_changed` event to `attribution_log` with the `actor` value.

### The `get_attribution_history` Tool

Returns the full event log for a single entity.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `entity_type` | string | Yes | `'job_posting'` or `'application'` |
| `entity_id` | string | Yes | UUID of the entity to look up |

**Returns:** Array of `attribution_log` rows ordered by `created_at` ascending.

**Example usage:**

```
Show me the attribution history for application <uuid>
```

```
Who created job posting <uuid> and when was it last updated?
```

### Known Actor Identifiers

| Actor string | Source |
|-------------|--------|
| `claude-desktop` | Interactive session via Claude Desktop |
| `claude-code` | Claude Code agent session |
| `slack-ingest` | Slack message ingest automation |
| `scheduled-agent` | Cron-triggered scheduled agent |
| `manual` | Direct database or API access outside the MCP server |
