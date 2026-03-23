// scripts/enrich-job-postings.ts
//
// Daily cron: finds job_postings missing title or company, uses Playwright
// to scrape LinkedIn with the user's Chrome session, and updates the records.

import { chromium } from "npm:playwright";
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSlackMessage, getCaptureChannel } from "../lib/slack.ts";

// --- Config ---
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Use a separate temp directory with cookies copied from the main profile.
// This avoids the ProcessSingleton lock when Chrome is already running.
const CHROME_SOURCE_PROFILE = `${Deno.env.get("HOME")}/Library/Application Support/Google/Chrome`;
const DELAY_MIN_MS = 5000;
const DELAY_MAX_MS = 15000;

// --- Supabase setup (credentials from 1Password) ---
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

async function getSupabaseClient() {
  const url = await readOp("Open Brain - Supabase", "project_url");
  const key = await readOp("Open Brain - Supabase", "service_role_key");
  return createClient(url, key);
}

// --- Main ---
async function main() {
  console.log(`[${new Date().toISOString()}] Starting job posting enrichment...`);

  const supabase = await getSupabaseClient();
  const channel = await getCaptureChannel();

  // Find postings that need enrichment
  const { data: postings, error } = await supabase
    .from("job_postings")
    .select("id, url, source")
    .or("title.is.null,company_id.is.null,connection_count.is.null")
    .is("enrichment_error", null);

  if (error) {
    console.error("Query error:", error.message);
    await sendSlackMessage(channel, `Job enrichment failed: ${error.message}`);
    return;
  }

  if (!postings || postings.length === 0) {
    console.log("No postings need enrichment.");
    return;
  }

  console.log(`Found ${postings.length} posting(s) to enrich.`);

  // Create a temp profile with cookies copied from the main Chrome profile.
  // This avoids the ProcessSingleton lock when Chrome is already running.
  const tempDir = await Deno.makeTempDir({ prefix: "enrich-chrome-" });
  const defaultDir = `${tempDir}/Default`;
  await Deno.mkdir(defaultDir, { recursive: true });
  try {
    // Copy cookies and login state from main profile
    for (const file of ["Cookies", "Login Data", "Web Data", "Local State"]) {
      try {
        await Deno.copyFile(`${CHROME_SOURCE_PROFILE}/Default/${file}`, `${defaultDir}/${file}`);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          console.warn(`Warning: failed to copy ${file}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    // Copy Local State to profile root (Chrome needs it there)
    try {
      await Deno.copyFile(`${CHROME_SOURCE_PROFILE}/Local State`, `${tempDir}/Local State`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        console.warn(`Warning: failed to copy Local State: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    console.error("Failed to copy Chrome profile cookies:", err);
  }

  // Launch browser with the temp profile
  let browser;
  try {
    browser = await chromium.launchPersistentContext(tempDir, {
      executablePath: CHROME_PATH,
      headless: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Failed to launch browser:", msg);
    await sendSlackMessage(channel, `Job enrichment failed — could not launch Chrome: ${msg}`);
    return;
  }

  let sessionExpired = false;
  let enrichedCount = 0;
  let failedCount = 0;

  for (const posting of postings) {
    if (sessionExpired) break;
    if (!posting.url) continue;

    try {
      const page = await browser.newPage();
      await page.goto(posting.url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Session check: look for login wall
      const currentUrl = page.url();
      if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
        sessionExpired = true;
        await sendSlackMessage(channel,
          "LinkedIn session expired — please log in to Chrome and the enrichment will resume tomorrow.");
        await page.close();
        break;
      }

      // Extract job details from the page
      const details = await Promise.race([
        page.evaluate(() => {
          // Try multiple selectors — LinkedIn changes its layout frequently
          const title = document.querySelector("h1")?.textContent?.trim() || null;
          const company = document.querySelector(".job-details-jobs-unified-top-card__company-name")?.textContent?.trim()
            || document.querySelector("[data-test-id='job-details-company-name']")?.textContent?.trim()
            || document.querySelector(".topcard__org-name-link")?.textContent?.trim()
            || null;
          const location = document.querySelector(".job-details-jobs-unified-top-card__bullet")?.textContent?.trim()
            || document.querySelector(".topcard__flavor--bullet")?.textContent?.trim()
            || null;

          // Fallback: parse from page title ("Job Title | Company | LinkedIn")
          let titleFromPage = title;
          let companyFromPage = company;
          if (!title || !company) {
            const pageTitle = document.title;
            const parts = pageTitle.split("|").map((s: string) => s.trim());
            if (parts.length >= 3 && parts[parts.length - 1] === "LinkedIn") {
              if (!titleFromPage) titleFromPage = parts[0];
              if (!companyFromPage) companyFromPage = parts[1];
            }
          }

          // Connection count — look for "N connections work here" or "N connection works here"
          const connMatch = document.body.innerText.match(/(\d+)\s+connections?\s+work/i);
          const connectionCount: number | null = connMatch ? parseInt(connMatch[1], 10) : null;

          // Recruiter / hirer card
          const hirerCard = document.querySelector(".hirer-card__hirer-information")
            || document.querySelector("[data-test-id='job-poster']")
            || null;
          let recruiterName: string | null = null;
          let recruiterTitle: string | null = null;
          let recruiterUrl: string | null = null;
          if (hirerCard) {
            recruiterName = hirerCard.querySelector("a")?.textContent?.trim()
              || hirerCard.querySelector("strong")?.textContent?.trim()
              || null;
            recruiterTitle = hirerCard.querySelector(".hirer-card__hirer-job-title")?.textContent?.trim()
              || hirerCard.querySelector(".jobs-poster__title")?.textContent?.trim()
              || null;
            const profileAnchor = hirerCard.querySelector("a[href*='/in/']") as HTMLAnchorElement | null;
            recruiterUrl = profileAnchor?.href ?? null;
          }
          if (!recruiterName) {
            const posterEl = document.querySelector(".jobs-poster__name");
            if (posterEl) {
              recruiterName = posterEl.querySelector("a")?.textContent?.trim()
                || posterEl.textContent?.trim()
                || null;
              const posterAnchor = posterEl.querySelector("a[href*='/in/']") as HTMLAnchorElement | null;
              if (posterAnchor) recruiterUrl = posterAnchor.href;
            }
          }

          return { title: titleFromPage, company: companyFromPage, location, connectionCount, recruiterName, recruiterTitle, recruiterUrl };
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("page.evaluate timed out after 15s")), 15000))
      ]) as { title: string | null; company: string | null; location: string | null; connectionCount: number | null; recruiterName: string | null; recruiterTitle: string | null; recruiterUrl: string | null };

      await page.close();

      if (!details.title && !details.company) {
        // Page loaded but couldn't extract — posting may have been removed
        const { error: updateErr } = await supabase
          .from("job_postings")
          .update({ enrichment_error: "Could not extract details — posting may have been removed" })
          .eq("id", posting.id);
        if (updateErr) {
          console.error(`Update failed for ${posting.id}: ${updateErr.message}`);
          failedCount++;
          continue;
        }
        await sendSlackMessage(channel,
          `Could not enrich ${posting.url} — posting may have been removed.`);
        failedCount++;
        continue;
      }

      // Look up or create company
      let company_id: string | null = null;
      if (details.company) {
        const { data: existing, error: lookupErr } = await supabase
          .from("companies")
          .select("id")
          .ilike("name", details.company)
          .limit(1)
          .maybeSingle();
        if (lookupErr) {
          console.error(`Company lookup failed for "${details.company}": ${lookupErr.message}`);
        }
        if (existing) {
          company_id = existing.id;
        } else {
          const { data: newCo, error: insertErr } = await supabase
            .from("companies")
            .insert({ name: details.company })
            .select("id")
            .single();
          if (insertErr) {
            console.error(`Company insert failed for "${details.company}": ${insertErr.message}`);
          }
          company_id = newCo?.id ?? null;
        }
      }

      // Update the posting
      const updateFields: Record<string, unknown> = {};
      if (details.title) updateFields.title = details.title;
      if (company_id) updateFields.company_id = company_id;
      if (details.location) updateFields.location = details.location;
      if (details.connectionCount != null) updateFields.connection_count = details.connectionCount;

      if (Object.keys(updateFields).length > 0) {
        const { error: updateErr } = await supabase
          .from("job_postings")
          .update(updateFields)
          .eq("id", posting.id);
        if (updateErr) {
          console.error(`Update failed for ${posting.id}: ${updateErr.message}`);
          failedCount++;
          continue;
        }
      }

      // Log attribution
      const enrichedFields = Object.keys(updateFields).join(", ");
      const { error: attrErr } = await supabase
        .from("attribution_log")
        .insert({
          entity_type: "job_posting",
          entity_id: posting.id,
          action: "enriched",
          actor: "enrichment-cron",
          reason: `Scraped from LinkedIn: ${enrichedFields}`,
        });
      if (attrErr) {
        console.warn(`Attribution log failed for ${posting.id}: ${attrErr.message}`);
      }

      console.log(`Enriched: ${details.title ?? "?"} at ${details.company ?? "?"} — ${posting.url}`);
      enrichedCount++;

      // Create recruiter contact and link to posting if found
      if (details.recruiterName && company_id) {
        const { data: existingContact, error: contactLookupErr } = await supabase
          .from("job_contacts")
          .select("id")
          .ilike("name", details.recruiterName)
          .eq("company_id", company_id)
          .maybeSingle();
        if (contactLookupErr) {
          console.warn(`Recruiter contact lookup failed for "${details.recruiterName}": ${contactLookupErr.message}`);
        }
        let contactId: string | null = existingContact?.id ?? null;
        if (!existingContact) {
          const { data: newContact, error: contactInsertErr } = await supabase
            .from("job_contacts")
            .insert({
              name: details.recruiterName,
              company_id,
              title: details.recruiterTitle ?? null,
              linkedin_url: details.recruiterUrl ?? null,
              role_in_process: "recruiter",
            })
            .select("id")
            .single();
          if (contactInsertErr) {
            console.warn(`Recruiter contact insert failed for "${details.recruiterName}": ${contactInsertErr.message}`);
          } else {
            contactId = newContact?.id ?? null;
            const { error: contactAttrErr } = await supabase
              .from("attribution_log")
              .insert({
                entity_type: "job_contact",
                entity_id: contactId,
                action: "created",
                actor: "enrichment-cron",
                reason: `Scraped recruiter from LinkedIn job posting ${posting.id}`,
              });
            if (contactAttrErr) {
              console.warn(`Attribution log failed for new contact ${contactId}: ${contactAttrErr.message}`);
            }
          }
        }
        if (contactId) {
          const { error: linkErr } = await supabase
            .from("posting_contacts")
            .insert({ posting_id: posting.id, contact_id: contactId, relationship: "recruiter" });
          if (linkErr && linkErr.code !== "23505") {
            console.warn(`posting_contacts insert failed for posting ${posting.id} / contact ${contactId}: ${linkErr.message}`);
          }
        }
      }

      // Random delay between requests
      const delay = DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
      await new Promise(r => setTimeout(r, delay));

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const { error: markErr } = await supabase
        .from("job_postings")
        .update({ enrichment_error: `Enrichment failed: ${msg}` })
        .eq("id", posting.id);
      if (markErr) {
        console.error(`Failed to record enrichment_error for ${posting.id}: ${markErr.message}`);
      }
      await supabase.from("attribution_log").insert({
        entity_type: "job_posting",
        entity_id: posting.id,
        action: "enrichment_failed",
        actor: "enrichment-cron",
        reason: msg.slice(0, 500),
      });
      console.error(`Failed to enrich ${posting.url}: ${msg}`);
      failedCount++;
    }
  }

  await browser.close();
  // Clean up temp profile
  try { await Deno.remove(tempDir, { recursive: true }); } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn(`Warning: failed to remove ${tempDir}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`Enrichment complete. Enriched: ${enrichedCount}, Failed: ${failedCount}, Session expired: ${sessionExpired}`);
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
