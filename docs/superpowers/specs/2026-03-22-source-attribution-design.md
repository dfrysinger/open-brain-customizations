# Source Attribution for Job Hunt Pipeline

## Problem

Multiple actors create and modify job pipeline records: Daniel manually, his wife via LinkedIn Easy Apply, the auto-resume-generator, the gmail-sync scanner, the Slack ingest, and the job-applicator agent. There is no way to tell who created a posting, application, resume, or cover letter. This leads to bad data (e.g., applications marked "applied" that were never actually submitted) and makes debugging difficult.

## Solution

Add a minimal `created_by` column to `job_postings` and `applications` for the most common query ("who created this?"). Capture all other attribution, including resume/cover letter creation, status changes, and field edits, in a separate `attribution_log` table. The log is opt-in: normal queries don't join to it, and a dedicated tool retrieves history when needed.

## Schema Changes

### `job_postings` table - add 1 column

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `created_by` | TEXT | NOT NULL | Short lowercase identifier (e.g., "daniel", "slack-ingest") |

### `applications` table - add 1 column

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `created_by` | TEXT | NOT NULL | Short lowercase identifier |

### New `attribution_log` table

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | UUID | NOT NULL | Primary key, gen_random_uuid() |
| `entity_type` | TEXT | NOT NULL | `'job_posting'` or `'application'` |
| `entity_id` | UUID | NOT NULL | FK to the posting or application |
| `action` | TEXT | NOT NULL | What happened (see Action Types below) |
| `actor` | TEXT | NOT NULL | Who did it (same identifiers as `created_by`) |
| `reason` | TEXT | nullable | Context string, max ~120 chars |
| `created_at` | TIMESTAMPTZ | NOT NULL | defaults to now() |

Index on `(entity_type, entity_id)` for fast lookups.

### Action Types

| Action | When logged |
|--------|------------|
| `created` | A posting or application is created |
| `resume_added` | `resume_path` is set to a non-null value |
| `resume_removed` | `resume_path` is set to null |
| `cover_letter_added` | `cover_letter_path` is set to a non-null value |
| `cover_letter_removed` | `cover_letter_path` is set to null |
| `status_changed` | Application status changes (reason field captures old -> new) |
| `field_updated` | Other significant field changes (reason field captures what changed) |

### No enum constraint

`created_by` and `actor` are free-text, not enums. New agents or sources can identify themselves without a schema migration. Convention is short lowercase identifiers.

### Known source identifiers

| Identifier | Actor |
|------------|-------|
| `daniel` | Daniel, manually via Claude Code |
| `wife` | Daniel's wife, typically via LinkedIn Easy Apply |
| `slack-ingest` | Slack channel that accepts job links |
| `gmail-sync` | Daily scheduled task scanning Gmail for application receipts |
| `auto-resume-generator` | Hourly scheduled task creating draft resumes |
| `resume-optimizer` | Agent that creates tailored resumes |
| `job-applicator` | Agent that fills out job applications |
| `enrichment-cron` | Daily Mac Mini cron that enriches posting data |
| `migration-script` | The migrate-thoughts-to-jobs.ts script |
| `legacy` | Backfill value for records created before this feature |

### Backfill

All existing rows in `job_postings` and `applications` get `created_by = 'legacy'`. No log entries are backfilled for existing records.

### Migration SQL

```sql
-- Add created_by to existing tables
ALTER TABLE job_postings ADD COLUMN created_by TEXT DEFAULT 'legacy' NOT NULL;
ALTER TABLE applications ADD COLUMN created_by TEXT DEFAULT 'legacy' NOT NULL;

-- Drop defaults so future inserts must provide created_by
ALTER TABLE job_postings ALTER COLUMN created_by DROP DEFAULT;
ALTER TABLE applications ALTER COLUMN created_by DROP DEFAULT;

-- Create attribution log
CREATE TABLE IF NOT EXISTS attribution_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('job_posting', 'application')),
    entity_id UUID NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attribution_log_entity
    ON attribution_log(entity_type, entity_id);

-- RLS
ALTER TABLE attribution_log ENABLE ROW LEVEL SECURITY;
```

### Note: `schema.sql` is out of sync

The canonical `schema.sql` in `open-brain/extensions/job-hunt/` is missing several columns that exist in the live database: `priority`, `location`, and `enrichment_error` on `job_postings`; `resume_path` and `cover_letter_path` on `applications`; and `"draft"` and `"ready"` in the applications status CHECK constraint. The migration SQL targets the live database and will work, but `schema.sql` should be updated separately to reflect the true schema.

