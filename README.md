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

## Deployment

Edge Functions are deployed from the `open-brain` repo (fork at `dfrysinger/OB1`) using the Supabase CLI. The project ref is `ttllvphnentazdtvhhjt`.

### Deploy commands

All three Edge Functions must be deployed with `--no-verify-jwt`. Without this flag, Supabase's API gateway rejects requests with a 401 before they reach the function's own auth logic (the `x-brain-key` header or `?key=` query parameter check).

```bash
cd ~/Projects/open-brain
supabase functions deploy open-brain-mcp --no-verify-jwt --project-ref ttllvphnentazdtvhhjt
supabase functions deploy job-hunt-mcp --no-verify-jwt --project-ref ttllvphnentazdtvhhjt
supabase functions deploy ingest-thought --no-verify-jwt --project-ref ttllvphnentazdtvhhjt
```

### MCP client configuration

Both MCP servers authenticate via a shared access key stored in Supabase secrets as `MCP_ACCESS_KEY`.

**Claude Code** uses the `x-brain-key` header:
```bash
claude mcp add --transport http open-brain \
  https://ttllvphnentazdtvhhjt.supabase.co/functions/v1/open-brain-mcp \
  --header "x-brain-key: <access-key>"

claude mcp add --transport http job-hunt \
  https://ttllvphnentazdtvhhjt.supabase.co/functions/v1/job-hunt-mcp \
  --header "x-brain-key: <access-key>"
```

**Claude Desktop and ChatGPT** use the `?key=` query parameter in the URL (set authentication to "none" in the connector settings).

### Troubleshooting connection failures

If an MCP server shows "Failed to connect" in `claude mcp list`:

1. Test the endpoint directly:
   ```bash
   curl -s -X POST "<function-url>" \
     -H "x-brain-key: <access-key>" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'
   ```
2. If the response is `{"code":401,"message":"Missing authorization header"}`, the function was deployed without `--no-verify-jwt`. Redeploy with that flag.
3. If the response contains a `jsonrpc` error about content types, auth is passing and the function is reachable. The issue is elsewhere.
4. After redeploying, reconnect in Claude Code via `/mcp`, select the server, and reconnect.

### Git remotes (open-brain repo)

The `open-brain` repo has two remotes:
- `origin` points to `dfrysinger/OB1` (push here)
- `upstream` points to `NateBJones-Projects/OB1` (pull updates from here with `git fetch upstream`)

## Networking Pipeline Tools

The `job-hunt-mcp` server includes 8 tools for managing networking contacts alongside job postings.

### Schema additions

#### `job_contacts` table

Stores contacts associated with job postings.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `name` | TEXT | Contact's full name |
| `company_id` | UUID | FK to `companies` |
| `role` | TEXT | Contact's job title (optional) |
| `linkedin_url` | TEXT | LinkedIn profile URL (optional) |
| `notes` | TEXT | Free-text notes (optional) |
| `created_by` | TEXT | Actor that created the record |
| `created_at` | TIMESTAMPTZ | When the record was created |

#### `posting_contacts` junction table

Links contacts to job postings with a relationship type.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `job_posting_id` | UUID | FK to `job_postings` |
| `job_contact_id` | UUID | FK to `job_contacts` |
| `relationship` | TEXT | Relationship enum value (see below) |
| `created_at` | TIMESTAMPTZ | When the link was created |

**Relationship enum values:** `colleague`, `hiring_manager`, `confirmed_recruiter`, `recruiter`, `recruiting_lead`, `network`, `mutual_intro`, `employee`, `executive`

#### New columns on `job_postings`

| Column | Type | Description |
|--------|------|-------------|
| `connection_count` | INTEGER | Number of known contacts at the company |
| `networking_status` | TEXT | One of: `not_started`, `researched`, `outreach_in_progress`, `done` |

#### `daily_stats` table

Tracks daily progress toward job-hunt activity targets.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `date` | DATE | The calendar date |
| `track` | TEXT | Category being tracked (e.g., `applications`, `outreach`) |
| `completed` | INTEGER | Count of completed items for the day |
| `target` | INTEGER | Daily target count |
| `deficit` | INTEGER | `target - completed` (can be negative if ahead) |
| `created_at` | TIMESTAMPTZ | When the row was recorded |

### MCP tools

| Tool | Required params | Description |
|------|----------------|-------------|
| `add_job_contact` | `name`, `company_id`, `created_by` | Create a contact; optionally link to a posting with a relationship type |
| `search_job_contacts` | — | Find contacts by company, posting, role, or text search |
| `update_job_contact` | `job_contact_id`, `actor` | Update fields on an existing contact |
| `delete_job_contact` | `job_contact_id`, `actor` | Delete a contact and cascade-remove all posting links |
| `link_contact_to_posting` | `job_contact_id`, `job_posting_id`, `relationship` | Link a contact to a posting with a relationship type |
| `unlink_contact_from_posting` | `job_contact_id`, `job_posting_id` | Remove a contact-posting link without deleting the contact |
| `update_job_posting` | `job_posting_id`, `actor` | Update posting fields including `networking_status` and `connection_count` |
| `get_networking_queue` | — | Pipeline management query; returns postings grouped by networking status with contact counts |

## Open Brain MCP Customizations

The `open-brain-mcp` function has been modified from the upstream version:

- `search_thoughts` uses `hybrid_search` RPC (combined vector + text search) instead of `match_thoughts` (vector-only). The `threshold` parameter was removed.
- `capture_thought` sets `source: "mcp"` in metadata.
- `update_thought` and `delete_thought` tools were added for full CRUD on the thoughts table.

## Ingest Thought Customizations

The `ingest-thought` function (Slack capture pipeline) has been modified:

- Job posting upsert logic changed from a simple upsert to a check-then-insert/update pattern. This preserves the `created_by` value on existing postings rather than overwriting it when Slack shares the same URL again.
