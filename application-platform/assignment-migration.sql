-- Apply in the leads Supabase project after the application-platform migration.
-- Existing assignments are preserved; new assignments are restricted to agent visits.
begin;
create or replace function public.lead_allows_assignment(route text, method text)
returns boolean language sql immutable as $$
 select case
  when nullif(btrim(coalesce(route,'')),'') is not null then lower(btrim(route))='visit'
  else position('remote' in lower(coalesce(method,'')))=0
   and (lower(btrim(coalesce(method,'')))='agent visit' or position('doorstep' in lower(coalesce(method,'')))>0)
 end;
$$;
create or replace function public.enforce_agent_visit_assignment()
returns trigger language plpgsql set search_path=public as $$
declare
 route_changed boolean := TG_OP='INSERT'
  or NEW.application_route is distinct from OLD.application_route
  or NEW.method_collection is distinct from OLD.method_collection;
begin
 if not public.lead_allows_assignment(NEW.application_route,NEW.method_collection) and (
  (nullif(btrim(NEW.assigned_agent::text),'') is not null and (route_changed or NEW.assigned_agent is distinct from OLD.assigned_agent))
  or (nullif(btrim(NEW.assigned_branch::text),'') is not null and (route_changed or NEW.assigned_branch is distinct from OLD.assigned_branch))
  or (NEW.assigned_time is not null and (route_changed or NEW.assigned_time is distinct from OLD.assigned_time))
  or (NEW.assignment ~ '^(agent|branch):' and (route_changed or NEW.assignment is distinct from OLD.assignment))
 ) then
  raise exception 'Only agent visit applications can be assigned.' using errcode='23514';
 end if;
 return NEW;
end;
$$;
drop trigger if exists agent_visit_assignment_only on public.loan_applications;
create trigger agent_visit_assignment_only before insert or update on public.loan_applications
for each row execute function public.enforce_agent_visit_assignment();
commit;
