-- Run in the leads Supabase SQL editor, not the lending-system database.
begin;
alter table public.loan_applications
 add column if not exists review_mode text,
 add column if not exists web_company_id text,
 add column if not exists web_submission_id uuid,
 add column if not exists web_submission_digest text,
 add column if not exists application_route text,
 add column if not exists application_details jsonb,
 add column if not exists lending_reference text,
 add column if not exists statement_path text,
 add column if not exists statement_mime text,
 add column if not exists statement_processing_consent boolean,
 add column if not exists statement_review_state text,
 add column if not exists statement_review_lease_until timestamptz,
 add column if not exists statement_review_lease_id uuid;
create unique index if not exists loan_applications_web_submission on public.loan_applications(company_name,web_submission_id) where web_submission_id is not null;
create table if not exists public.application_statement_uploads (
 id uuid primary key, company_id text not null, submission_id uuid not null,
 route text not null check(route in ('remote','visit')), secret_hash text not null,
 path text unique not null, mime text not null, expires_at timestamptz not null,
 used_by text, created_at timestamptz not null default now()
);
alter table public.application_statement_uploads enable row level security;
revoke all on public.application_statement_uploads from anon,authenticated;
grant all on public.application_statement_uploads to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('application-statements','application-statements',false,10485760,array['application/pdf','image/png','image/jpeg'])
 on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;
-- No public/customer read policies are created. Staff downloads use a checked JWT on Render.
create or replace function public.claim_application_statement_review()
 returns setof public.loan_applications language sql security definer set search_path=public as $$
 update public.loan_applications set statement_review_state='processing',statement_review_lease_until=now()+interval '5 minutes',statement_review_lease_id=gen_random_uuid()
 where id=(select id from public.loan_applications where review_mode='staff-review-v1' and
 (statement_review_state='pending' or (statement_review_state='processing' and statement_review_lease_until<now()))
 and exists(select 1 from public.application_statement_uploads u where u.used_by=loan_applications.id::text and u.path=loan_applications.statement_path and u.company_id=loan_applications.web_company_id and u.submission_id=loan_applications.web_submission_id and u.route=loan_applications.application_route)
 order by created_at limit 1 for update skip locked)
 returning *;
$$;
revoke all on function public.claim_application_statement_review() from public,anon,authenticated;
grant execute on function public.claim_application_statement_review() to service_role;
commit;
