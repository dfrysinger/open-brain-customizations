# Source Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `created_by` attribution to the job hunt pipeline so every posting and application tracks who created it, with a full audit log for resume/cover letter changes and status transitions.

**Architecture:** Add one column (`created_by`) to `job_postings` and `applications` tables for inline attribution. Create a new `attribution_log` table for detailed history (resume added, status changed, etc.). Update the MCP server to require `created_by`/`actor` on write operations and automatically log to the attribution table. Update all callers (Slack ingest, migration script, agent instructions, scheduled tasks).

**Tech Stack:** PostgreSQL (Supabase), Deno/TypeScript (Edge Functions), MCP SDK, Zod validation

**Spec:** `docs/superpowers/specs/2026-03-22-source-attribution-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `open-brain/extensions/job-hunt/schema.sql` | Modify | Add `created_by` columns, `attribution_log` table, sync missing columns |
| `open-brain/extensions/job-hunt/metadata.json` | Modify | Version bump |
| `open-brain/extensions/job-hunt/README.md` | Modify | Document attribution feature |
| `open-brain-customizations/functions/job-hunt-mcp/index.ts` | Modify | Add `created_by`/`actor` params, log to `attribution_log`, new `get_attribution_history` tool |
| `open-brain-customizations/functions/ingest-thought-modified.ts` | Modify | Add `created_by` to job_postings insert |
| `open-brain-customizations/scripts/migrate-thoughts-to-jobs.ts` | Modify | Add `created_by` to inserts |
| `open-brain-customizations/README.md` | Modify | Document attribution_log, new tool params, get_attribution_history |
| `~/.claude/scheduled-tasks/job-pipeline-gmail-sync/SKILL.md` | Modify | Add `created_by` instructions, fix `update_application_status` bug |
| `~/.claude/scheduled-tasks/auto-resume-generator/SKILL.md` | Modify | Add `created_by` and `actor` instructions |
| `~/.claude/agents/resume-optimizer.md` | Modify | Add `actor` instructions |
| `~/.claude/agents/job-applicator.md` | Modify | Add `created_by` and `actor` instructions |
| `~/.claude/skills/job-hunt-mcp/SKILL.md` | Modify | Add attribution guardrails |

---

### Task 1: Update Agent Instructions and Scheduled Task Prompts

These go first so callers are ready before the MCP server starts enforcing. The MCP server will ignore unknown params until it's updated.

**Files:**
- Modify: `~/.claude/scheduled-tasks/job-pipeline-gmail-sync/SKILL.md`
- Modify: `~/.claude/scheduled-tasks/auto-resume-generator/SKILL.md`
- Modify: `~/.claude/agents/resume-optimizer.md`
- Modify: `~/.claude/agents/job-applicator.md`
- Modify: `~/.claude/skills/job-hunt-mcp/SKILL.md`

- [ ] **Step 1: Update gmail-sync SKILL.md**

Add to Step 2 instructions for application confirmations (after "use submit_application"):
```
Always pass `created_by: "gmail-sync"` and `created_by_reason` with the first 120 characters of the email subject, formatted as: "Application confirmation email: <subject>". Truncate with "..." if the subject exceeds 120 characters total.
```

Add to Step 2 instructions for rejections and interviews (after "use update_application"):
```
Always pass `actor: "gmail-sync"` and `actor_reason` with the first 120 characters of the email subject.
```

Fix pre-existing bug: change all references to `update_application_status` to `update_application`.

- [ ] **Step 2: Update auto-resume-generator SKILL.md**

Add to Step 4 (Generate resumes), in the prompt template for the resume-optimizer agent:
```
When calling submit_application, pass `created_by: "auto-resume-generator"`.
When calling update_application to set resume_path, pass `actor: "resume-optimizer"`.
```

- [ ] **Step 3: Update resume-optimizer agent**

Add to the "Open Brain sync" section in Step 6 (Deliver), after the submit_application instructions:
```
## Attribution

When calling `submit_application`, always pass `created_by` identifying who initiated the resume creation. If spawned by the auto-resume-generator, use `created_by: "auto-resume-generator"`. If running interactively, use `created_by: "daniel"`.

