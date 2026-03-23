// scripts/daily-status.ts
//
// Daily pipeline status agent. Accepts a --mode argument:
//   kickoff   — 12pm wake-up with today's targets and suggested jobs
//   checkin   — 6pm progress update
//   warning   — 11pm urgency alert (only sends if 50%+ of any track remains)
//   scorecard — 1am final totals, streaks, trends
//
// Sends to both Slack and email (Gmail SMTP).

import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSlackMessage, getCaptureChannel } from "../lib/slack.ts";
import { sendEmail } from "../lib/email.ts";
import { fetchPipelineStats } from "../lib/pipeline-stats.ts";
import {
  formatKickoff,
  formatCheckin,
  formatWarning,
  formatScorecard,
  shouldSendWarning,
} from "../lib/status-messages.ts";

// --- 1Password helper (same pattern as other scripts) ---
async function readOp(item: string, field: string): Promise<string> {
  const proc = new Deno.Command("bash", {
    args: ["-c", `OP_SERVICE_ACCOUNT_TOKEN=$(textutil -convert txt -stdout ~/1password\\ service.rtf) op item get "${item}" --vault ClawdBot --fields label=${field} --reveal`],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`1Password lookup failed for ${item}/${field}: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function getSupabaseClient() {
  const url = await readOp("Open Brain - Supabase", "project_url");
  const key = await readOp("Open Brain - Supabase", "service_role_key");
  return createClient(url, key);
}

// --- Parse --mode argument ---
function getMode(): string {
  const idx = Deno.args.indexOf("--mode");
  if (idx === -1 || idx + 1 >= Deno.args.length) {
    throw new Error("Usage: daily-status.ts --mode <kickoff|checkin|warning|scorecard>");
  }
  const mode = Deno.args[idx + 1];
  if (!["kickoff", "checkin", "warning", "scorecard"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}. Must be one of: kickoff, checkin, warning, scorecard`);
  }
  return mode;
}

// --- Write today's stats to daily_stats table (called at scorecard time) ---
async function persistDailyStats(supabase: ReturnType<typeof createClient>, stats: Awaited<ReturnType<typeof fetchPipelineStats>>): Promise<void> {
  for (const t of stats.tracks) {
    const { error } = await supabase
      .from("daily_stats")
      .upsert(
        {
          date: stats.today,
          track: t.track,
          completed: t.completedToday,
          target: t.target,
          deficit: t.deficit,
        },
        { onConflict: "date,track" }
      );
    if (error) {
      console.warn(`daily_stats upsert failed for ${t.track}: ${error.message}`);
    }
  }
}

// --- Main ---
async function main() {
  const mode = getMode();
  console.log(`[${new Date().toISOString()}] daily-status running in mode: ${mode}`);

  const supabase = await getSupabaseClient();
  const channel = await getCaptureChannel();
  const stats = await fetchPipelineStats(supabase);

  let payload: { slack: string; email: { subject: string; html: string } } | null = null;

  if (mode === "kickoff") {
    payload = formatKickoff(stats);
  } else if (mode === "checkin") {
    payload = formatCheckin(stats);
  } else if (mode === "warning") {
    if (!shouldSendWarning(stats)) {
      console.log("No tracks are 50%+ remaining. Skipping warning message.");
      return;
    }
    payload = formatWarning(stats);
  } else if (mode === "scorecard") {
    payload = formatScorecard(stats);
    await persistDailyStats(supabase, stats);
  }

  if (!payload) return;

  // Send Slack
  try {
    await sendSlackMessage(channel, payload.slack);
    console.log("Slack message sent.");
  } catch (err) {
    console.error("Slack send failed:", err instanceof Error ? err.message : err);
  }

  // Send email
  try {
    await sendEmail({ subject: payload.email.subject, html: payload.email.html });
    console.log("Email sent.");
  } catch (err) {
    console.error("Email send failed:", err instanceof Error ? err.message : err);
  }
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
