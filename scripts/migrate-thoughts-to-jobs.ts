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
  const { stdout } = await proc.output();
  return new TextDecoder().decode(stdout).trim();
}

// --- Supabase client ---
async function getSupabaseClient(): Promise<SupabaseClient> {
  const url = await readOp("Open Brain - Supabase", "project_url");
  const key = await readOp("Open Brain - Supabase", "service_role_key");
  return createClient(url, key);
}

// --- OpenRouter LLM call ---
async function callOpenRouter(apiKey: string, content: string): Promise<Record<string, unknown>> {
  const PARSE_PROMPT = `Parse this job application note into structured JSON. Return:
{
  "company": "company name or null",
  "title": "job title or null",
  "url": "LinkedIn or other job URL found in the text, or null",
  "status": "one of: draft, applied, screening, interviewing, offer, accepted, rejected, withdrawn, or null",
  "applied_date": "YYYY-MM-DD or null",
  "location": "job location or null",
  "source": "linkedin, company-site, referral, recruiter, other, or null",
  "notes": "any additional context worth preserving (networking contacts, cover letter notes, etc.)"
}
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
  return JSON.parse(raw);
}

// --- Types ---
interface ParsedEntry {
  thought_id: string;
  thought_content: string;
  parsed: Record<string, unknown> | null;
  parse_error: string | null;
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

  // Deduplicate by id
  const seen = new Set<string>();
  const combined = [];
  for (const row of [...(set1 ?? []), ...(set2 ?? [])]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      combined.push(row);
    }
  }
  return combined;
}

// --- Commit mode: insert into DB ---
async function commitToDatabase(supabase: SupabaseClient, entries: ParsedEntry[]) {
  let companiesInserted = 0;
  let postingsInserted = 0;
  let applicationsInserted = 0;

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

      const { error: appErr } = await supabase
        .from("applications")
        .insert(appRow);
      if (appErr) {
        console.error(`  Failed to insert application: ${appErr.message}`);
      } else {
        applicationsInserted++;
      }
    }
  }

  return { companiesInserted, postingsInserted, applicationsInserted };
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
  const results: ParsedEntry[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < thoughts.length; i++) {
    const thought = thoughts[i];
    console.log(`  Parsing thought ${i + 1}/${thoughts.length} (${thought.id})...`);

    try {
      const parsed = await callOpenRouter(openRouterKey, thought.content);
      results.push({
        thought_id: thought.id,
        thought_content: thought.content.length > 200
          ? thought.content.slice(0, 200) + "..."
          : thought.content,
        parsed,
        parse_error: null,
      });
      successCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        thought_id: thought.id,
        thought_content: thought.content.length > 200
          ? thought.content.slice(0, 200) + "..."
          : thought.content,
        parsed: null,
        parse_error: msg,
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

main().catch(console.error);
