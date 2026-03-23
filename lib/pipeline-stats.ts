// lib/pipeline-stats.ts
//
// Fetches all data needed by the Daily Status Agent from Supabase.
// No message formatting here — pure data retrieval.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface TrackStats {
  track: string;
  completedToday: number;
  target: number;         // includes rolling deficit
  deficit: number;        // remaining deficit to carry forward
  streak: number;         // consecutive days meeting target
  weeklyAvg: number;      // average completions over last 7 days
  lastWeekAvg: number;    // average completions over the 7 days before that
}

export interface SuggestedJob {
  id: string;
  title: string;
  company: string;
  track: string;
  reason: string;         // e.g. "high priority", "low-hanging network"
}

export interface StaleApplication {
  title: string;
  company: string;
  daysOld: number;
  applicationId: string;
}

export interface PipelineStats {
  tracks: TrackStats[];
  suggested: SuggestedJob[];        // top 5 per track for kickoff message
  staleApplications: StaleApplication[];
  activeInterviews: number;
  applicationsOut: number;
  draftResumes: number;             // postings with resume_path IS NULL and status = 'draft'
  totalDrafts: number;              // all postings in a workable state not yet applied
  currentPace: number;              // average app submissions per day (last 7 days)
  daysToClearBacklog: number | null;
  lastRejectionDaysAgo: number | null;
  today: string;                    // ISO date string YYYY-MM-DD
}

export async function fetchPipelineStats(supabase: SupabaseClient): Promise<PipelineStats> {
  const today = new Date().toISOString().slice(0, 10);

  // --- Compute today's counts by track ---
  // Resume creation: job_postings that moved from no resume to having one today
  // Resume review: applications that moved from 'draft' to 'ready' today
  // Contact discovery: job_postings where networking_status moved to 'researched' today
  // Outreach: job_postings where networking_status moved to 'done' today
  // Application submission: applications submitted today
  //
  // Simplification: we read today's row from daily_stats if it exists (written by 1am scorecard).
  // For intra-day runs (12pm, 6pm, 11pm) we compute live counts.

  // Load existing daily_stats rows for the last 14 days
  const { data: statsRows } = await supabase
    .from("daily_stats")
    .select("date, track, completed, target, deficit")
    .gte("date", offsetDate(today, -14))
    .order("date", { ascending: false });

  const statsMap = new Map<string, typeof statsRows[0]>();
  for (const row of (statsRows ?? [])) {
    statsMap.set(`${row.date}|${row.track}`, row);
  }

  // Live counts for today (each track queries different tables)
  const [
    resumeCreationCount,
    resumeReviewCount,
    contactDiscoveryCount,
    outreachCount,
    submissionCount,
  ] = await Promise.all([
    countResumeCreations(supabase, today),
    countResumeReviews(supabase, today),
    countContactDiscoveries(supabase, today),
    countOutreach(supabase, today),
    countSubmissions(supabase, today),
  ]);

  const liveCounts: Record<string, number> = {
    resume_creation: resumeCreationCount,
    resume_review: resumeReviewCount,
    contact_discovery: contactDiscoveryCount,
    outreach: outreachCount,
    application_submission: submissionCount,
  };

  const TRACKS = [
    "resume_creation",
    "resume_review",
    "contact_discovery",
    "outreach",
    "application_submission",
  ];
  const BASE_TARGET = 5;

  const tracks: TrackStats[] = TRACKS.map((track) => {
    // Yesterday's deficit carries into today's target
    const yesterdayKey = `${offsetDate(today, -1)}|${track}`;
    const yesterday = statsMap.get(yesterdayKey);
    const carryDeficit = yesterday?.deficit ?? 0;
    const target = BASE_TARGET + carryDeficit;

    const completedToday = liveCounts[track] ?? 0;
    const deficit = Math.max(0, target - completedToday);

    // Streak: count consecutive days (going backwards) where deficit was 0
    let streak = 0;
    for (let i = 1; i <= 14; i++) {
      const key = `${offsetDate(today, -i)}|${track}`;
      const row = statsMap.get(key);
      if (!row) break;
      if (row.deficit === 0) streak++;
      else break;
    }

    // Weekly averages
    const last7 = daysRange(today, -1, -7).map(d => statsMap.get(`${d}|${track}`)?.completed ?? 0);
    const prev7 = daysRange(today, -8, -14).map(d => statsMap.get(`${d}|${track}`)?.completed ?? 0);
    const weeklyAvg = avg(last7);
    const lastWeekAvg = avg(prev7);

    return { track, completedToday, target, deficit, streak, weeklyAvg, lastWeekAvg };
  });

  // --- Suggested jobs for each track (kickoff message) ---
  const suggested = await fetchSuggestedJobs(supabase);

  // --- Stale applications (applied 14+ days ago, no response_date) ---
  const staleApplications = await fetchStaleApplications(supabase);

  // --- Win tracking ---
  // Count applications in interviewing or screening status
  const { count: activeInterviews } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .in("status", ["interviewing", "screening"]);

  const { count: applicationsOut } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .eq("status", "applied");

  const { count: draftResumes } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .eq("status", "draft")
    .is("resume_path", null);

  const { count: totalDrafts } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .in("status", ["draft", "ready"]);

  // Last rejection
  const { data: lastRejection } = await supabase
    .from("applications")
    .select("updated_at")
    .eq("status", "rejected")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastRejectionDaysAgo = lastRejection
    ? Math.floor((Date.now() - new Date(lastRejection.updated_at).getTime()) / 86400000)
    : null;

  // Current pace (app submissions per day, last 7 days)
  const submissionTrackRows = daysRange(today, -1, -7)
    .map(d => statsMap.get(`${d}|application_submission`)?.completed ?? 0);
  const currentPace = avg(submissionTrackRows);

  const daysToClearBacklog = currentPace > 0 && totalDrafts
    ? Math.ceil(totalDrafts / currentPace)
    : null;

  return {
    tracks,
    suggested,
    staleApplications,
    activeInterviews: activeInterviews ?? 0,
    applicationsOut: applicationsOut ?? 0,
    draftResumes: draftResumes ?? 0,
    totalDrafts: totalDrafts ?? 0,
    currentPace,
    daysToClearBacklog,
    lastRejectionDaysAgo,
    today,
  };
}

