// scripts/migrate-thoughts-to-jobs.ts
//
// Extracts job-related thoughts from Open Brain and parses them into
// structured data for companies, job_postings, and applications tables.
//
// Usage:
//   deno run --allow-all scripts/migrate-thoughts-to-jobs.ts          # dry run → migration-dry-run.json
//   deno run --allow-all scripts/migrate-thoughts-to-jobs.ts --commit # actually insert into DB

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

// --- 1Password credential reader ---
async function readOp(item: string, field: string): Promise<string> {
  const proc = new Deno.Command("bash", {
    args: ["-c", `OP_SERVICE_ACCOUNT_TOKEN=$(textutil -convert txt -stdout ~/1password\\ service.rtf) op item get "${item}" --vault ClawdBot --fields label=${field} --reveal`],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`1Password lookup failed for ${item}/${field}: ${stderr || 'unknown error (exit code ' + output.code + ')'}`);
  }
  const value = new TextDecoder().decode(output.stdout).trim();
  if (!value) {
    throw new Error(`1Password returned empty value for ${item}/${field}`);
  }
  return value;
}

// --- Supabase client ---
async function getSupabaseClient(): Promise<SupabaseClient> {
  const url = await readOp("Open Brain - Supabase", "project_url");
  const key = await readOp("Open Brain - Supabase", "service_role_key");
  return createClient(url, key);
}

// --- OpenRouter LLM call ---
async function callOpenRouter(apiKey: string, content: string): Promise<Record<string, unknown>[]> {
  const PARSE_PROMPT = `Parse this job application note into structured JSON.

If the text describes a SINGLE job, return a single JSON object.
If the text contains MULTIPLE job listings or URLs, return a JSON array of objects.

Each object should have:
{
  "company": "company name or null",
  "title": "job title or null",
  "url": "LinkedIn or other job URL found in the text, or null",
  "status": "one of: draft, applied, screening, interviewing, offer, accepted, rejected, withdrawn, or null",
  "applied_date": "YYYY-MM-DD or null",
  "location": "job location or null",
  "source": "linkedin, company-site, referral, recruiter, other, or null",
  "priority": "high, medium, or low — set to high if the job was specifically recommended or flagged as interesting, otherwise null",
  "notes": "any additional context worth preserving (cover letter notes, etc.) — do NOT put networking contacts here",
  "contacts": [
    {
      "name": "person's name",
      "linkedin_url": "their LinkedIn URL or null",
      "role_in_process": "one of: recruiter, hiring_manager, referral, interviewer, other",
      "networked": "true if already reached out/contacted, false if not yet",
      "notes": "any context about this contact"
    }
  ]
}
IMPORTANT: All dates without an explicit year are in 2026. For example, "1/15" means "2026-01-15", "2/25" means "2026-02-25".
Only extract what is explicitly stated. Do not guess.`;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: PARSE_PROMPT },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${body}`);
  }

  const json = await resp.json();
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Empty response from OpenRouter");
  let result;
  try {
    result = JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Failed to parse OpenRouter response as JSON. Raw content: ${raw.slice(0, 500)}`);
  }
  // Normalize: always return an array
  // Handle cases where LLM wraps array in an object like {"jobs": [...]}
  if (Array.isArray(result)) return result;
  const values = Object.values(result);
  if (values.length === 1 && Array.isArray(values[0])) return values[0] as Record<string, unknown>[];
  return [result];
}

// --- Types ---
interface ParsedEntry {
  thought_id: string;
  thought_content: string;
  parsed: Record<string, unknown> | null;
  parse_error: string | null;
}

// Flattened entry — one per job (multi-job thoughts produce multiple entries)
interface FlatEntry extends ParsedEntry {
  entry_index: number; // 0 for single-job thoughts, 0..N for multi-job
}

