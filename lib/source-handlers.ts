export interface JobBoardHandler {
  name: string;
  urlPattern: RegExp;
  /** Best-effort server-side extraction from HTML/meta tags. May return partial or empty. */
  extractFromHtml(html: string): Partial<JobDetails>;
}

export interface JobDetails {
  title: string;
  company: string;
  location: string;
  source: string;
  remotePolicy: string;
  postedDate: string;
}

export const linkedinHandler: JobBoardHandler = {
  name: "linkedin",
  urlPattern: /linkedin\.com\/jobs\/view\/\d+/,
  extractFromHtml(html: string): Partial<JobDetails> {
    const details: Partial<JobDetails> = { source: "linkedin" };
    // Extract og:title — often "Job Title at Company"
    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (titleMatch) {
      const parts = titleMatch[1].split(" at ");
      if (parts.length >= 2) {
        details.title = parts[0].trim();
        details.company = parts.slice(1).join(" at ").trim();
      }
    }
    // Extract og:description for location hints
    const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (descMatch) {
      const locMatch = descMatch[1].match(/in\s+([^.]+)/);
      if (locMatch) details.location = locMatch[1].trim();
    }
    return details;
  },
};

/** Registry of all handlers. Add new job boards here. */
export const handlers: JobBoardHandler[] = [linkedinHandler];

/** Find the matching handler for a URL, or null. Handles Slack's <url> formatting. */
export function matchHandler(text: string): { handler: JobBoardHandler; url: string } | null {
  // Strip Slack's angle-bracket URL formatting before matching
  const cleaned = text.replace(/[<>]/g, "");
  for (const handler of handlers) {
    const match = cleaned.match(handler.urlPattern);
    if (match) {
      // Extract the full URL
      const urlMatch = cleaned.match(new RegExp(`https?://[^\\s]*${handler.urlPattern.source}[^\\s]*`));
      const url = (urlMatch ? urlMatch[0] : match[0]).split(/[|>]/)[0]; // Handle Slack's <url|label> format
      return { handler, url };
    }
  }
  return null;
}
