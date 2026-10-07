-- Test the installed rule with a temporary table and rolled-back fictional settings.
-- No customer records, notifications or persistent settings are changed.
begin;
create temporary table assignment_policy_check (
 id text primary key, application_route text, method_collection text, company_name text,
 assigned_agent text, assigned_branch uuid, assigned_time timestamp, assignment text, status text
);
alter table assignment_policy_check enable row level security;
create trigger assignment_check before insert or update on assignment_policy_check
for each row execute function public.enforce_agent_visit_assignment();
insert into public.lead_assignment_settings(company_name,assign_remote_applications)
values ('TEST assignment setting 20261007 A',false),('TEST assignment setting 20261007 B',false);
do $$
begin
 if has_table_privilege('authenticated','public.lead_assignment_settings','INSERT')
 or has_table_privilege('authenticated','public.lead_assignment_settings','UPDATE')
 or has_function_privilege('anon','public.set_remote_assignment(boolean)','EXECUTE') then
  raise exception 'Unexpected direct settings access';
 end if;
 begin
  perform public.set_remote_assignment(true);
  raise exception 'Settings accepted an unauthenticated caller';
 exception when insufficient_privilege then null; end;
 insert into assignment_policy_check values ('visit','visit',null,'TEST assignment setting 20261007 A','Agent',null,null,null,'New');
 insert into assignment_policy_check values ('remote','remote',null,'TEST assignment setting 20261007 A',null,null,null,null,'New');
 begin
  update assignment_policy_check set assigned_agent='Agent' where id='remote';
  raise exception 'Remote assignment accepted while off';
 exception when check_violation then null; end;
 update public.lead_assignment_settings set assign_remote_applications=true where company_name='TEST assignment setting 20261007 A';
 update assignment_policy_check set assigned_agent='Agent',assignment='agent:example' where id='remote';
 insert into assignment_policy_check values ('legacy',null,'Remote Collections','TEST assignment setting 20261007 A','Agent',null,null,null,'New');
 begin
  insert into assignment_policy_check values ('other-company','remote',null,'TEST assignment setting 20261007 B','Agent',null,null,null,'New');
  raise exception 'Remote setting leaked into another company';
 exception when check_violation then null; end;
 begin
  insert into assignment_policy_check values ('unknown','other','Remote Collections','TEST assignment setting 20261007 A','Agent',null,null,null,'New');
  raise exception 'Unknown route accepted';
 exception when check_violation then null; end;
 update public.lead_assignment_settings set assign_remote_applications=false where company_name='TEST assignment setting 20261007 A';
 update assignment_policy_check set status='In Progress' where id='remote';
 begin
  update assignment_policy_check set assigned_agent='Another agent' where id='remote';
  raise exception 'Remote reassignment accepted while off';
 exception when check_violation then null; end;
 begin
  update assignment_policy_check set assigned_branch='00000000-0000-4000-8000-000000000001' where id='remote';
  raise exception 'Remote branch assignment accepted while off';
 exception when check_violation then null; end;
 update assignment_policy_check set assigned_agent=null,assignment=null,assigned_time=null where id='remote';
end;
$$;
rollback;
