import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- MCP Server Setup (module-level, NOT per-request) ---

const server = new McpServer({
  name: "job-hunt",
  version: "1.0.0",
});

// Tool 1: add_company
server.registerTool(
  "add_company",
  {
    title: "Add Company",
    description: "Add a company to track in your job search.",
    inputSchema: {
      name: z.string().describe("Company name"),
      industry: z.string().optional().describe("Industry"),
      website: z.string().optional().describe("Company website"),
      size: z.enum(["startup", "mid-market", "enterprise"]).optional().describe("Company size"),
      location: z.string().optional().describe("Location"),
      remote_policy: z.enum(["remote", "hybrid", "onsite"]).optional().describe("Remote work policy"),
      notes: z.string().optional().describe("Additional notes"),
      glassdoor_rating: z.number().min(1.0).max(5.0).optional().describe("Glassdoor rating (1.0-5.0)"),
    },
  },
  async ({ name, industry, website, size, location, remote_policy, notes, glassdoor_rating }) => {
    try {
      const { data, error } = await supabase
        .from("companies")
        .insert({
          name,
          industry: industry ?? null,
          website: website ?? null,
          size: size ?? null,
          location: location ?? null,
          remote_policy: remote_policy ?? null,
          notes: notes ?? null,
          glassdoor_rating: glassdoor_rating ?? null,
        })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to add company: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Added company: ${name}`, company: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[add_company] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in add_company: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: add_job_posting (upsert on URL conflict, company lookup by name)
server.registerTool(
  "add_job_posting",
  {
    title: "Add Job Posting",
    description:
      "Add or update a job posting. If a URL is provided and already exists, the posting is updated (upsert). Optionally provide company_name to look up or auto-create a company.",
    inputSchema: {
      url: z.string().describe("Job posting URL (required, used for upsert)"),
      company_name: z.string().optional().describe("Company name (case-insensitive lookup; created if not found)"),
      title: z.string().optional().describe("Job title"),
      location: z.string().optional().describe("Job location"),
      source: z.enum(["linkedin", "greenhouse", "lever", "workday", "indeed", "company-site", "referral", "recruiter", "other"]).optional().describe("Where you found this posting"),
      salary_min: z.number().optional().describe("Minimum salary"),
      salary_max: z.number().optional().describe("Maximum salary"),
      notes: z.string().optional().describe("Notes about the role"),
      posted_date: z.string().optional().describe("Date posted (YYYY-MM-DD)"),
      priority: z.enum(["high", "medium", "low"]).optional().describe("Job priority"),
      salary_currency: z.string().optional().describe("Salary currency (defaults to USD)"),
      closing_date: z.string().optional().describe("Posting closing date (YYYY-MM-DD)"),
    },
  },
  async ({ url, company_name, title, location, source, salary_min, salary_max, notes, posted_date, priority, salary_currency, closing_date }) => {
    try {
      let company_id: string | null = null;

      if (company_name) {
        // Case-insensitive lookup
        const { data: existing, error: lookupErr } = await supabase
          .from("companies")
          .select("id")
          .ilike("name", company_name)
          .limit(1)
          .maybeSingle();

        if (lookupErr) {
          return {
            content: [{ type: "text" as const, text: `Company lookup failed: ${lookupErr.message}` }],
            isError: true,
          };
        }

        if (existing) {
          company_id = existing.id;
        } else {
          // Create the company
          const { data: newCompany, error: createErr } = await supabase
            .from("companies")
            .insert({ name: company_name })
            .select("id")
            .single();

          if (createErr) {
            return {
              content: [{ type: "text" as const, text: `Failed to create company: ${createErr.message}` }],
              isError: true,
            };
          }
          company_id = newCompany.id;
        }
      }

      const row: Record<string, unknown> = { url };
      if (company_id != null) row.company_id = company_id;
      if (title != null) row.title = title;
      if (location != null) row.location = location;
      if (source != null) row.source = source;
      if (salary_min != null) row.salary_min = salary_min;
      if (salary_max != null) row.salary_max = salary_max;
      if (notes != null) row.notes = notes;
      if (posted_date != null) row.posted_date = posted_date;
      if (priority != null) row.priority = priority;
      if (salary_currency != null) row.salary_currency = salary_currency;
      if (closing_date != null) row.closing_date = closing_date;

      const { data, error } = await supabase
        .from("job_postings")
        .upsert(row, { onConflict: "url" })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to upsert job posting: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Upserted job posting: ${title ?? url}`, job_posting: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[add_job_posting] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in add_job_posting: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: submit_application
server.registerTool(
  "submit_application",
  {
    title: "Submit Application",
    description: "Record a submitted job application.",
    inputSchema: {
      job_posting_id: z.string().uuid().describe("Job posting ID (UUID)"),
      status: z.enum(["draft", "ready", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"]).optional().default("applied").describe("Application status"),
      applied_date: z.string().optional().describe("Date applied (YYYY-MM-DD)"),
      resume_version: z.string().optional().describe("Resume version used"),
      cover_letter_notes: z.string().optional().describe("Notes about cover letter"),
      referral_contact: z.string().optional().describe("Referral contact name"),
      notes: z.string().optional().describe("Additional notes"),
      resume_path: z.string().optional().describe("Path to generated resume file"),
      cover_letter_path: z.string().optional().describe("Path to cover letter file"),
      response_date: z.string().optional().describe("Date company responded (YYYY-MM-DD)"),
    },
  },
  async ({ job_posting_id, status, applied_date, resume_version, cover_letter_notes, referral_contact, notes, resume_path, cover_letter_path, response_date }) => {
    try {
      const { data, error } = await supabase
        .from("applications")
        .insert({
          job_posting_id,
          status: status ?? "applied",
          applied_date: applied_date ?? null,
          resume_version: resume_version ?? null,
          cover_letter_notes: cover_letter_notes ?? null,
          referral_contact: referral_contact ?? null,
          notes: notes ?? null,
          resume_path: resume_path ?? null,
          cover_letter_path: cover_letter_path ?? null,
          response_date: response_date ?? null,
        })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to submit application: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Application recorded successfully", application: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[submit_application] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in submit_application: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: update_application
server.registerTool(
  "update_application",
  {
    title: "Update Application",
    description: "Update any fields on an existing application. All fields are optional — only provided fields are updated.",
    inputSchema: {
      application_id: z.string().uuid().describe("Application ID (UUID)"),
      status: z.enum(["draft", "ready", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"]).optional().describe("New application status"),
      applied_date: z.string().optional().describe("Date applied (YYYY-MM-DD)"),
      resume_version: z.string().optional().describe("Resume version used"),
      resume_path: z.string().optional().describe("Path to generated resume file"),
      cover_letter_path: z.string().optional().describe("Path to cover letter file"),
      cover_letter_notes: z.string().optional().describe("Notes about cover letter"),
      referral_contact: z.string().optional().describe("Referral contact name"),
      response_date: z.string().optional().describe("Date company responded (YYYY-MM-DD)"),
      notes: z.string().optional().describe("Additional notes"),
    },
  },
  async ({ application_id, status, applied_date, resume_version, resume_path, cover_letter_path, cover_letter_notes, referral_contact, response_date, notes }) => {
    try {
      const updateFields: Record<string, unknown> = {};
      if (status != null) updateFields.status = status;
      if (applied_date != null) updateFields.applied_date = applied_date;
      if (resume_version != null) updateFields.resume_version = resume_version;
      if (resume_path != null) updateFields.resume_path = resume_path;
      if (cover_letter_path != null) updateFields.cover_letter_path = cover_letter_path;
      if (cover_letter_notes != null) updateFields.cover_letter_notes = cover_letter_notes;
      if (referral_contact != null) updateFields.referral_contact = referral_contact;
      if (response_date != null) updateFields.response_date = response_date;
      if (notes != null) updateFields.notes = notes;

      if (Object.keys(updateFields).length === 0) {
        return {
          content: [{ type: "text" as const, text: "No fields provided to update." }],
          isError: true,
        };
      }

      const { data, error } = await supabase
        .from("applications")
        .update(updateFields)
        .eq("id", application_id)
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to update application: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Application updated successfully", application: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[update_application] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in update_application: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4b: delete_application
server.registerTool(
  "delete_application",
  {
    title: "Delete Application",
    description: "Delete an application record. Use to remove duplicates or erroneous entries.",
    inputSchema: {
      application_id: z.string().uuid().describe("Application ID (UUID)"),
    },
  },
  async ({ application_id }) => {
    try {
      const { error } = await supabase
        .from("applications")
        .delete()
        .eq("id", application_id);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to delete application: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Application ${application_id} deleted` }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[delete_application] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in delete_application: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: schedule_interview
server.registerTool(
  "schedule_interview",
  {
    title: "Schedule Interview",
    description: "Schedule an interview for an application.",
    inputSchema: {
      application_id: z.string().uuid().describe("Application ID (UUID)"),
      interview_type: z.enum(["phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final"]).describe("Type of interview"),
      scheduled_at: z.string().optional().describe("Interview date/time (ISO 8601)"),
      duration_minutes: z.number().optional().describe("Expected duration in minutes"),
      interviewer_name: z.string().optional().describe("Interviewer name"),
      interviewer_title: z.string().optional().describe("Interviewer title"),
      notes: z.string().optional().describe("Pre-interview prep notes"),
    },
  },
  async ({ application_id, interview_type, scheduled_at, duration_minutes, interviewer_name, interviewer_title, notes }) => {
    try {
      const { data, error } = await supabase
        .from("interviews")
        .insert({
          application_id,
          interview_type,
          scheduled_at: scheduled_at ?? null,
          duration_minutes: duration_minutes ?? null,
          interviewer_name: interviewer_name ?? null,
          interviewer_title: interviewer_title ?? null,
          status: "scheduled",
          notes: notes ?? null,
        })
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to schedule interview: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Interview scheduled successfully", interview: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[schedule_interview] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in schedule_interview: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 6: log_interview_notes
server.registerTool(
  "log_interview_notes",
  {
    title: "Log Interview Notes",
    description: "Add feedback/notes after an interview and mark it as completed.",
    inputSchema: {
      interview_id: z.string().uuid().describe("Interview ID (UUID)"),
      feedback: z.string().optional().describe("Post-interview reflection"),
      rating: z.number().min(1).max(5).optional().describe("Your assessment of how it went (1-5)"),
    },
  },
  async ({ interview_id, feedback, rating }) => {
    try {
      const { data, error } = await supabase
        .from("interviews")
        .update({
          feedback: feedback ?? null,
          rating: rating ?? null,
          status: "completed",
        })
        .eq("id", interview_id)
        .select()
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to log interview notes: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Interview notes logged and status updated to completed", interview: data }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[log_interview_notes] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in log_interview_notes: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 7: get_pipeline_overview
server.registerTool(
  "get_pipeline_overview",
  {
    title: "Pipeline Overview",
    description: "Get a dashboard summary: total applications, counts by status, upcoming interviews (next 7 days).",
    inputSchema: {},
  },
  async () => {
    try {
      // Get application counts by status
      const { data: applications, error: appError } = await supabase
        .from("applications")
        .select("status");

      if (appError) {
        return {
          content: [{ type: "text" as const, text: `Failed to get applications: ${appError.message}` }],
          isError: true,
        };
      }

      const statusCounts: Record<string, number> = {};
      for (const app of applications ?? []) {
        statusCounts[app.status] = (statusCounts[app.status] ?? 0) + 1;
      }

      // Get upcoming interviews (next 7 days)
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      const { data: upcomingInterviews, error: interviewError } = await supabase
        .from("interviews")
        .select(`
          *,
          applications!inner(
            *,
            job_postings!inner(
              *,
              companies!inner(*)
            )
          )
        `)
        .eq("status", "scheduled")
        .gte("scheduled_at", new Date().toISOString())
        .lte("scheduled_at", futureDate.toISOString())
        .order("scheduled_at", { ascending: true });

      if (interviewError) {
        return {
          content: [{ type: "text" as const, text: `Failed to get upcoming interviews: ${interviewError.message}` }],
          isError: true,
        };
      }

      const result = {
        total_applications: (applications ?? []).length,
        status_breakdown: statusCounts,
        upcoming_interviews_count: (upcomingInterviews ?? []).length,
        upcoming_interviews: upcomingInterviews ?? [],
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[get_pipeline_overview] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in get_pipeline_overview: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 8: get_upcoming_interviews
server.registerTool(
  "get_upcoming_interviews",
  {
    title: "Upcoming Interviews",
    description: "List interviews in the next N days with full company/role context.",
    inputSchema: {
      days_ahead: z.number().optional().default(14).describe("Number of days to look ahead (default: 14)"),
    },
  },
  async ({ days_ahead }) => {
    try {
      const daysToCheck = days_ahead ?? 14;
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + daysToCheck);

      const { data, error } = await supabase
        .from("interviews")
        .select(`
          *,
          applications!inner(
            *,
            job_postings!inner(
              *,
              companies!inner(*)
            )
          )
        `)
        .eq("status", "scheduled")
        .gte("scheduled_at", new Date().toISOString())
        .lte("scheduled_at", futureDate.toISOString())
        .order("scheduled_at", { ascending: true });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to get upcoming interviews: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: (data ?? []).length, interviews: data ?? [] }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[get_upcoming_interviews] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in get_upcoming_interviews: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 9: search_job_postings (NEW)
server.registerTool(
  "search_job_postings",
  {
    title: "Search Job Postings",
    description: "Search job postings by text query (title/company/notes), status, source, or exact URL. Shows application status if one exists.",
    inputSchema: {
      query: z.string().optional().describe("Text search across title, company name, and notes (case-insensitive)"),
      status: z.enum(["draft", "ready", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"]).optional().describe("Filter by application status"),
      source: z.enum(["linkedin", "greenhouse", "lever", "workday", "indeed", "company-site", "referral", "recruiter", "other"]).optional().describe("Filter by posting source"),
      url: z.string().optional().describe("Exact URL match"),
      priority: z.enum(["high", "medium", "low"]).optional().describe("Filter by job priority"),
    },
  },
  async ({ query, status, source, url, priority }) => {
    try {
      // Build select based on whether status filter is needed
      let q;
      if (status) {
        // Inner join — only postings with matching application status
        q = supabase
          .from("job_postings")
          .select("*, companies(name), applications!inner(id, status, applied_date, resume_path, cover_letter_path)")
          .eq("applications.status", status);
      } else {
        // Left join — all postings, applications if they exist
        q = supabase
          .from("job_postings")
          .select("*, companies(name), applications(id, status, applied_date, resume_path, cover_letter_path)");
      }

      if (url) {
        q = q.eq("url", url);
      }

      if (source) {
        q = q.eq("source", source);
      }

      if (priority) {
        q = q.eq("priority", priority);
      }

      if (query) {
        // Find companies matching the query
        const { data: matchingCos, error: coErr } = await supabase
          .from("companies")
          .select("id")
          .ilike("name", `%${query}%`);
        if (coErr) {
          console.error("Company search error:", coErr);
        }
        const coIds = (matchingCos ?? []).map((c: any) => c.id);

        // Escape PostgREST special characters in the query
        const safeQuery = query.replace(/[%_.,()\\]/g, '\\$&');

        const filters: string[] = [
          `title.ilike.%${safeQuery}%`,
          `notes.ilike.%${safeQuery}%`,
        ];
        if (coIds.length > 0) {
          filters.push(`company_id.in.(${coIds.join(",")})`);
        }
        q = q.or(filters.join(","));
      }

      const { data, error } = await q.order("created_at", { ascending: false });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${error.message}` }],
          isError: true,
        };
      }

      const results = data ?? [];

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: results.length, job_postings: results }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[search_job_postings] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in search_job_postings: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 10: link_contact_to_professional_crm
server.registerTool(
  "link_contact_to_professional_crm",
  {
    title: "Link Contact to Professional CRM",
    description: "Link a job contact to the Professional CRM, creating a professional_contacts record. If the update fails after insert, the inserted record is cleaned up.",
    inputSchema: {
      job_contact_id: z.string().uuid().describe("Job contact ID (UUID)"),
    },
  },
  async ({ job_contact_id }) => {
    try {
      // Get the job contact
      const { data: jobContact, error: contactError } = await supabase
        .from("job_contacts")
        .select("*")
        .eq("id", job_contact_id)
        .single();

      if (contactError) {
        return {
          content: [{ type: "text" as const, text: `Failed to retrieve job contact: ${contactError.message}` }],
          isError: true,
        };
      }

      if (!jobContact) {
        return {
          content: [{ type: "text" as const, text: "Job contact not found" }],
          isError: true,
        };
      }

      // Check if already linked
      if (jobContact.professional_crm_contact_id) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ message: "Contact already linked to Professional CRM", job_contact: jobContact, already_linked: true }, null, 2) }],
        };
      }

      // Get company name if linked
      let companyName: string | null = null;
      if (jobContact.company_id) {
        const { data: company } = await supabase
          .from("companies")
          .select("name")
          .eq("id", jobContact.company_id)
          .single();
        companyName = company?.name ?? null;
      }

      // Create professional contact
      const { data: professionalContact, error: crmError } = await supabase
        .from("professional_contacts")
        .insert({
          name: jobContact.name,
          company: companyName,
          title: jobContact.title ?? null,
          email: jobContact.email ?? null,
          phone: jobContact.phone ?? null,
          linkedin_url: jobContact.linkedin_url ?? null,
          how_we_met: `Job search - ${jobContact.role_in_process ?? "contact"}`,
          tags: ["job-hunt", jobContact.role_in_process ?? "contact"],
          notes: jobContact.notes ?? null,
          last_contacted: jobContact.last_contacted ?? null,
        })
        .select()
        .single();

      if (crmError) {
        return {
          content: [{ type: "text" as const, text: `Failed to create professional contact: ${crmError.message}` }],
          isError: true,
        };
      }

      // Update job contact with link
      const { data: updatedJobContact, error: updateError } = await supabase
        .from("job_contacts")
        .update({ professional_crm_contact_id: professionalContact.id })
        .eq("id", job_contact_id)
        .select()
        .single();

      if (updateError) {
        // Compensating action: delete the professional contact we just created
        const { error: deleteErr } = await supabase
          .from("professional_contacts")
          .delete()
          .eq("id", professionalContact.id);

        if (deleteErr) {
          console.error("CRITICAL: Failed to clean up orphaned professional contact:", professionalContact.id, deleteErr);
          return {
            content: [{ type: "text" as const, text: `Link failed AND cleanup failed. Orphaned record ID: ${professionalContact.id}. Manual cleanup required.` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Failed to link contact (rolled back professional contact): ${updateError.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Linked ${jobContact.name} to Professional CRM`, job_contact: updatedJobContact, professional_contact: professionalContact }, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[link_contact_to_professional_crm] Error:", err);
      return {
        content: [{ type: "text" as const, text: `Error in link_contact_to_professional_crm: ${message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth Check ---

const app = new Hono();

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