## MCP Server Changes

### `add_job_posting` tool

- Add required `created_by` (string) param
- Add optional `created_by_reason` (string) param
- Pass `created_by` to the Supabase insert
- **Upsert behavior:** On URL conflict (update path), exclude `created_by` from the update payload to preserve the original creator's identity.
- Write a `created` entry to `attribution_log` on insert (not on upsert update)

### `submit_application` tool

- Add required `created_by` (string) param
- Add optional `created_by_reason` (string) param
- Pass `created_by` to the Supabase insert
- Write a `created` entry to `attribution_log`
- If `resume_path` is provided, also write a `resume_added` entry
- If `cover_letter_path` is provided, also write a `cover_letter_added` entry

### `update_application` tool

- Add required `actor` (string) param (who is making this update)
- Add optional `actor_reason` (string) param
- Automatically log to `attribution_log` based on what changed:
  - `resume_path` set to non-null -> `resume_added`
  - `resume_path` set to null -> `resume_removed`
  - `cover_letter_path` set to non-null -> `cover_letter_added`
  - `cover_letter_path` set to null -> `cover_letter_removed`
  - `status` changed -> `status_changed` (reason captures "draft -> applied" etc.)
- Make `created_by` updatable for correction purposes

### New `get_attribution_history` tool

- Params: `entity_type` (required), `entity_id` (required)
- Returns all `attribution_log` entries for the given entity, ordered by `created_at`
- This is the opt-in way to see full history without burdening normal queries

### `search_job_postings` tool

- Include `created_by` in returned data for both postings and applications (no join to log table)
- Add optional `created_by` filter param to query by source

## Caller Updates

### Slack ingest (`ingest-thought-modified.ts`)

Writes directly to Supabase. Add to the job_postings upsert:
- `created_by: "slack-ingest"`
- Write a `created` entry to `attribution_log` with reason `"LinkedIn URL shared in Slack channel"`

### Enrichment cron (`enrich-job-postings.ts`)

Only updates existing rows (title, company, location). Optionally write `field_updated` log entries, but not required for v1.

### Migration script (`migrate-thoughts-to-jobs.ts`)

Writes directly to Supabase for both `job_postings` and `applications`. Update to include:
- `created_by: "migration-script"` on all inserts to both tables

### Gmail sync (scheduled task SKILL.md)

Update prompt to instruct agent to pass:
- `created_by: "gmail-sync"`
- `created_by_reason` containing first 120 characters of the email subject, truncated with "..." if needed. Format: `"Application confirmation email: <subject>"`

Also fix pre-existing bug: references to `update_application_status` should be `update_application`.

### Auto-resume-generator (scheduled task SKILL.md)

Update prompt to pass:
- `created_by: "auto-resume-generator"` when creating applications
- `actor: "resume-optimizer"` when the spawned agent sets `resume_path`

### Resume-optimizer agent

Update agent instructions to pass:
- `actor: "resume-optimizer"` when calling `update_application` to set `resume_path`

### Job-applicator agent

Update agent instructions to pass:
- `actor: "job-applicator"` when calling `update_application` to set `cover_letter_path` or `resume_path`

### Job-hunt-mcp skill (guardrails doc)

Update to remind all agents that:
- `created_by` is mandatory on `add_job_posting` and `submit_application`
- `actor` is mandatory on `update_application`

### Manual conversations

When calling MCP tools directly in conversation, use `created_by: "daniel"` or `actor: "daniel"`.

## Deploy Order

1. Update agent instructions (resume-optimizer, job-applicator) and scheduled task prompts (gmail-sync SKILL.md, auto-resume-generator SKILL.md) and job-hunt-mcp skill guardrails. These are safe to deploy first since the MCP server will simply ignore unknown params until it's updated.
2. Run migration SQL (add columns, create log table, backfill, drop defaults)
3. Deploy updated MCP server (`index.ts`)
4. Deploy updated Slack ingest (`ingest-thought-modified.ts`)
5. Update migration script (`migrate-thoughts-to-jobs.ts`)
6. Verify by creating a test posting and application, confirm attribution flows through and log entries appear

Agent/task prompt updates go first (step 1) so that by the time the MCP server starts requiring `created_by` (step 3), all callers are already passing it. The gmail-sync runs daily at 9 AM and the auto-resume-generator runs hourly, so time steps 2-3 between runs to avoid any window where the MCP requires params that callers aren't sending yet.
