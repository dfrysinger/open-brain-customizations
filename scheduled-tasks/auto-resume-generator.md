---
name: auto-resume-generator
description: Hourly scan for new job postings without resumes
---

You have access to the job-hunt MCP server. Your job is to find job postings that need resumes and generate them automatically.
## Step 1: Check daily cap
Count how many resume .docx files were created today in:
`~/Library/CloudStorage/Dropbox/Resume/2026 Resume - Claude/`
Check subdirectories too. Use file modification dates to count only today's files. If 10 or more were created today, report "Daily cap reached (10 resumes)" and stop.
## Step 2: Find postings that need resumes
Call `search_job_postings` with no filters to get all job postings.
For each posting, check its `applications` array:
- If it has no applications at all → needs a resume
- If all applications have `resume_path: null` → needs a resume
- If any application has a non-null `resume_path` → skip (already has a resume)

**Filesystem cross-check:** For each posting that passes the DB check above, also check whether a resume .docx file already exists on disk in the company's subfolder under `~/Library/CloudStorage/Dropbox/Resume/2026 Resume - Claude/`. Use `find` with `-iname "*companyname*" -name "*.docx"` to search. If a matching file exists on disk, skip that posting (the DB is out of sync). Optionally update the application's `resume_path` to match the file found on disk.
## Step 3: Sort by priority
Sort the postings that need resumes:
1. `priority: "high"` first
2. `priority: "medium"` second (or null — treat null as medium)
3. `priority: "low"` last
## Step 4: Generate resumes (max 5 per run)
For each posting (in priority order, up to 5):
1. Check the daily cap again (count files created today). If at 10, stop.
2. Spawn the `resume-optimizer` agent using the Agent tool:
   - Pass the job posting URL as the prompt
   - The agent will fetch the job description, create a tailored resume, and call submit_application with status "draft" and the resume_path
3. Note the result (success or failure) for the summary.
## Step 5: Summary
Report:
- Resumes generated this run: X
- Resumes generated today (total): X
- Postings still waiting: X
- Any failures: list the posting URLs that failed
If no postings needed resumes, just say "No new postings need resumes."