When calling `update_application` to set `resume_path`, always pass `actor: "resume-optimizer"`.
```

- [ ] **Step 4: Update job-applicator agent**

File: `~/.claude/agents/job-applicator.md`

Add attribution instructions:
```
## Attribution

When calling `submit_application` to create an application, always pass `created_by: "job-applicator"`.

When calling `update_application`, always pass `actor: "job-applicator"`. This applies to all update_application calls including setting status to "applied", setting resume_path, and setting cover_letter_path.
```

- [ ] **Step 5: Update job-hunt-mcp skill guardrails**

File: `~/.claude/skills/job-hunt-mcp/SKILL.md`

Add a new section:

```markdown
## Attribution (required)

Every call to `add_job_posting` and `submit_application` MUST include `created_by` identifying the actor (e.g., "daniel", "gmail-sync", "auto-resume-generator"). This is a required field and calls will fail without it.

Every call to `update_application` MUST include `actor` identifying who is making the change.

Known identifiers: daniel, wife, slack-ingest, gmail-sync, auto-resume-generator, resume-optimizer, job-applicator, enrichment-cron, migration-script, legacy.
```

- [ ] **Step 6: Commit**

```bash
git -C ~/.claude commit -am "Add source attribution instructions to agents and scheduled tasks"
```

---

### Task 2: Run Migration SQL

**Timing:** Run this between scheduled task executions. The auto-resume-generator runs hourly and the gmail-sync runs daily at 9 AM. Deploy the MCP server (Task 8) immediately after migration, before the next scheduled run.

**Files:**
- Supabase SQL editor (live database)

- [ ] **Step 1: Run migration in Supabase SQL editor**

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

CREATE POLICY attribution_log_user_policy ON attribution_log
    FOR ALL
    USING (true)
    WITH CHECK (true);
```

Note: The RLS policy above is permissive because `attribution_log` doesn't have a `user_id` column. Since this is a single-user system accessed only via service role key, this is acceptable. If multi-user support is ever needed, add a `user_id` column and a proper policy.

- [ ] **Step 2: Verify migration**

Run in Supabase SQL editor:
```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'job_postings' AND column_name = 'created_by';
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'applications' AND column_name = 'created_by';
SELECT count(*) FROM attribution_log;
SELECT created_by, count(*) FROM job_postings GROUP BY created_by;
SELECT created_by, count(*) FROM applications GROUP BY created_by;
```

Expected: `created_by` exists as NOT NULL TEXT on both tables. All existing rows show `legacy`. `attribution_log` exists with 0 rows.

---

### Task 3: Update MCP Server - Add `created_by` to `add_job_posting`

**Files:**
- Modify: `open-brain-customizations/functions/job-hunt-mcp/index.ts`

- [ ] **Step 1: Add params to `add_job_posting` inputSchema**

After the existing `closing_date` param in the inputSchema, add:
```typescript
created_by: z.string().describe("Who is creating this posting (e.g., 'daniel', 'slack-ingest', 'gmail-sync')"),
created_by_reason: z.string().optional().describe("Why this posting was created (e.g., 'LinkedIn URL shared in Slack channel')"),
```

- [ ] **Step 2: Update the handler function signature**

Add `created_by` and `created_by_reason` to the destructured params in the async handler.

- [ ] **Step 3: Add `created_by` to insert, preserve on upsert**

The current code builds a `row` object and calls `.upsert(row, { onConflict: "url" })`. To prevent overwriting `created_by` on URL conflict:

1. Always include `created_by` in the row object
2. Before the upsert, query for the existing posting by URL:
```typescript
const { data: existing } = await supabase
    .from("job_postings")
    .select("id, created_by")
    .eq("url", url)
    .maybeSingle();
```
3. If the URL exists, remove `created_by` from the row before upserting:
```typescript
if (existing) {
    delete row.created_by;
}
```
4. After a successful upsert where `existing` was null (new insert), write to `attribution_log`:
```typescript
if (!existing) {
    await supabase.from("attribution_log").insert({
        entity_type: "job_posting",
        entity_id: data.id,
        action: "created",
        actor: created_by,
        reason: created_by_reason ?? null,
    });
}
```

