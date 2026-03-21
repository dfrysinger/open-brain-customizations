-- Extension 6: Job Hunt Pipeline
-- Schema for tracking job search: companies, postings, applications, interviews, contacts

-- Table: companies
-- Organizations you're tracking in your job search
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    industry TEXT,
    website TEXT,
    size TEXT CHECK (size IN ('startup', 'mid-market', 'enterprise') OR size IS NULL),
    location TEXT,
    remote_policy TEXT CHECK (remote_policy IN ('remote', 'hybrid', 'onsite') OR remote_policy IS NULL),
    notes TEXT,
    glassdoor_rating DECIMAL(2,1) CHECK (glassdoor_rating >= 1.0 AND glassdoor_rating <= 5.0),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: job_postings
-- Specific roles at companies
CREATE TABLE IF NOT EXISTS job_postings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    title TEXT,
    url TEXT UNIQUE,
    salary_min INTEGER,
    salary_max INTEGER,
    salary_currency TEXT DEFAULT 'USD',
    requirements TEXT[],
    nice_to_haves TEXT[],
    location TEXT,
    notes TEXT,
    source TEXT CHECK (source IN ('linkedin', 'company-site', 'referral', 'recruiter', 'greenhouse', 'lever', 'workday', 'indeed', 'other') OR source IS NULL),
    posted_date DATE,
    closing_date DATE,
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low') OR priority IS NULL),
    enrichment_error TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: applications
-- Your submitted applications
CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_posting_id UUID REFERENCES job_postings(id) ON DELETE CASCADE NOT NULL,
    status TEXT DEFAULT 'applied' CHECK (status IN ('draft', 'ready', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn')),
    applied_date DATE,
    response_date DATE,
    resume_version TEXT,
    resume_path TEXT,
    cover_letter_path TEXT,
    cover_letter_notes TEXT,
    referral_contact TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: interviews
-- Scheduled and completed interviews
CREATE TABLE IF NOT EXISTS interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES applications(id) ON DELETE CASCADE NOT NULL,
    interview_type TEXT CHECK (interview_type IN ('phone_screen', 'technical', 'behavioral', 'system_design', 'hiring_manager', 'team', 'final')),
    scheduled_at TIMESTAMPTZ,
    duration_minutes INTEGER,
    interviewer_name TEXT,
    interviewer_title TEXT,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
    notes TEXT, -- pre-interview prep notes
    feedback TEXT, -- post-interview reflection
    rating INTEGER CHECK (rating >= 1 AND rating <= 5), -- your assessment of how it went
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: job_contacts
-- People associated with your job search
CREATE TABLE IF NOT EXISTS job_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    title TEXT,
    email TEXT,
    phone TEXT,
    linkedin_url TEXT,
    role_in_process TEXT CHECK (role_in_process IN ('recruiter', 'hiring_manager', 'referral', 'interviewer', 'other') OR role_in_process IS NULL),
    professional_crm_contact_id UUID, -- FK to Extension 5's professional_contacts table (not enforced by DB, managed by application)
    notes TEXT,
    last_contacted TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_job_postings_company_id
    ON job_postings(company_id);

CREATE INDEX IF NOT EXISTS idx_applications_status
    ON applications(status);

CREATE INDEX IF NOT EXISTS idx_applications_job_posting
    ON applications(job_posting_id);

CREATE INDEX IF NOT EXISTS idx_interviews_application_scheduled
    ON interviews(application_id, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_interviews_scheduled
    ON interviews(scheduled_at)
    WHERE scheduled_at IS NOT NULL;

-- Row Level Security (RLS)
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_contacts ENABLE ROW LEVEL SECURITY;

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to update updated_at columns
DROP TRIGGER IF EXISTS update_companies_updated_at ON companies;
CREATE TRIGGER update_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_applications_updated_at ON applications;
CREATE TRIGGER update_applications_updated_at
    BEFORE UPDATE ON applications
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