// --- Query job-related thoughts ---
async function fetchJobThoughts(supabase: SupabaseClient) {
  // Supabase doesn't support OR on contains for jsonb arrays in a single query,
  // so we query both topics and deduplicate.
  const { data: set1, error: err1 } = await supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .contains("metadata", { topics: ["job hunt"] });

  if (err1) throw new Error(`Query error (job hunt): ${err1.message}`);

  const { data: set2, error: err2 } = await supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .contains("metadata", { topics: ["job search"] });

  if (err2) throw new Error(`Query error (job search): ${err2.message}`);

  // Also catch thoughts tagged with "jobs" topic (e.g., messages with multiple job links)
  const { data: set3, error: err3 } = await supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .contains("metadata", { topics: ["jobs"] });

  if (err3) throw new Error(`Query error (jobs): ${err3.message}`);

  // Deduplicate by id
  const seen = new Set<string>();
  const combined = [];
  for (const row of [...(set1 ?? []), ...(set2 ?? []), ...(set3 ?? [])]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      combined.push(row);
    }
  }
  return combined;
}

// --- Resume/Cover Letter file detection ---
const RESUME_BASE_DIR = `${Deno.env.get("HOME")}/Library/CloudStorage/Dropbox/Resume/2026 Resume - Claude`;