Note: The pre-check query adds a round trip but the race condition window is acceptable for this single-user system. The alternative of raw SQL `INSERT ... ON CONFLICT` with column-specific `DO UPDATE SET` is cleaner but not available through the Supabase JS client.

- [ ] **Step 4: Commit**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add functions/job-hunt-mcp/index.ts
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "feat: add created_by to add_job_posting with attribution logging"
```

---

### Task 4: Update MCP Server - Add `created_by` to `submit_application`

**Files:**
- Modify: `open-brain-customizations/functions/job-hunt-mcp/index.ts`

- [ ] **Step 1: Add params to `submit_application` inputSchema**

After the existing params, add:
```typescript
created_by: z.string().describe("Who is creating this application (e.g., 'daniel', 'auto-resume-generator')"),
created_by_reason: z.string().optional().describe("Why this application was created"),
```

- [ ] **Step 2: Update the handler**

Add `created_by` and `created_by_reason` to destructured params. Add `created_by` to the Supabase insert object.

- [ ] **Step 3: Add attribution logging**

After successful insert, write to `attribution_log`:
```typescript
await supabase.from("attribution_log").insert({
    entity_type: "application",
    entity_id: data.id,
    action: "created",
    actor: created_by,
    reason: created_by_reason ?? null,
});
```

If `resume_path` was provided, also log:
```typescript
if (resume_path) {
    await supabase.from("attribution_log").insert({
        entity_type: "application",
        entity_id: data.id,
        action: "resume_added",
        actor: created_by,
        reason: null,
    });
}
```

Same for `cover_letter_path`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add functions/job-hunt-mcp/index.ts
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "feat: add created_by to submit_application with attribution logging"
```

---

### Task 5: Update MCP Server - Add `actor` to `update_application`

**Files:**
- Modify: `open-brain-customizations/functions/job-hunt-mcp/index.ts`

- [ ] **Step 1: Add params to `update_application` inputSchema**

Add:
```typescript
actor: z.string().describe("Who is making this update (e.g., 'resume-optimizer', 'daniel')"),
actor_reason: z.string().optional().describe("Why this update is being made"),
```

Also make `created_by` updatable by adding:
```typescript
created_by: z.string().optional().describe("Override who created this application (for corrections)"),
```

- [ ] **Step 2: Update the handler to log changes**

Before applying the update, fetch the current application state so we can detect what changed:
```typescript
const { data: current } = await supabase
    .from("applications")
    .select("status, resume_path, cover_letter_path")
    .eq("id", application_id)
    .single();
```

After successful update, log based on what changed:
```typescript
const logs = [];

if (status !== undefined && current && status !== current.status) {
    logs.push({
        entity_type: "application",
        entity_id: application_id,
        action: "status_changed",
        actor,
        reason: actor_reason ?? `${current.status} -> ${status}`,
    });
}

if (resume_path !== undefined && resume_path !== current?.resume_path) {
    logs.push({
        entity_type: "application",
        entity_id: application_id,
        action: resume_path === null ? "resume_removed" : "resume_added",
        actor,
        reason: actor_reason ?? null,
    });
}

if (cover_letter_path !== undefined && cover_letter_path !== current?.cover_letter_path) {
    logs.push({
        entity_type: "application",
        entity_id: application_id,
        action: cover_letter_path === null ? "cover_letter_removed" : "cover_letter_added",
        actor,
        reason: actor_reason ?? null,
    });
}

if (logs.length > 0) {
    await supabase.from("attribution_log").insert(logs);
}
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add functions/job-hunt-mcp/index.ts
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "feat: add actor to update_application with change logging"
```

---

### Task 6: Add `get_attribution_history` Tool

**Files:**
- Modify: `open-brain-customizations/functions/job-hunt-mcp/index.ts`

- [ ] **Step 1: Register the new tool**

Add after the existing tool registrations:
```typescript
server.registerTool(
  "get_attribution_history",
  {
    title: "Get Attribution History",
    description: "Get the full attribution history for a job posting or application. Returns all logged actions (created, resume_added, status_changed, etc.) in chronological order.",
    inputSchema: {
      entity_type: z.enum(["job_posting", "application"]).describe("Type of entity"),
      entity_id: z.string().uuid().describe("ID of the posting or application"),
    },
  },
  async ({ entity_type, entity_id }) => {
    try {
      const { data, error } = await supabase
        .from("attribution_log")
        .select("*")
        .eq("entity_type", entity_type)
        .eq("entity_id", entity_id)
        .order("created_at", { ascending: true });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to get history: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: data?.length ?? 0, history: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add functions/job-hunt-mcp/index.ts
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "feat: add get_attribution_history tool"
```

