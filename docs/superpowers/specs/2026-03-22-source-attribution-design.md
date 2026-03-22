# Source Attribution for Job Hunt Pipeline

## Problem

Multiple actors create and modify job pipeline records: Daniel manually, his wife via LinkedIn Easy Apply, the auto-resume-generator, the gmail-sync scanner, the Slack ingest, and the job-applicator agent. There is no way to tell who created a posting, application, resume, or cover letter. This leads to bad data (e.g., applications marked "applied" that were never actually submitted) and makes debugging difficult.

## Solution

Add `created_by` attribution fields to the `job_postings` and `applications` tables. Track four attribution points: who created the posting, who created the application, who generated the resume, and who generated the cover letter. Enforce attribution at the DB level for postings and applications, and at the MCP application layer for resumes and cover letters.

## Schema Changes

### `job_postings` table

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `created_by` | TEXT | NOT NULL | Short lowercase identifier (e.g., "daniel", "slack-ingest") |
| `created_by_reason` | TEXT | nullable | Why the record was created (e.g., "Application confirmation email: ...") |

### `applications` table

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `created_by` | TEXT | NOT NULL | Short lowercase identifier |
| `created_by_reason` | TEXT | nullable | Why the record was created |
| `resume_created_by` | TEXT | nullable | Who generated the resume. Nullable in DB; MCP enforces it when `resume_path` is set. |
| `cover_letter_created_by` | TEXT | nullable | Who generated the cover letter. Nullable in DB; MCP enforces it when `cover_letter_path` is set. |

### No enum constraint

`created_by` is free-text, not an enum. New agents or sources can identify themselves without a schema migration. Convention is short lowercase identifiers.

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
| `unknown` | Fallback if source cannot be determined |

### Backfill

All existing rows in `job_postings` and `applications` get `created_by = 'legacy'`.

### Migration SQL

```sql
ALTER TABLE job_postings ADD COLUMN created_by TEXT DEFAULT 'legacy' NOT NULL;
ALTER TABLE job_postings ADD COLUMN created_by_reason TEXT;

ALTER TABLE applications ADD COLUMN created_by TEXT DEFAULT 'legacy' NOT NULL;
ALTER TABLE applications ADD COLUMN created_by_reason TEXT;
ALTER TABLE applications ADD COLUMN resume_created_by TEXT;
ALTER TABLE applications ADD COLUMN cover_letter_created_by TEXT;

ALTER TABLE job_postings ALTER COLUMN created_by DROP DEFAULT;
ALTER TABLE applications ALTER COLUMN created_by DROP DEFAULT;
```

### Note: `schema.sql` is out of sync

The canonical `schema.sql` in `open-brain/extensions/job-hunt/` is missing several columns that exist in the live database: `priority`, `location`, and `enrichment_error` on `job_postings`; `resume_path` and `cover_letter_path` on `applications`; and `"draft"` and `"ready"` in the applications status CHECK constraint. The migration SQL targets the live database and will work, but `schema.sql` should be updated separately to reflect the true schema.

## MCP Server Changes

### `add_job_posting` tool

- Add required `created_by` (string) param
- Add optional `created_by_reason` (string) param
- **Upsert behavior:** On URL conflict (update path), exclude `created_by` and `created_by_reason` from the update payload. These fields are set only on INSERT to preserve the original creator's identity.

### `submit_application` tool

- Add required `created_by` (string) param
- Add optional `created_by_reason` (string) param
- Add optional `resume_created_by` and `cover_letter_created_by` params
- Validation: if `resume_path` is provided and `resume_created_by` is not, reject with an error. Same for `cover_letter_path` / `cover_letter_created_by`.
- Pass all to the Supabase insert

### `update_application` tool

- Add optional `resume_created_by` and `cover_letter_created_by` params
- Validation: if `resume_path` is set to a non-null value and `resume_created_by` is not provided, reject with an error. Same for `cover_letter_path` / `cover_letter_created_by`.
- **Auto-clear on null:** If `resume_path` is explicitly set to null, automatically set `resume_created_by` to null as well. Same for `cover_letter_path` / `cover_letter_created_by`.
- Make `created_by`, `created_by_reason`, `resume_created_by`, `cover_letter_created_by` all updatable for correction purposes

### `search_job_postings` tool

- Include `created_by` and `created_by_reason` in returned data for both postings and applications
- Include `resume_created_by` and `cover_letter_created_by` in the applications sub-select
- Add optional `created_by` filter param to query by source

## Caller Updates

### Slack ingest (`ingest-thought-modified.ts`)

Writes directly to Supabase. Add to the job_postings upsert:
- `created_by: "slack-ingest"`
- `created_by_reason: "LinkedIn URL shared in Slack channel"`

### Enrichment cron (`enrich-job-postings.ts`)

Only updates existing rows (title, company, location). No changes needed.

### Migration script (`migrate-thoughts-to-jobs.ts`)

Writes directly to Supabase for both `job_postings` and `applications`. Update to include:
- `created_by: "migration-script"` on all inserts to both tables
- `resume_created_by: "migration-script"` when setting `resume_path`
- `cover_letter_created_by: "migration-script"` when setting `cover_letter_path`

### Gmail sync (scheduled task SKILL.md)

Update prompt to instruct agent to pass:
- `created_by: "gmail-sync"`
- `created_by_reason` containing first 120 characters of the email subject, truncated with "..." if needed. Format: `"Application confirmation email: <subject>"`

Also fix pre-existing bug: references to `update_application_status` should be `update_application`.

### Auto-resume-generator (scheduled task SKILL.md)

Update prompt to pass:
- `created_by: "auto-resume-generator"` when creating applications
- Instruct the spawned resume-optimizer agent to pass `resume_created_by: "resume-optimizer"`

### Resume-optimizer agent

Update agent instructions to pass:
- `resume_created_by: "resume-optimizer"` when setting `resume_path` (via both `submit_application` and `update_application`)

### Job-applicator agent

Update agent instructions to pass:
- `cover_letter_created_by: "job-applicator"` when setting `cover_letter_path`
- `resume_created_by: "job-applicator"` if it generates resumes

### Job-hunt-mcp skill (guardrails doc)

Update to remind all agents that `created_by` is mandatory on `add_job_posting` and `submit_application`, and that `resume_created_by` / `cover_letter_created_by` are required when setting the corresponding paths.

### Manual conversations

When calling MCP tools directly in conversation, use `created_by: "daniel"`.

## Deploy Order

1. Update agent instructions (resume-optimizer, job-applicator) and scheduled task prompts (gmail-sync SKILL.md, auto-resume-generator SKILL.md) and job-hunt-mcp skill guardrails. These are safe to deploy first since the MCP server will simply ignore unknown params until it's updated.
2. Run migration SQL (add columns with temporary default, backfill, drop default)
3. Deploy updated MCP server (`index.ts`)
4. Deploy updated Slack ingest (`ingest-thought-modified.ts`)
5. Update migration script (`migrate-thoughts-to-jobs.ts`)
6. Verify by creating a test posting and application, confirm attribution flows through

Agent/task prompt updates go first (step 1) so that by the time the MCP server starts requiring `created_by` (step 3), all callers are already passing it. The gmail-sync runs daily at 9 AM and the auto-resume-generator runs hourly, so time steps 2-3 between runs to avoid any window where the MCP requires params that callers aren't sending yet.