// --- Per-track live count helpers ---

async function countResumeCreations(supabase: SupabaseClient, today: string): Promise<number> {
  // Count applications where resume_path was set today (using updated_at as proxy)
  const { count } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .not("resume_path", "is", null)
    .gte("updated_at", `${today}T00:00:00Z`);
  return count ?? 0;
}

async function countResumeReviews(supabase: SupabaseClient, today: string): Promise<number> {
  // Count applications that moved to 'ready' today
  const { count } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .eq("status", "ready")
    .gte("updated_at", `${today}T00:00:00Z`);
  return count ?? 0;
}

async function countContactDiscoveries(supabase: SupabaseClient, today: string): Promise<number> {
  const { count } = await supabase
    .from("job_postings")
    .select("*", { count: "exact", head: true })
    .in("networking_status", ["researched", "outreach_in_progress", "done"])
    .gte("updated_at", `${today}T00:00:00Z`);
  return count ?? 0;
}

async function countOutreach(supabase: SupabaseClient, today: string): Promise<number> {
  const { count } = await supabase
    .from("job_postings")
    .select("*", { count: "exact", head: true })
    .eq("networking_status", "done")
    .gte("updated_at", `${today}T00:00:00Z`);
  return count ?? 0;
}

async function countSubmissions(supabase: SupabaseClient, today: string): Promise<number> {
  const { count } = await supabase
    .from("applications")
    .select("*", { count: "exact", head: true })
    .eq("status", "applied")
    .gte("updated_at", `${today}T00:00:00Z`);
  return count ?? 0;
}

// --- Suggested jobs ---

async function fetchSuggestedJobs(supabase: SupabaseClient): Promise<SuggestedJob[]> {
  const suggested: SuggestedJob[] = [];

  // Resume creation: top 5 draft applications with no resume, by priority
  const { data: noResume } = await supabase
    .from("applications")
    .select("id, job_postings(id, title, companies(name), priority, has_network_connections)")
    .eq("status", "draft")
    .is("resume_path", null)
    .order("created_at", { ascending: true })
    .limit(5);
  for (const row of (noResume ?? [])) {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: jp?.title as string ?? "Untitled",
      company,
      track: "resume_creation",
      reason: "draft with no resume",
    });
  }

  // Resume review: top 5 draft applications with a resume (awaiting review)
  const { data: needsReview } = await supabase
    .from("applications")
    .select("id, job_postings(title, companies(name))")
    .eq("status", "draft")
    .not("resume_path", "is", null)
    .limit(5);
  for (const row of (needsReview ?? [])) {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: jp?.title as string ?? "Untitled",
      company,
      track: "resume_review",
      reason: "draft resume awaiting approval",
    });
  }

  // Contact discovery: postings with has_network_connections = true and status = not_started
  const { data: networkReady } = await supabase
    .from("job_postings")
    .select("id, title, companies(name)")
    .eq("networking_status", "not_started")
    .eq("has_network_connections", true)
    .limit(5);
  for (const row of (networkReady ?? [])) {
    const company = (row.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: row.title ?? "Untitled",
      company,
      track: "contact_discovery",
      reason: "has network connections on LinkedIn",
    });
  }

  // Outreach: postings with networking_status = researched
  const { data: researched } = await supabase
    .from("job_postings")
    .select("id, title, companies(name)")
    .eq("networking_status", "researched")
    .limit(5);
  for (const row of (researched ?? [])) {
    const company = (row.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: row.title ?? "Untitled",
      company,
      track: "outreach",
      reason: "contacts researched, ready to message",
    });
  }

  // Application submission: top 5 'ready' applications
  const { data: readyApps } = await supabase
    .from("applications")
    .select("id, job_postings(title, companies(name))")
    .eq("status", "ready")
    .limit(5);
  for (const row of (readyApps ?? [])) {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    suggested.push({
      id: row.id,
      title: jp?.title as string ?? "Untitled",
      company,
      track: "application_submission",
      reason: "resume approved, ready to submit",
    });
  }

  return suggested;
}

// --- Stale applications ---

async function fetchStaleApplications(supabase: SupabaseClient): Promise<StaleApplication[]> {
  const cutoff = offsetDate(new Date().toISOString().slice(0, 10), -14);
  const { data } = await supabase
    .from("applications")
    .select("id, updated_at, job_postings(title, companies(name))")
    .eq("status", "applied")
    .is("response_date", null)
    .lte("updated_at", `${cutoff}T23:59:59Z`)
    .order("updated_at", { ascending: true })
    .limit(5);

  return (data ?? []).map((row) => {
    const jp = row.job_postings as Record<string, unknown>;
    const company = (jp?.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    const daysOld = Math.floor(
      (Date.now() - new Date(row.updated_at).getTime()) / 86400000
    );
    return {
      title: jp?.title as string ?? "Untitled",
      company,
      daysOld,
      applicationId: row.id,
    };
  });
}

// --- Utility helpers ---

function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysRange(today: string, from: number, to: number): string[] {
  const result: string[] = [];
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  for (let i = start; i <= end; i++) {
    result.push(offsetDate(today, i));
  }
  return result;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