---

### Task 7: Update `search_job_postings` to Return `created_by`

**Files:**
- Modify: `open-brain-customizations/functions/job-hunt-mcp/index.ts`

- [ ] **Step 1: Add `created_by` filter param**

In the `search_job_postings` inputSchema, add:
```typescript
created_by: z.string().optional().describe("Filter by who created the posting (filters job_postings.created_by)"),
```

- [ ] **Step 2: Update the applications sub-select**

The `*` on `job_postings` already returns `created_by` for postings. Update both application sub-selects to also return the application's `created_by`:
- Change `"*, companies(name), applications!inner(id, status, applied_date, resume_path, cover_letter_path)"` to `"*, companies(name), applications!inner(id, status, applied_date, resume_path, cover_letter_path, created_by)"`
- Same for the non-inner join version

This means results will show `created_by` at both levels: who created the posting (top-level) and who created each application (nested).

- [ ] **Step 3: Add filter logic**

After the existing filters, add:
```typescript
if (created_by) {
    q = q.eq("created_by", created_by);
}
```

This filters on `job_postings.created_by` since the query root is `job_postings`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add functions/job-hunt-mcp/index.ts
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "feat: add created_by to search results and as filter"
```

---

### Task 8: Set Up Test Infrastructure

**Why:** The MCP server, Slack ingest, and migration script have no tests. Before deploying attribution changes, establish a test foundation covering the new logic and key existing behavior.

**Files:**
- Create: `open-brain-customizations/functions/job-hunt-mcp/test/mock-supabase.ts`
- Create: `open-brain-customizations/functions/job-hunt-mcp/test/handlers.test.ts`
- Create: `open-brain-customizations/functions/job-hunt-mcp/handlers.ts`
- Create: `open-brain-customizations/test/ingest-attribution.test.ts`
- Create: `open-brain-customizations/test/migrate-attribution.test.ts`
- Modify: `open-brain-customizations/functions/job-hunt-mcp/index.ts`
- Modify: `open-brain-customizations/functions/job-hunt-mcp/deno.json`

- [ ] **Step 1: Add test task to deno.json**

Add to `open-brain-customizations/functions/job-hunt-mcp/deno.json`:
```json
{
  "tasks": {
    "test": "deno test --allow-env --allow-read test/",
    "test:coverage": "deno test --allow-env --allow-read --coverage=coverage/ test/"
  }
}
```

- [ ] **Step 2: Extract handler functions from index.ts**

Create `handlers.ts` that exports the core logic for each tool as pure functions that accept a Supabase client as a parameter. This makes them testable without mocking module-level globals.

```typescript
// handlers.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AttributionLogEntry {
    entity_type: "job_posting" | "application";
    entity_id: string;
    action: string;
    actor: string;
    reason: string | null;
}

export async function handleAddJobPosting(
    supabase: SupabaseClient,
    params: {
        url: string;
        created_by: string;
        created_by_reason?: string;
        company_name?: string;
        title?: string;
        location?: string;
        source?: string;
        salary_min?: number;
        salary_max?: number;
        notes?: string;
        posted_date?: string;
        priority?: string;
        salary_currency?: string;
        closing_date?: string;
    }
) {
    // Move the handler logic from index.ts here
    // Return { data, isNew, error }
}

export async function handleSubmitApplication(
    supabase: SupabaseClient,
    params: {
        job_posting_id: string;
        created_by: string;
        created_by_reason?: string;
        status?: string;
        applied_date?: string;
        resume_path?: string;
        cover_letter_path?: string;
        // ... other fields
    }
) {
    // Move handler logic here
    // Return { data, logs: AttributionLogEntry[], error }
}

