import { assertEquals } from "jsr:@std/assert";

/**
 * Tests for migration script attribution logic.
 * These test the business rules for how migrated records get attributed.
 */

/** Simulates building a job posting insert row for migration. */
function buildMigrationJobPostingRow(url: string, title: string) {
  return {
    url,
    title,
    created_by: "migration-script",
  };
}

/** Simulates building an application insert row for migration. */
function buildMigrationApplicationRow(
  jobPostingId: string,
  status: string,
) {
  return {
    job_posting_id: jobPostingId,
    status,
    created_by: "migration-script",
  };
}

Deno.test("job posting insert includes created_by: migration-script", () => {
  const row = buildMigrationJobPostingRow(
    "https://example.com/jobs/456",
    "Senior PM",
  );

  assertEquals(row.created_by, "migration-script");
  assertEquals(row.url, "https://example.com/jobs/456");
  assertEquals(row.title, "Senior PM");
});

Deno.test("application insert includes created_by: migration-script", () => {
  const row = buildMigrationApplicationRow(
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "applied",
  );

  assertEquals(row.created_by, "migration-script");
  assertEquals(row.job_posting_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assertEquals(row.status, "applied");
});
