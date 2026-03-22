import { assertEquals } from "jsr:@std/assert";

/**
 * Tests for Slack ingest attribution logic.
 * These test the business rules without requiring a database connection.
 */

/** Simulates the ingest decision logic for a job posting URL. */
function simulateIngestDecision(
  url: string,
  existingUrls: Set<string>,
): { isNewPosting: boolean; created_by: string | null } {
  const isNewPosting = !existingUrls.has(url);
  return {
    isNewPosting,
    created_by: isNewPosting ? "slack-ingest" : null,
  };
}

Deno.test("new URL sets created_by and isNewPosting=true", () => {
  const existingUrls = new Set<string>();
  const result = simulateIngestDecision(
    "https://example.com/jobs/123",
    existingUrls,
  );

  assertEquals(result.isNewPosting, true);
  assertEquals(result.created_by, "slack-ingest");
});

Deno.test("existing URL does NOT set created_by", () => {
  const existingUrls = new Set(["https://example.com/jobs/123"]);
  const result = simulateIngestDecision(
    "https://example.com/jobs/123",
    existingUrls,
  );

  assertEquals(result.isNewPosting, false);
  assertEquals(result.created_by, null);
});