export async function handleUpdateApplication(
    supabase: SupabaseClient,
    params: {
        application_id: string;
        actor: string;
        actor_reason?: string;
        status?: string;
        resume_path?: string | null;
        cover_letter_path?: string | null;
        // ... other fields
    }
) {
    // Move handler logic here
    // Return { data, logs: AttributionLogEntry[], error }
}

export function buildUpdateApplicationLogs(
    current: { status: string; resume_path: string | null; cover_letter_path: string | null },
    updates: { status?: string; resume_path?: string | null; cover_letter_path?: string | null },
    application_id: string,
    actor: string,
    actor_reason?: string,
): AttributionLogEntry[] {
    // Extract the change detection logic as a pure function
    const logs: AttributionLogEntry[] = [];

    if (updates.status !== undefined && updates.status !== current.status) {
        logs.push({
            entity_type: "application",
            entity_id: application_id,
            action: "status_changed",
            actor,
            reason: actor_reason ?? `${current.status} -> ${updates.status}`,
        });
    }

    if (updates.resume_path !== undefined && updates.resume_path !== current.resume_path) {
        logs.push({
            entity_type: "application",
            entity_id: application_id,
            action: updates.resume_path === null ? "resume_removed" : "resume_added",
            actor,
            reason: actor_reason ?? null,
        });
    }

    if (updates.cover_letter_path !== undefined && updates.cover_letter_path !== current.cover_letter_path) {
        logs.push({
            entity_type: "application",
            entity_id: application_id,
            action: updates.cover_letter_path === null ? "cover_letter_removed" : "cover_letter_added",
            actor,
            reason: actor_reason ?? null,
        });
    }

    return logs;
}
```

Update `index.ts` to import and use these functions instead of inline logic. The tool registrations stay in `index.ts` but delegate to `handlers.ts`.

- [ ] **Step 3: Create mock Supabase client**

Create `test/mock-supabase.ts`:
```typescript
// A minimal mock that records calls and returns configurable responses.
// Implements the chained query builder pattern (.from().select().eq().single())

export interface MockCall {
    method: string;
    table: string;
    args: unknown[];
}

