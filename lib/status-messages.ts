// lib/status-messages.ts
//
// Pure formatting functions. No I/O. Input: PipelineStats. Output: message strings.

import type { PipelineStats, TrackStats } from "./pipeline-stats.ts";

const TRACK_LABELS: Record<string, string> = {
  resume_creation: "Resume Creation",
  resume_review: "Resume Review",
  contact_discovery: "Contact Discovery",
  outreach: "Outreach",
  application_submission: "Submit Applications",
};

export interface MessagePayload {
  slack: string;
  email: { subject: string; html: string };
}

// --- Shared progress + pipeline footer for all message types ---

function formatProgressSection(stats: PipelineStats): string[] {
  const lines: string[] = [];

  lines.push("*Progress today:*");
  for (const t of stats.tracks) {
    const pct = t.target > 0 ? Math.round((t.completedToday / t.target) * 100) : 0;
    const bar = progressBar(t.completedToday, t.target);
    const streakNote = t.streak >= 2 ? ` | ${t.streak}-day streak` : "";
    lines.push(`  ${TRACK_LABELS[t.track]}: ${t.completedToday}/${t.target} (${pct}%) ${bar}${streakNote}`);
  }

  return lines;
}

function formatPipelineFooter(stats: PipelineStats): string[] {
  const lines: string[] = [];

  lines.push("");
  lines.push(`*Pipeline:* ${stats.applicationsOut} applied, ${stats.activeInterviews} interviewing`);

  if (stats.lastRejectionDaysAgo !== null) {
    lines.push(`*Last rejection:* ${stats.lastRejectionDaysAgo} day(s) ago`);
  }

  if (stats.daysToClearBacklog !== null) {
    lines.push(`*Backlog:* ${stats.totalDrafts} drafts. At ${stats.currentPace.toFixed(1)}/day, ${stats.daysToClearBacklog} days to clear.`);
  }

  if (stats.staleApplications.length > 0) {
    lines.push("");
    lines.push("*Aging alerts:*");
    for (const a of stats.staleApplications.slice(0, 3)) {
      lines.push(`  ${a.title} at ${a.company} — ${a.daysOld} days with no response`);
    }
  }

  return lines;
}

// --- 12pm: Wake-up kickoff ---

export function formatKickoff(stats: PipelineStats): MessagePayload {
  const lines: string[] = ["*Daily Job Hunt Kickoff*"];

  lines.push("");
  lines.push("*Today's targets:*");
  for (const t of stats.tracks) {
    const carryNote = t.target > 5 ? ` (+${t.target - 5} deficit carryover)` : "";
    lines.push(`  ${TRACK_LABELS[t.track]}: ${t.target}${carryNote}`);
  }

  lines.push("");
  lines.push("*Suggested focus, top 5 per category:*");
  const trackOrder = ["resume_creation", "resume_review", "contact_discovery", "outreach", "application_submission"];
  for (const track of trackOrder) {
    const jobs = stats.suggested.filter(j => j.track === track);
    if (jobs.length === 0) continue;
    lines.push(`\n*${TRACK_LABELS[track]}:*`);
    for (const j of jobs) {
      lines.push(`  ${j.title} at ${j.company} — ${j.reason}`);
    }
  }

  lines.push("");
  lines.push(...formatPipelineFooter(stats));

  const slack = lines.join("\n");
  return {
    slack,
    email: { subject: `Job Hunt Kickoff — ${stats.today}`, html: slackToHtml(slack) },
  };
}

// --- 6pm: Afternoon check-in ---

export function formatCheckin(stats: PipelineStats): MessagePayload {
  const lines: string[] = ["*Afternoon Check-In*"];

  lines.push("");
  lines.push(...formatProgressSection(stats));

  const untouched = stats.tracks.filter(t => t.completedToday === 0);
  if (untouched.length > 0) {
    lines.push("");
    lines.push(`*Not started yet:* ${untouched.map(t => TRACK_LABELS[t.track]).join(", ")}`);
  }

  lines.push(...formatPipelineFooter(stats));

  const slack = lines.join("\n");
  return {
    slack,
    email: { subject: `Job Hunt Check-In — ${stats.today}`, html: slackToHtml(slack) },
  };
}

// --- 11pm: Urgency warning (only fires if 50%+ of any track remains) ---

export function shouldSendWarning(stats: PipelineStats): boolean {
  return stats.tracks.some(t => {
    if (t.target === 0) return false;
    const remaining = t.target - t.completedToday;
    return remaining / t.target >= 0.5;
  });
}

export function formatWarning(stats: PipelineStats): MessagePayload {
  const lagging = stats.tracks.filter(t => {
    if (t.target === 0) return false;
    const remaining = t.target - t.completedToday;
    return remaining / t.target >= 0.5;
  });

  const summaries = lagging.map(t => {
    const remaining = t.target - t.completedToday;
    return `${remaining} of ${t.target} ${TRACK_LABELS[t.track].toLowerCase()}`;
  });

  const lines: string[] = [
    "*Urgency Warning — 2 hours until scorecard*",
    "",
    `You still have: ${summaries.join(", ")}.`,
    "",
    "Now is the time.",
  ];

  lines.push("");
  lines.push(...formatProgressSection(stats));
  lines.push(...formatPipelineFooter(stats));

  const slack = lines.join("\n");
  return {
    slack,
    email: { subject: `Job Hunt Warning — ${stats.today}`, html: slackToHtml(slack) },
  };
}

// --- 1am: Late-night scorecard ---

export function formatScorecard(stats: PipelineStats): MessagePayload {
  const lines: string[] = ["*Daily Scorecard*"];

  lines.push("");
  lines.push("*Final counts:*");
  for (const t of stats.tracks) {
    const hit = t.completedToday >= t.target ? "DONE" : `${t.deficit} short`;
    const streakNote = t.streak >= 2 ? ` | ${t.streak}-day streak` : "";
    const trendNote = trendLabel(t.weeklyAvg, t.lastWeekAvg);
    lines.push(`  ${TRACK_LABELS[t.track]}: ${t.completedToday}/${t.target} (${hit})${streakNote}${trendNote}`);
  }

  lines.push("");
  lines.push("*Weekly averages (last 7 days):*");
  for (const t of stats.tracks) {
    lines.push(`  ${TRACK_LABELS[t.track]}: ${t.weeklyAvg.toFixed(1)}/day`);
  }

  lines.push(...formatPipelineFooter(stats));

  const slack = lines.join("\n");
  return {
    slack,
    email: { subject: `Job Hunt Scorecard — ${stats.today}`, html: slackToHtml(slack) },
  };
}

// --- Helpers ---

function progressBar(done: number, total: number, width = 10): string {
  if (total === 0) return "";
  const filled = Math.min(Math.round((done / total) * width), width);
  return "[" + "=".repeat(filled) + " ".repeat(width - filled) + "]";
}

function trendLabel(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (Math.abs(pct) < 10) return "";
  return pct > 0 ? ` | up ${pct}% vs last week` : ` | down ${Math.abs(pct)}% vs last week`;
}

function slackToHtml(text: string): string {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>\n");
  return `<html><body style="font-family: sans-serif; font-size: 14px; line-height: 1.6;">${html}</body></html>`;
}
