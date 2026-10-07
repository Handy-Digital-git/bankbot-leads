-- Run after assignment-migration.sql in the leads Supabase project.
-- No existing customer records or assignments are changed.
begin;
create table if not exists public.lead_assignment_settings (
 company_name text primary key,
 assign_remote_applications boolean not null default false,
 updated_at timestamptz not null default now(),
 updated_by uuid
);
alter table public.lead_assignment_settings enable row level security;
revoke all on public.lead_assignment_settings from public,anon,authenticated;
grant all on public.lead_assignment_settings to service_role;

create or replace function public.get_lead_assignment_settings()
returns jsonb language plpgsql security definer set search_path=public as $$
declare company text; staff_role text; enabled boolean;
begin
 select u.company_name,u.role into strict company,staff_role
 from public.users u join auth.users a on lower(a.email)=lower(u.email)
 where a.id=auth.uid() and a.email_confirmed_at is not null;
 if company is null or btrim(company)='' or staff_role is null or staff_role not in ('admin','manager','agent') then
  raise exception 'Sign in with a company staff account.' using errcode='42501';
 end if;
 select assign_remote_applications into enabled from public.lead_assignment_settings where company_name=company;
 return jsonb_build_object('companyName',company,'assignRemoteApplications',coalesce(enabled,false),'canManage',staff_role='admin');
exception when no_data_found or too_many_rows then
 raise exception 'Sign in with a company staff account.' using errcode='42501';
end;
$$;
create or replace function public.set_remote_assignment(enabled boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare company text; staff_role text;
begin
 select u.company_name,u.role into strict company,staff_role
 from public.users u join auth.users a on lower(a.email)=lower(u.email)
 where a.id=auth.uid() and a.email_confirmed_at is not null;
 if company is null or btrim(company)='' or staff_role is distinct from 'admin' then
  raise exception 'Only a company administrator can change remote assignment.' using errcode='42501';
 end if;
 if enabled is null then raise exception 'Choose on or off.' using errcode='22023'; end if;
 insert into public.lead_assignment_settings(company_name,assign_remote_applications,updated_by)
 values(company,enabled,auth.uid()) on conflict(company_name) do update
 set assign_remote_applications=excluded.assign_remote_applications,updated_at=now(),updated_by=excluded.updated_by;
 return public.get_lead_assignment_settings();
exception when no_data_found or too_many_rows then
 raise exception 'Only a company administrator can change remote assignment.' using errcode='42501';
end;
$$;
revoke all on function public.get_lead_assignment_settings(),public.set_remote_assignment(boolean) from public,anon;
grant execute on function public.get_lead_assignment_settings(),public.set_remote_assignment(boolean) to authenticated;

create or replace function public.lead_assignment_allowed(route text, method text, company text)
returns boolean language sql stable security definer set search_path=public as $$
 select public.lead_allows_assignment(route,method) or (
  case when nullif(btrim(coalesce(route,'')),'') is not null then lower(btrim(route))='remote'
  else position('remote' in lower(coalesce(method,'')))>0 end
  and coalesce((select assign_remote_applications from public.lead_assignment_settings where company_name=company),false)
 );
$$;
revoke all on function public.lead_assignment_allowed(text,text,text) from public,anon;
grant execute on function public.lead_assignment_allowed(text,text,text) to authenticated,service_role;

create or replace function public.enforce_agent_visit_assignment()
returns trigger language plpgsql security definer set search_path=public as $$
declare route_changed boolean := TG_OP='INSERT'
 or NEW.application_route is distinct from OLD.application_route
 or NEW.method_collection is distinct from OLD.method_collection
 or NEW.company_name is distinct from OLD.company_name;
begin
 if not public.lead_assignment_allowed(NEW.application_route,NEW.method_collection,NEW.company_name) and (
  (nullif(btrim(NEW.assigned_agent::text),'') is not null and (route_changed or NEW.assigned_agent is distinct from OLD.assigned_agent))
  or (nullif(btrim(NEW.assigned_branch::text),'') is not null and (route_changed or NEW.assigned_branch is distinct from OLD.assigned_branch))
  or (NEW.assigned_time is not null and (route_changed or NEW.assigned_time is distinct from OLD.assigned_time))
  or (NEW.assignment ~ '^(agent|branch):' and (route_changed or NEW.assignment is distinct from OLD.assignment))
 ) then
  raise exception 'Remote assignment is switched off, or this application type cannot be assigned.' using errcode='23514';
 end if;
 return NEW;
end;
$$;
commit;