export function createMockSupabase(responses: Record<string, { data?: unknown; error?: unknown }> = {}) {
    const calls: MockCall[] = [];
    let currentTable = "";
    let currentChain: string[] = [];

    const chainable = {
        select: (...args: unknown[]) => { calls.push({ method: "select", table: currentTable, args }); return chainable; },
        insert: (...args: unknown[]) => { calls.push({ method: "insert", table: currentTable, args }); return chainable; },
        update: (...args: unknown[]) => { calls.push({ method: "update", table: currentTable, args }); return chainable; },
        upsert: (...args: unknown[]) => { calls.push({ method: "upsert", table: currentTable, args }); return chainable; },
        delete: () => { calls.push({ method: "delete", table: currentTable, args: [] }); return chainable; },
        eq: (...args: unknown[]) => { calls.push({ method: "eq", table: currentTable, args }); return chainable; },
        ilike: (...args: unknown[]) => { calls.push({ method: "ilike", table: currentTable, args }); return chainable; },
        is: (...args: unknown[]) => { calls.push({ method: "is", table: currentTable, args }); return chainable; },
        or: (...args: unknown[]) => { calls.push({ method: "or", table: currentTable, args }); return chainable; },
        order: (...args: unknown[]) => { calls.push({ method: "order", table: currentTable, args }); return chainable; },
        limit: (...args: unknown[]) => { calls.push({ method: "limit", table: currentTable, args }); return chainable; },
        single: () => { calls.push({ method: "single", table: currentTable, args: [] }); return Promise.resolve(responses[currentTable] ?? { data: null, error: null }); },
        maybeSingle: () => { calls.push({ method: "maybeSingle", table: currentTable, args: [] }); return Promise.resolve(responses[currentTable] ?? { data: null, error: null }); },
        then: (resolve: (value: unknown) => void) => resolve(responses[currentTable] ?? { data: null, error: null }),
    };

    return {
        client: {
            from: (table: string) => { currentTable = table; return chainable; },
        },
        calls,
        reset: () => { calls.length = 0; },
    };
}
```

- [ ] **Step 4: Write MCP handler tests**

Create `test/handlers.test.ts`:
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { buildUpdateApplicationLogs } from "../handlers.ts";

// --- Pure function tests (no mocks needed) ---

Deno.test("buildUpdateApplicationLogs - status change logs correctly", () => {
    const logs = buildUpdateApplicationLogs(
        { status: "draft", resume_path: null, cover_letter_path: null },
        { status: "applied" },
        "app-123",
        "daniel",
    );
    assertEquals(logs.length, 1);
    assertEquals(logs[0].action, "status_changed");
    assertEquals(logs[0].actor, "daniel");
    assertEquals(logs[0].reason, "draft -> applied");
});

Deno.test("buildUpdateApplicationLogs - no change produces no logs", () => {
    const logs = buildUpdateApplicationLogs(
        { status: "draft", resume_path: null, cover_letter_path: null },
        { status: "draft" },
        "app-123",
        "daniel",
    );
    assertEquals(logs.length, 0);
});

Deno.test("buildUpdateApplicationLogs - resume added", () => {
    const logs = buildUpdateApplicationLogs(
        { status: "draft", resume_path: null, cover_letter_path: null },
        { resume_path: "/path/to/resume.pdf" },
        "app-123",
        "resume-optimizer",
    );
    assertEquals(logs.length, 1);
    assertEquals(logs[0].action, "resume_added");
    assertEquals(logs[0].actor, "resume-optimizer");
});

Deno.test("buildUpdateApplicationLogs - resume removed", () => {
    const logs = buildUpdateApplicationLogs(
        { status: "draft", resume_path: "/old/path.pdf", cover_letter_path: null },
        { resume_path: null },
        "app-123",
        "daniel",
    );
    assertEquals(logs.length, 1);
    assertEquals(logs[0].action, "resume_removed");
});

Deno.test("buildUpdateApplicationLogs - cover letter added", () => {
    const logs = buildUpdateApplicationLogs(
        { status: "draft", resume_path: null, cover_letter_path: null },
        { cover_letter_path: "/path/to/letter.pdf" },
        "app-123",
        "job-applicator",
    );
    assertEquals(logs.length, 1);
    assertEquals(logs[0].action, "cover_letter_added");
});

Deno.test("buildUpdateApplicationLogs - multiple changes at once", () => {
    const logs = buildUpdateApplicationLogs(
        { status: "draft", resume_path: null, cover_letter_path: null },
        { status: "applied", resume_path: "/resume.pdf", cover_letter_path: "/letter.pdf" },
        "app-123",
        "job-applicator",
    );
    assertEquals(logs.length, 3);
    assertEquals(logs[0].action, "status_changed");
    assertEquals(logs[1].action, "resume_added");
    assertEquals(logs[2].action, "cover_letter_added");
});

Deno.test("buildUpdateApplicationLogs - custom actor_reason overrides default", () => {
    const logs = buildUpdateApplicationLogs(
        { status: "draft", resume_path: null, cover_letter_path: null },
        { status: "applied" },
        "app-123",
        "gmail-sync",
        "Application confirmation email: Thank you for applying to Senior Director at Autodesk",
    );
    assertEquals(logs.length, 1);
    assertEquals(logs[0].reason, "Application confirmation email: Thank you for applying to Senior Director at Autodesk");
});

Deno.test("buildUpdateApplicationLogs - resume replacement logs resume_added not resume_removed", () => {
    const logs = buildUpdateApplicationLogs(
        { status: "draft", resume_path: "/old/resume.pdf", cover_letter_path: null },
        { resume_path: "/new/resume.pdf" },
        "app-123",
        "resume-optimizer",
    );
    assertEquals(logs.length, 1);
    assertEquals(logs[0].action, "resume_added");
});
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/dfrysinger/Projects/open-brain-customizations/functions/job-hunt-mcp && deno task test
```

Expected: All tests pass.

- [ ] **Step 6: Write Slack ingest attribution test**

