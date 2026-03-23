// lib/email.ts
//
// Sends email via Gmail SMTP using nodemailer.
// Credentials come from 1Password at runtime.

import nodemailer from "npm:nodemailer@6";

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

export async function sendEmail(opts: {
  subject: string;
  html: string;
}): Promise<void> {
  const email = await readOp("Daniel Gmail SMTP", "email");
  const appPassword = await readOp("Daniel Gmail SMTP", "app_password");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: email, pass: appPassword },
  });

  await transporter.sendMail({
    from: email,
    to: email,
    subject: opts.subject,
    html: opts.html,
  });
}
