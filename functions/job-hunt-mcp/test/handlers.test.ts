import { assertEquals } from "jsr:@std/assert";
import { buildUpdateApplicationLogs } from "../handlers.ts";

const APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

Deno.test("status change logs correctly", () => {
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: null, cover_letter_path: null },
    { status: "applied" },
    APP_ID,
    "daniel",
  );

  assertEquals(logs.length, 1);
  assertEquals(logs[0].action, "status_changed");
  assertEquals(logs[0].actor, "daniel");
  assertEquals(logs[0].reason, "draft -> applied");
  assertEquals(logs[0].entity_type, "application");
  assertEquals(logs[0].entity_id, APP_ID);
});

Deno.test("no change produces no logs", () => {
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: null, cover_letter_path: null },
    { status: "draft" },
    APP_ID,
    "daniel",
  );

  assertEquals(logs.length, 0);
});

Deno.test("resume added (null -> path)", () => {
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: null, cover_letter_path: null },
    { resume_path: "/resumes/v1.pdf" },
    APP_ID,
    "resume-optimizer",
  );

  assertEquals(logs.length, 1);
  assertEquals(logs[0].action, "resume_added");
  assertEquals(logs[0].actor, "resume-optimizer");
  assertEquals(logs[0].reason, null);
});

Deno.test("resume removed (path -> null)", () => {
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: "/resumes/v1.pdf", cover_letter_path: null },
    { resume_path: null },
    APP_ID,
    "daniel",
  );

  assertEquals(logs.length, 1);
  assertEquals(logs[0].action, "resume_removed");
});

Deno.test("cover letter added", () => {
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: null, cover_letter_path: null },
    { cover_letter_path: "/letters/cl.pdf" },
    APP_ID,
    "cover-letter-agent",
  );

  assertEquals(logs.length, 1);
  assertEquals(logs[0].action, "cover_letter_added");
  assertEquals(logs[0].actor, "cover-letter-agent");
});

Deno.test("multiple changes at once produce multiple logs", () => {
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: null, cover_letter_path: null },
    { status: "applied", resume_path: "/resumes/v1.pdf", cover_letter_path: "/letters/cl.pdf" },
    APP_ID,
    "daniel",
  );

  assertEquals(logs.length, 3);
  const actions = logs.map((l) => l.action).sort();
  assertEquals(actions, ["cover_letter_added", "resume_added", "status_changed"]);
});

Deno.test("custom actor_reason overrides default", () => {
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: null, cover_letter_path: null },
    { status: "applied" },
    APP_ID,
    "daniel",
    "Submitted via Workday agent",
  );

  assertEquals(logs.length, 1);
  assertEquals(logs[0].reason, "Submitted via Workday agent");
});

Deno.test("resume replacement (old path -> new path) logs resume_added", () => {
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: "/resumes/v1.pdf", cover_letter_path: null },
    { resume_path: "/resumes/v2.pdf" },
    APP_ID,
    "resume-optimizer",
  );

  assertEquals(logs.length, 1);
  assertEquals(logs[0].action, "resume_added");
});

Deno.test("omitted fields do not produce logs", () => {
  // Only status is provided but matches current; resume_path and cover_letter_path are omitted (undefined)
  const logs = buildUpdateApplicationLogs(
    { status: "draft", resume_path: "/resumes/v1.pdf", cover_letter_path: "/letters/cl.pdf" },
    {},
    APP_ID,
    "daniel",
  );

  assertEquals(logs.length, 0);
});