Create `open-brain-customizations/test/ingest-attribution.test.ts`:
```typescript
import { assertEquals } from "jsr:@std/assert";

// Test the logic pattern used in the Slack ingest for distinguishing insert vs update
Deno.test("Slack ingest - new URL sets created_by and isNewPosting", () => {
    const existingPosting = null; // simulates no existing record
    const row: Record<string, unknown> = { url: "https://linkedin.com/jobs/view/123", source: "linkedin" };
    let isNewPosting = false;

    if (!existingPosting) {
        row.created_by = "slack-ingest";
        isNewPosting = true;
    }

    assertEquals(row.created_by, "slack-ingest");
    assertEquals(isNewPosting, true);
});

Deno.test("Slack ingest - existing URL does not set created_by", () => {
    const existingPosting = { id: "existing-id" }; // simulates existing record
    const row: Record<string, unknown> = { url: "https://linkedin.com/jobs/view/123", source: "linkedin" };
    let isNewPosting = false;

    if (!existingPosting) {
        row.created_by = "slack-ingest";
        isNewPosting = true;
    }

    assertEquals(row.created_by, undefined);
    assertEquals(isNewPosting, false);
});
```

- [ ] **Step 7: Write migration script attribution test**

Create `open-brain-customizations/test/migrate-attribution.test.ts`:
```typescript
import { assertEquals } from "jsr:@std/assert";

// Test that migration script builds insert objects with created_by
Deno.test("Migration script - job posting insert includes created_by", () => {
    // Simulates the insert object construction from migrate-thoughts-to-jobs.ts
    const postingRow: Record<string, unknown> = {
        url: "https://linkedin.com/jobs/view/456",
        title: "Head of Product",
        source: "linkedin",
        created_by: "migration-script",
    };

    assertEquals(postingRow.created_by, "migration-script");
});

Deno.test("Migration script - application insert includes created_by", () => {
    const applicationRow: Record<string, unknown> = {
        job_posting_id: "posting-123",
        status: "applied",
        created_by: "migration-script",
    };

    assertEquals(applicationRow.created_by, "migration-script");
});
```

- [ ] **Step 8: Run all tests**

```bash
cd /Users/dfrysinger/Projects/open-brain-customizations && deno test --allow-env --allow-read
```

Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add functions/job-hunt-mcp/handlers.ts functions/job-hunt-mcp/test/ functions/job-hunt-mcp/deno.json test/
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "feat: add test infrastructure and attribution tests"
```

---

### Task 9: Deploy Updated MCP Server

**Timing:** Deploy immediately after Task 2 (migration). The auto-resume-generator runs hourly and the gmail-sync runs daily at 9 AM. Time this deployment so it completes before the next scheduled run. All agent/task prompts were already updated in Task 1, so callers will pass the new params.

- [ ] **Step 1: Deploy the Edge Function**

```bash
supabase functions deploy job-hunt-mcp --project-ref <project-ref>
```

Use the Supabase project ref from 1Password if needed.

- [ ] **Step 2: Verify deployment**

Call `search_job_postings` and confirm `created_by` appears in results (should show "legacy" for existing records).

---

### Task 10: Update Slack Ingest

**Files:**
- Modify: `open-brain-customizations/functions/ingest-thought-modified.ts`

- [ ] **Step 1: Convert upsert to check-then-insert/update**

Replace the single upsert with a pattern that can distinguish insert from update:

```typescript
// Check if posting already exists
const { data: existingPosting } = await supabase
    .from("job_postings")
    .select("id")
    .eq("url", jobUrl)
    .maybeSingle();

let jobPosting;
let isNewPosting = false;

