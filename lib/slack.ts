// lib/slack.ts
//
// Reads credentials from 1Password once at import time (cached for the process lifetime).
// This avoids spawning a subprocess on every Slack notification.

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

// Cache credentials at module load
let _token: string | null = null;
let _channel: string | null = null;

async function getToken(): Promise<string> {
  if (!_token) _token = await readOp("Open Brain - Slack", "credential");
  if (!_token) throw new Error("Failed to read Slack bot token from 1Password");
  return _token;
}

export async function getCaptureChannel(): Promise<string> {
  if (!_channel) _channel = await readOp("Open Brain - Slack", "channel");
  if (!_channel) throw new Error("Failed to read Slack channel from 1Password");
  return _channel;
}

/** Send a message to a Slack channel. */
export async function sendSlackMessage(channel: string, text: string): Promise<void> {
  const token = await getToken();
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text }),
  });
  if (!resp.ok) throw new Error(`Slack HTTP error: ${resp.status}`);
  const body = await resp.json();
  if (!body.ok) throw new Error(`Slack API error: ${body.error}`);
}
