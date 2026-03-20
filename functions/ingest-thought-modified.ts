import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const SLACK_CAPTURE_CHANNEL = Deno.env.get("SLACK_CAPTURE_CHANNEL")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.` },
        { role: "user", content: text },
      ],
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    console.error(`OpenRouter metadata extraction failed: ${r.status} ${msg}`);
    return { topics: ["uncategorized"], type: "observation", _extraction_failed: true };
  }
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch (parseErr) {
    console.error("Failed to parse metadata response:", d.choices?.[0]?.message?.content?.slice(0, 200));
    return { topics: ["uncategorized"], type: "observation", _extraction_failed: true };
  }
}

async function replyInSlack(channel: string, threadTs: string, text: string): Promise<void> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
  if (!resp.ok) {
    console.error(`Slack HTTP error: ${resp.status}`);
    return;
  }
  const body = await resp.json();
  if (!body.ok) {
    console.error(`Slack reply failed: ${body.error}`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const body = await req.json();
    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const event = body.event;
    if (!event || event.type !== "message" || event.subtype || event.bot_id
        || event.channel !== SLACK_CAPTURE_CHANNEL) {
      return new Response("ok", { status: 200 });
    }
    const messageText: string = event.text;
    const channel: string = event.channel;
    const messageTs: string = event.ts;
    if (!messageText || messageText.trim() === "") return new Response("ok", { status: 200 });

    // --- Job Board URL Detection ---
    const linkedinMatch = messageText.match(/https?:\/\/[^\s]*linkedin\.com\/jobs\/view\/\d+[^\s]*/);
    if (linkedinMatch) {
      const jobUrl = linkedinMatch[0].replace(/[<>|].*/g, '').replace(/[<>]/g, ''); // Clean Slack URL formatting
      let title: string | null = null;
      let companyName: string | null = null;
      let location: string | null = null;

      // Best-effort: try to fetch OG meta tags (will usually fail for LinkedIn)
      try {
        const resp = await fetch(jobUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
          redirect: "follow",
        });
        if (resp.ok) {
          const html = await resp.text();
          const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
          if (ogTitle) {
            const parts = ogTitle[1].split(" at ");
            if (parts.length >= 2) {
              title = parts[0].trim();
              companyName = parts.slice(1).join(" at ").trim();
            }
          }
        }
      } catch { /* Expected — LinkedIn blocks server-side fetches */ }

      // Look up or create company if we got a name
      let company_id: string | null = null;
      if (companyName) {
        const { data: existing } = await supabase
          .from("companies")
          .select("id")
          .ilike("name", companyName)
          .limit(1)
          .maybeSingle();
        if (existing) {
          company_id = existing.id;
        } else {
          const { data: newCo, error: coErr } = await supabase
            .from("companies")
            .insert({ name: companyName })
            .select("id")
            .single();
          if (coErr) {
            console.error(`Failed to create company "${companyName}": ${coErr.message}`);
          } else {
            company_id = newCo?.id ?? null;
          }
        }
      }

      // Upsert job posting (URL is unique)
      const row: Record<string, unknown> = { url: jobUrl, source: "linkedin" };
      if (company_id != null) row.company_id = company_id;
      if (title != null) row.title = title;
      if (location != null) row.location = location;

      const { data: jobPosting, error: jpError } = await supabase
        .from("job_postings")
        .upsert(row, { onConflict: "url" })
        .select()
        .single();

      if (jpError) {
        console.error("Job posting upsert error:", jpError);
        await replyInSlack(channel, messageTs, "Failed to save job link — internal error.");
        return new Response("error", { status: 500 });
      }

      // Reply with confirmation
      let reply: string;
      if (title && companyName) {
        reply = `Saved: *${title}* at *${companyName}*${location ? ` (${location})` : ""}. Details will be verified by daily enrichment.`;
      } else {
        reply = `Saved the link. Details will be filled in automatically within 24 hours. You can optionally reply with the role and company name.`;
      }
      await replyInSlack(channel, messageTs, reply);
      return new Response("ok", { status: 200 });
    }
    // --- End Job Board URL Detection ---

    const [embedding, metadata] = await Promise.all([
      getEmbedding(messageText),
      extractMetadata(messageText),
    ]);

    const { error } = await supabase.from("thoughts").insert({
      content: messageText,
      embedding,
      metadata: { ...metadata, source: "slack", slack_ts: messageTs },
    });

    if (error) {
      console.error("Supabase insert error:", error);
      await replyInSlack(channel, messageTs, `Failed to capture: ${error.message}`);
      return new Response("error", { status: 500 });
    }

    const meta = metadata as Record<string, unknown>;
    let confirmation = `Captured as *${meta.type || "thought"}*`;
    if (Array.isArray(meta.topics) && meta.topics.length > 0)
      confirmation += ` - ${meta.topics.join(", ")}`;
    if (Array.isArray(meta.people) && meta.people.length > 0)
      confirmation += `\nPeople: ${meta.people.join(", ")}`;
    if (Array.isArray(meta.action_items) && meta.action_items.length > 0)
      confirmation += `\nAction items: ${meta.action_items.join("; ")}`;

    await replyInSlack(channel, messageTs, confirmation);
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Function error:", err);
    return new Response("error", { status: 500 });
  }
});