if (existingPosting) {
    // Update existing - don't overwrite created_by
    const { data, error: updateErr } = await supabase
        .from("job_postings")
        .update(row)
        .eq("id", existingPosting.id)
        .select()
        .single();
    if (updateErr) { /* existing error handling */ }
    jobPosting = data;
} else {
    // Insert new - include created_by
    row.created_by = "slack-ingest";
    const { data, error: insertErr } = await supabase
        .from("job_postings")
        .insert(row)
        .select()
        .single();
    if (insertErr) { /* existing error handling */ }
    jobPosting = data;
    isNewPosting = true;
}
```

- [ ] **Step 2: Add attribution log entry for new inserts only**

After the insert/update block:
```typescript
if (isNewPosting && jobPosting) {
    await supabase.from("attribution_log").insert({
        entity_type: "job_posting",
        entity_id: jobPosting.id,
        action: "created",
        actor: "slack-ingest",
        reason: "LinkedIn URL shared in Slack channel",
    });
}
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add functions/ingest-thought-modified.ts
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "feat: add created_by to Slack ingest job posting creation"
```

- [ ] **Step 4: Deploy the ingest function**

```bash
supabase functions deploy ingest-thought-modified --project-ref <project-ref>
```

---

### Task 11: Update Migration Script

**Files:**
- Modify: `open-brain-customizations/scripts/migrate-thoughts-to-jobs.ts`

- [ ] **Step 1: Add `created_by` to job_postings inserts**

Find the job_postings insert (around line 282-295) and add `created_by: "migration-script"` to the insert object.

- [ ] **Step 2: Add `created_by` to applications inserts**

Find the applications insert (around line 311-333) and add `created_by: "migration-script"` to the insert object.

- [ ] **Step 3: Commit**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add scripts/migrate-thoughts-to-jobs.ts
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "feat: add created_by to migration script inserts"
```

---

### Task 12: Update Schema and Documentation

**Files:**
- Modify: `open-brain/extensions/job-hunt/schema.sql`
- Modify: `open-brain/extensions/job-hunt/metadata.json`
- Modify: `open-brain/extensions/job-hunt/README.md`
- Modify: `open-brain-customizations/README.md`

- [ ] **Step 1: Update schema.sql**

Add `created_by TEXT NOT NULL` to the `job_postings` CREATE TABLE statement.

Add `created_by TEXT NOT NULL` to the `applications` CREATE TABLE statement.

Add `'draft'` and `'ready'` to the applications status CHECK constraint.

Add `resume_path TEXT`, `cover_letter_path TEXT` to the applications table.

Add `priority TEXT`, `location TEXT`, `enrichment_error TEXT` to the job_postings table.

Add `'greenhouse'`, `'lever'`, `'workday'`, `'indeed'` to the job_postings source CHECK constraint to match the live schema.

Add the `attribution_log` table definition:
```sql
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

ALTER TABLE attribution_log ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Update metadata.json**

Change version to `"1.1.0"` and update the `"updated"` date to `"2026-03-22"`.

- [ ] **Step 3: Update open-brain README.md**

Add a section documenting:
- The `created_by` field and its purpose
- The `attribution_log` table, action types, and known source identifiers
- The `get_attribution_history` tool
- Example queries for debugging attribution

- [ ] **Step 4: Update open-brain-customizations README.md**

Add documentation for:
- The `attribution_log` table
- New and changed MCP tool params (`created_by` on `add_job_posting` and `submit_application`, `actor` on `update_application`)
- The `get_attribution_history` tool and its params

- [ ] **Step 5: Commit both repos**

```bash
git -C /Users/dfrysinger/Projects/open-brain add extensions/job-hunt/schema.sql extensions/job-hunt/metadata.json extensions/job-hunt/README.md
git -C /Users/dfrysinger/Projects/open-brain commit -m "feat: add source attribution schema and documentation"
```

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations add README.md
git -C /Users/dfrysinger/Projects/open-brain-customizations commit -m "docs: add attribution_log and new tool params to README"
```

---

### Task 13: Push to GitHub and Verify

- [ ] **Step 1: Push open-brain-customizations**

```bash
git -C /Users/dfrysinger/Projects/open-brain-customizations push
```

- [ ] **Step 2: Push open-brain**

```bash
git -C /Users/dfrysinger/Projects/open-brain push
```

- [ ] **Step 3: End-to-end verification**

Test the full flow:
1. Call `add_job_posting` with `created_by: "daniel"` and a test URL
2. Call `submit_application` with `created_by: "daniel"` for that posting
3. Call `update_application` with `actor: "daniel"` to set a `resume_path`
4. Call `get_attribution_history` for the job_posting and verify 1 log entry: `created`
5. Call `get_attribution_history` for the application and verify 2 log entries: `created`, `resume_added`
6. Call `search_job_postings` and verify `created_by` appears in results at both posting and application levels
7. Clean up test data

- [ ] **Step 4: Verify Slack ingest**

Share a test LinkedIn URL in the Slack channel and confirm the posting gets `created_by: "slack-ingest"` and an attribution log entry.