async function findResumeFiles(companyName: string): Promise<{ resumePath: string | null; coverLetterPath: string | null }> {
  let resumePath: string | null = null;
  let coverLetterPath: string | null = null;

  // Try to find a matching company folder (case-insensitive, partial match)
  try {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(RESUME_BASE_DIR)) {
      if (entry.isDirectory) entries.push(entry.name);
    }

    // Find best matching folder — try exact, then case-insensitive, then partial
    const lower = companyName.toLowerCase();
    let folderName = entries.find(e => e === companyName)
      ?? entries.find(e => e.toLowerCase() === lower)
      ?? entries.find(e => lower.includes(e.toLowerCase()) || e.toLowerCase().includes(lower));

    if (!folderName) return { resumePath: null, coverLetterPath: null };

    const folderPath = `${RESUME_BASE_DIR}/${folderName}`;
    const files: string[] = [];
    for await (const entry of Deno.readDir(folderPath)) {
      if (entry.isFile) files.push(entry.name);
    }

    // Find latest resume (skip OLD files, prefer .docx, then .pdf)
    const resumeFiles = files
      .filter(f => f.toLowerCase().includes("resume") && !f.includes("OLD"))
      .sort();
    const resumeDocx = resumeFiles.find(f => f.endsWith(".docx"));
    const resumePdf = resumeFiles.find(f => f.endsWith(".pdf"));
    if (resumeDocx) resumePath = `${folderPath}/${resumeDocx}`;
    else if (resumePdf) resumePath = `${folderPath}/${resumePdf}`;

    // Find latest cover letter (skip OLD files)
    const coverFiles = files
      .filter(f => f.toLowerCase().includes("cover letter") && !f.includes("OLD"))
      .sort();
    const coverDocx = coverFiles.find(f => f.endsWith(".docx"));
    const coverPdf = coverFiles.find(f => f.endsWith(".pdf"));
    if (coverDocx) coverLetterPath = `${folderPath}/${coverDocx}`;
    else if (coverPdf) coverLetterPath = `${folderPath}/${coverPdf}`;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn(`Warning: resume folder lookup error: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { resumePath, coverLetterPath };
}

// --- Commit mode: insert into DB ---
async function commitToDatabase(supabase: SupabaseClient, entries: ParsedEntry[]) {
  let companiesInserted = 0;
  let postingsInserted = 0;
  let applicationsInserted = 0;
  let contactsInserted = 0;

  for (const entry of entries) {
    if (entry.parse_error || !entry.parsed) continue;

    const p = entry.parsed;
    let companyId: string | null = null;

    // Upsert company (deduplicate by case-insensitive name)
    if (p.company && typeof p.company === "string") {
      const { data: existing } = await supabase
        .from("companies")
        .select("id")
        .ilike("name", p.company)
        .limit(1)
        .single();

      if (existing) {
        companyId = existing.id;
      } else {
        const { data: newCo, error: coErr } = await supabase
          .from("companies")
          .insert({ name: p.company })
          .select("id")
          .single();
        if (coErr) {
          console.error(`  Failed to insert company "${p.company}": ${coErr.message}`);
        } else {
          companyId = newCo?.id ?? null;
          if (companyId) companiesInserted++;
        }
      }
    }

    // Upsert job_posting by url (UNIQUE constraint)
    const postingRow: Record<string, unknown> = {
      company_id: companyId,
      notes: p.notes ?? null,
      source: p.source ?? null,
      location: p.location ?? null,
      priority: p.priority ?? "medium",
    };
    if (p.title) postingRow.title = p.title;
    if (p.url) postingRow.url = p.url;

    let postingId: string | null = null;

    if (p.url && typeof p.url === "string") {
      // Check if posting with this URL already exists
      const { data: existingPosting } = await supabase
        .from("job_postings")
        .select("id")
        .eq("url", p.url)
        .limit(1)
        .single();

      if (existingPosting) {
        postingId = existingPosting.id;
        console.log(`  Posting already exists for URL: ${p.url}`);
      } else {
        const { data: newPosting, error: postErr } = await supabase
          .from("job_postings")
          .insert(postingRow)
          .select("id")
          .single();
        if (postErr) {
          console.error(`  Failed to insert posting: ${postErr.message}`);
          continue;
        }
        postingId = newPosting?.id ?? null;
        if (postingId) postingsInserted++;
      }
    } else {
      // No URL — just insert (no dedup possible)
      const { data: newPosting, error: postErr } = await supabase
        .from("job_postings")
        .insert(postingRow)
        .select("id")
        .single();
      if (postErr) {
        console.error(`  Failed to insert posting: ${postErr.message}`);
        continue;
      }
      postingId = newPosting?.id ?? null;
      if (postingId) postingsInserted++;
    }

    // Create application if status is non-null
    if (postingId && p.status && typeof p.status === "string") {
      const appRow: Record<string, unknown> = {
        job_posting_id: postingId,
        status: p.status,
        notes: p.notes ?? null,
      };
      if (p.applied_date) appRow.applied_date = p.applied_date;

      // Look for resume and cover letter in the Dropbox folder
      const companyName = p.company as string | null;
      if (companyName) {
        const { resumePath, coverLetterPath } = await findResumeFiles(companyName);
        if (resumePath) appRow.resume_path = resumePath;
        if (coverLetterPath) appRow.cover_letter_path = coverLetterPath;
      }

      const { error: appErr } = await supabase
        .from("applications")
        .insert(appRow);
      if (appErr) {
        console.error(`  Failed to insert application: ${appErr.message}`);
      } else {
        applicationsInserted++;
      }
    }

    // Insert job_contacts if any
    const contacts = p.contacts as Array<Record<string, unknown>> | undefined;
    if (contacts && Array.isArray(contacts) && contacts.length > 0) {
      for (const contact of contacts) {
        if (!contact.name) continue;
        // If networked=true, set last_contacted to applied_date (or now if no date)
        const wasNetworked = contact.networked === true || contact.networked === "true";
        const appliedDate = p.applied_date as string | null;
        const contactRow: Record<string, unknown> = {
          company_id: companyId,
          name: contact.name,
          linkedin_url: contact.linkedin_url ?? null,
          role_in_process: contact.role_in_process ?? null,
          notes: contact.notes ?? null,
          last_contacted: wasNetworked ? (appliedDate ?? new Date().toISOString()) : null,
        };
        const { error: contactErr } = await supabase
          .from("job_contacts")
          .insert(contactRow);
        if (contactErr) {
          console.error(`  Failed to insert contact "${contact.name}": ${contactErr.message}`);
        } else {
          contactsInserted++;
        }
      }
    }
  }

  return { companiesInserted, postingsInserted, applicationsInserted, contactsInserted };
}

// --- Main ---
async function main() {
  const commitMode = Deno.args.includes("--commit");
  console.log(`[${new Date().toISOString()}] Migration script starting (mode: ${commitMode ? "COMMIT" : "DRY RUN"})...`);

  console.log("Reading credentials from 1Password...");
  const [supabase, openRouterKey] = await Promise.all([
    getSupabaseClient(),
    readOp("Open Brain - OpenRouter", "credential"),
  ]);

  console.log("Fetching job-related thoughts...");
  const thoughts = await fetchJobThoughts(supabase);
  console.log(`Found ${thoughts.length} job-related thought(s).`);

  if (thoughts.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  // Parse each thought with OpenRouter
  const results: FlatEntry[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < thoughts.length; i++) {
    const thought = thoughts[i];
    console.log(`  Parsing thought ${i + 1}/${thoughts.length} (${thought.id})...`);
    const truncated = thought.content.length > 200
      ? thought.content.slice(0, 200) + "..."
      : thought.content;

    try {
      const parsedArray = await callOpenRouter(openRouterKey, thought.content);
      if (parsedArray.length > 1) {
        console.log(`    → Multi-job entry: ${parsedArray.length} jobs found`);
      }
      // For multi-job entries: if any entry has a priority, apply it to all in the group
      const groupPriority = parsedArray.length > 1
        ? (parsedArray.find(e => e.priority)?.priority as string ?? "medium")
        : null;

      for (let j = 0; j < parsedArray.length; j++) {
        // Look up resume/cover letter paths for dry-run visibility
        const co = parsedArray[j].company as string | null;
        let resumeInfo: { resumePath: string | null; coverLetterPath: string | null } = { resumePath: null, coverLetterPath: null };
        if (co) resumeInfo = await findResumeFiles(co);
        // Default priority: use group priority for multi-job, otherwise medium
        const entry = { ...parsedArray[j] };
        if (!entry.priority) entry.priority = groupPriority ?? "medium";
        results.push({
          thought_id: thought.id,
          thought_content: truncated,
          parsed: { ...entry, _resume_path: resumeInfo.resumePath, _cover_letter_path: resumeInfo.coverLetterPath },
          parse_error: null,
          entry_index: j,
        });
      }
      successCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        thought_id: thought.id,
        thought_content: truncated,
        parsed: null,
        parse_error: msg,
        entry_index: 0,
      });
      failCount++;
    }

    // Rate limit delay (skip after last item)
    if (i < thoughts.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (commitMode) {
    console.log("\nCommitting to database...");
    const stats = await commitToDatabase(supabase, results);

    console.log("\n--- Summary ---");
    console.log(`Total thoughts found:    ${thoughts.length}`);
    console.log(`Successfully parsed:     ${successCount}`);
    console.log(`Failed to parse:         ${failCount}`);
    console.log(`Companies inserted:      ${stats.companiesInserted}`);
    console.log(`Job postings inserted:   ${stats.postingsInserted}`);
    console.log(`Applications inserted:   ${stats.applicationsInserted}`);
    console.log(`Contacts inserted:       ${stats.contactsInserted}`);
  } else {
    // Dry run: write results to JSON
    const outPath = new URL("./migration-dry-run.json", import.meta.url).pathname;
    await Deno.writeTextFile(outPath, JSON.stringify(results, null, 2));
    console.log(`\nDry run results written to: ${outPath}`);

    console.log("\n--- Summary ---");
    console.log(`Total thoughts found:    ${thoughts.length}`);
    console.log(`Successfully parsed:     ${successCount}`);
    console.log(`Failed to parse:         ${failCount}`);
    console.log("\nReview the output file, then re-run with --commit to insert into the database.");
  }
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
