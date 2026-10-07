// Render-side routes. Install with the supplied migration and dashboard update.
import { randomBytes,randomUUID,createHash,timingSafeEqual } from 'node:crypto';
import { createStatementExtractor,createStatementReport,validateStatementFile } from './statement-review.js';
const bucket='application-statements';
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function authenticateIntegration(headers,integrations){
 const id=headers['x-application-company'],config=integrations[id],token=String(headers.authorization||'').replace(/^Bearer /,'');
 if(!/^[a-z][a-z0-9-]{1,49}$/.test(id||'')|| !config || typeof config.token!=='string' || config.token.length<32 || !equal(token,config.token))throw fail(401,'Invalid application connection.');
 if(!config.companyName || !config.openaiApiKey)throw fail(503,'Application connection is incomplete.');
 return {...config,id};
}
const checked=result=>{if(result.error)throw fail(503,'Private application storage is unavailable.');return result.data;};
export function createLeadsReceiver({supabase,integrations={},dashboardReady=false,extract=createStatementExtractor(),now=()=>Date.now(),getReadableLead}={}){
 let working=false;
 async function documentFor(lead){
  const ticket=checked(await supabase.from('application_statement_uploads').select('company_id,path,mime,submission_id,route,used_by').eq('path',lead.statement_path).eq('used_by',String(lead.id)).maybeSingle());
  if(!ticket||ticket.company_id!==lead.web_company_id||ticket.submission_id!==lead.web_submission_id||ticket.route!==lead.application_route||!ticket.path.startsWith(ticket.company_id+'/'))throw fail(403,'This document is not attached to this application.');
  return ticket;
 }
 async function reviewNext(){
  if(working || !dashboardReady)return;working=true;
  try{
   // Database lease allows recovery after a Render restart without duplicate workers.
   const claimed=checked(await supabase.rpc('claim_application_statement_review'));
   const lead=Array.isArray(claimed)?claimed[0]:claimed;if(!lead)return;
   const config=integrations[lead.web_company_id];
   let report='**Review status:** Awaiting staff review. Staff need to check the original statement; automatic extraction could not be completed.',state='needs-check';
   try{
    if(!config?.openaiApiKey || config.companyName!==lead.company_name)throw Error('Configuration');
    const document=await documentFor(lead);
    const file=checked(await supabase.storage.from(bucket).download(document.path));
    if(file.size>10*1024*1024)throw Error('Size');
    const bytes=Buffer.from(await file.arrayBuffer());
    const facts=await extract({bytes,mime:document.mime,consent:lead.statement_processing_consent===true,apiKey:config.openaiApiKey});
    report=createStatementReport(facts).report;state='complete';
   }catch{/* Keep original for staff; never turn an extraction failure into a lending decision. */}
   checked(await supabase.from('loan_applications').update({ai_decision:report,statement_review_state:state,statement_review_lease_until:null}).eq('id',lead.id).eq('statement_review_lease_id',lead.statement_review_lease_id));
  }catch{/* A durable pending/expired lease remains retryable. Do not log statement contents or provider errors. */}
  finally{working=false;}
 }
 return {
  async status(config){
   const checks={leadFields:false,uploadTable:false,privateBucket:false,dashboardReady,openAIKeyConfigured:/^sk-/.test(config.openaiApiKey)};
   try{checked(await supabase.from('loan_applications').select('id,review_mode,statement_path').limit(0));checks.leadFields=true;}catch{}
   try{checked(await supabase.from('application_statement_uploads').select('id').limit(0));checks.uploadTable=true;}catch{}
   try{checks.privateBucket=checked(await supabase.storage.getBucket(bucket)).public===false;}catch{}
   return {statementVaultCopy:true,ready:Object.values(checks).every(value=>value===true),checks,capabilities:{agentStatementDeferral:true,assignmentContactDetails:true}};
  },
  async uploads(config,input){
   if(!dashboardReady)throw fail(503,'The staff review dashboard is not ready.');
   if(!uuid(input.submissionId)||!['remote','visit'].includes(input.route)||input.consent!==true||!['application/pdf','image/png','image/jpeg'].includes(input.mime))throw fail(422,'Invalid statement upload.');
   const id=randomUUID(),secret=randomBytes(32).toString('hex'),extension={'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg'}[input.mime],path=`${config.id}/${id}/statement.${extension}`;
   checked(await supabase.from('application_statement_uploads').insert({id,company_id:config.id,submission_id:input.submissionId,route:input.route,secret_hash:hash(secret),path,mime:input.mime,expires_at:new Date(now()+2*3600000).toISOString()}));
   const signed=checked(await supabase.storage.from(bucket).createSignedUploadUrl(path,{upsert:false}));
   return {uploadId:id,secret,uploadUrl:signed.signedUrl,mime:input.mime};
  },
  async applications(config,input){
   if(!dashboardReady)throw fail(503,'The staff review dashboard is not ready.');
   const deferred=input.route==='visit'&&input.statementDeferred===true&&!input.statement;
   if(!uuid(input.submissionId)||!['remote','visit'].includes(input.route)||(!deferred&&(!uuid(input.statement?.uploadId)|| !/^[0-9a-f]{64}$/.test(input.statement?.secret||'')))|| !Array.isArray(input.formRows)||input.formRows.length>200||input.formRows.some(row=>typeof row.label!=='string'||row.label.length>200||typeof row.value!=='string'||row.value.length>10000))throw fail(422,'Invalid application.');
   if(input.route==='remote' && !/^[-A-Za-z0-9]{1,50}$/.test(input.lendingReference||''))throw fail(422,'A lending application reference is required.');
   const fields=input.fields||{},allowed=['first_name','surname','dob','amount_requested','loan_term','reason_for_borrowing','employment_status','credit_used_before','income','ccj','trust_deed','mental_health','address','town','postcode','accommodation_type','move_in_date','phone_number','best_call_time','email','method_collection'];
   if(!fields.first_name||!fields.surname||allowed.some(key=>fields[key]!==undefined&&(typeof fields[key]!=='string'||fields[key].length>1000)))throw fail(422,'Invalid applicant details.');
   if(deferred){
    const digest=hash(JSON.stringify({...input,statementDeferred:true,statement:null}));
    const previous=checked(await supabase.from('loan_applications').select('id,web_submission_digest').eq('company_name',config.companyName).eq('web_submission_id',input.submissionId).maybeSingle());
    if(previous){if(previous.web_submission_digest!==digest)throw fail(409,'Application reference already used for different details.');return {reference:'AG-'+input.submissionId.replaceAll('-','').slice(0,16).toUpperCase(),agentVisit:true,status:'received',duplicate:true};}
    const row={...Object.fromEntries(allowed.filter(key=>fields[key]!==undefined).map(key=>[key,fields[key]])),id:randomUUID(),created_at:new Date(now()).toISOString(),company_name:config.companyName,status:'New',should_decline:null,review_mode:'staff-review-v1',web_company_id:config.id,web_submission_id:input.submissionId,web_submission_digest:digest,application_route:'visit',application_details:{rows:input.formRows,quote:input.quote,confirmations:input.confirmations,statementDeferred:true},lending_reference:null,statement_path:null,statement_mime:null,statement_processing_consent:false,statement_review_state:'awaiting-statement',ai_decision:'**Review status:** Bank statement not provided. Applicant confirmed they wish to proceed with an agent visit. Staff must arrange the required documentation. No AI statement review has been performed.'};
    const inserted=await supabase.from('loan_applications').insert(row).select('id').single();
    if(inserted.error?.code==='23505')return this.applications(config,input);
    checked(inserted);
    return {reference:'AG-'+input.submissionId.replaceAll('-','').slice(0,16).toUpperCase(),agentVisit:true,status:'received',duplicate:false};
   }
   const digest=hash(JSON.stringify({...input,statement:{uploadId:input.statement.uploadId}}));
   const ticket=checked(await supabase.from('application_statement_uploads').select('*').eq('id',input.statement.uploadId).maybeSingle());
   if(!ticket || ticket.company_id!==config.id || ticket.submission_id!==input.submissionId || ticket.route!==input.route || !equal(ticket.secret_hash,hash(input.statement.secret)))throw fail(422,'Invalid statement ownership.');
   const previous=checked(await supabase.from('loan_applications').select('id,web_submission_digest').eq('company_name',config.companyName).eq('web_submission_id',input.submissionId).maybeSingle());
   if(previous){if(previous.web_submission_digest!==digest || ticket.used_by&&ticket.used_by!==String(previous.id))throw fail(409,'Application reference already used for different details.');if(!ticket.used_by)checked(await supabase.from('application_statement_uploads').update({used_by:String(previous.id)}).eq('id',ticket.id));return {reference:'AG-'+input.submissionId.replaceAll('-','').slice(0,16).toUpperCase(),agentVisit:input.route==='visit',status:'received',duplicate:true};}
   if(ticket.used_by || new Date(ticket.expires_at).getTime()<=now())throw fail(422,'The statement upload expired. Please upload it again.');
   const file=checked(await supabase.storage.from(bucket).download(ticket.path));
   if(file.size>10*1024*1024)throw fail(413,'Choose a statement up to 10 MB.');
   validateStatementFile(Buffer.from(await file.arrayBuffer()),ticket.mime);
   const row={...Object.fromEntries(allowed.filter(key=>fields[key]!==undefined).map(key=>[key,fields[key]])),id:randomUUID(),created_at:new Date(now()).toISOString(),company_name:config.companyName,status:'New',should_decline:null,review_mode:'staff-review-v1',web_company_id:config.id,web_submission_id:input.submissionId,web_submission_digest:digest,application_route:input.route,application_details:{rows:input.formRows,quote:input.quote,confirmations:input.confirmations},lending_reference:input.route==='remote'?input.lendingReference:null,statement_path:ticket.path,statement_mime:ticket.mime,statement_processing_consent:true,statement_review_state:'pending',ai_decision:'**Review status:** Awaiting staff review. Statement extraction is queued. Staff make the lending decision.'};
   const inserted=await supabase.from('loan_applications').insert(row).select('id').single();
   if(inserted.error?.code==='23505')return this.applications(config,input); // Winner is verified by digest above.
   const lead=checked(inserted);
   checked(await supabase.from('application_statement_uploads').update({used_by:String(lead.id)}).eq('id',ticket.id));
   return {reference:'AG-'+input.submissionId.replaceAll('-','').slice(0,16).toUpperCase(),agentVisit:input.route==='visit',status:'received',duplicate:false};
  },
  async verify(config,input){
   if(!dashboardReady)throw fail(503,'The staff review dashboard is not ready.');
   if(!uuid(input.submissionId)||!uuid(input.statement?.uploadId)|| !['remote','visit'].includes(input.route)|| !/^[0-9a-f]{64}$/.test(input.statement?.secret||''))throw fail(422,'Invalid statement upload.');
   const ticket=checked(await supabase.from('application_statement_uploads').select('*').eq('id',input.statement.uploadId).maybeSingle());
   if(!ticket||ticket.company_id!==config.id||ticket.submission_id!==input.submissionId||ticket.route!==input.route||!equal(ticket.secret_hash,hash(input.statement.secret))||(!ticket.used_by&&new Date(ticket.expires_at).getTime()<=now()))throw fail(422,'Invalid or expired statement upload.');
   const file=checked(await supabase.storage.from(bucket).download(ticket.path));if(file.size>10*1024*1024)throw fail(413,'Choose a statement up to 10 MB.');const bytes=Buffer.from(await file.arrayBuffer());validateStatementFile(bytes,ticket.mime);
   if(input.vaultCopy===true){
    if(input.route!=='remote')throw fail(422,'Only remote applications send statements to the lending vault.');
    const signed=checked(await supabase.storage.from(bucket).createSignedUrl(ticket.path,300));
    return {valid:true,vaultDocument:{url:signed.signedUrl,mime:ticket.mime,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}};
   }
   return {valid:true};
  },
  async download(token,id){
   if(!token || String(token).length>8192 || !/^[A-Za-z0-9-]{1,100}$/.test(id||''))throw fail(401,'Sign in to view this document.');
   const auth=await supabase.auth.getUser(token),user=auth.data?.user;if(auth.error||!user?.email||!user.email_confirmed_at)throw fail(401,'Sign in to view this document.');
   const staff=checked(await supabase.from('users').select('role,company_name,branch').eq('email',user.email).maybeSingle());
   // Check as the caller, not as the privileged worker, so existing RLS remains in force.
   const readable=getReadableLead?await getReadableLead(token,id):null;
   const lead=readable?{...readable,id}:null;
   if(!lead||!staff||staff.company_name!==lead.company_name||(staff.branch&&staff.branch!==lead.assigned_branch)||!lead.statement_path?.startsWith(lead.web_company_id+'/'))throw fail(403,'You do not have access to this statement.');
   if(integrations[lead.web_company_id]?.companyName!==lead.company_name)throw fail(403,'This document does not belong to this company.');
   if(staff.role==='agent'){
    const agent=checked(await supabase.from('agents').select('name,company_name,active').eq('email',user.email).maybeSingle());
    if(!agent?.active||agent.company_name!==staff.company_name||agent.name!==lead.assigned_agent)throw fail(403,'You do not have access to this statement.');
   }else if(!['admin','manager'].includes(staff.role))throw fail(403,'You do not have access to this statement.');
   const document=await documentFor(lead);
   const signed=checked(await supabase.storage.from(bucket).createSignedUrl(document.path,60));return {url:signed.signedUrl};
  },
  reviewNext,
  async cleanOrphans(){
   // Wait beyond the signed upload token's two-hour life before removing an unused object.
   const tickets=checked(await supabase.from('application_statement_uploads').select('id,path').is('used_by',null).lt('expires_at',new Date(now()-3600000).toISOString()).limit(100));
   for(const ticket of tickets||[]){
    const attached=checked(await supabase.from('loan_applications').select('id').eq('statement_path',ticket.path).maybeSingle());if(attached)continue;
    checked(await supabase.storage.from(bucket).remove([ticket.path]));checked(await supabase.from('application_statement_uploads').delete().eq('id',ticket.id).is('used_by',null));
   }
  },
 };
}
export function registerApplicationPlatform(app,{supabase,env=process.env,createUserClient}={}){
 let integrations;try{integrations=JSON.parse(env.APPLICATION_PLATFORM_INTEGRATIONS_JSON||'{}');}catch{throw Error('Invalid application platform connection configuration.');}
 const getReadableLead=async(token,id)=>{
  if(!createUserClient)return null;
  try{const result=await createUserClient(token).from('loan_applications').select('company_name,assigned_agent,assigned_branch,statement_path,web_company_id,web_submission_id,application_route').eq('id',id).maybeSingle();return result.error?null:result.data;}catch{return null;}
 };
 const receiver=createLeadsReceiver({supabase,integrations,dashboardReady:env.APPLICATION_PLATFORM_DASHBOARD_READY==='true',getReadableLead});
 for(const action of ['uploads','applications','verify','status'])app.post('/api/application-platform/'+action,async(req,res)=>{
  res.set('Cache-Control','no-store');try{const config=authenticateIntegration(req.headers,integrations);const result=await receiver[action](config,req.body||{});res.status(result.duplicate?200:201).json(result);}catch(error){res.status(error.status||503).json({error:error.status?error.message:'Application service is unavailable.'});}
 });
 app.post('/api/application-platform/statement-download',async(req,res)=>{
  res.set('Cache-Control','no-store');try{res.json(await receiver.download(String(req.headers.authorization||'').replace(/^Bearer /,''),String(req.body?.id||'')));}catch(error){res.status(error.status||503).json({error:error.status?error.message:'Document is unavailable.'});}
 });
 const timer=setInterval(()=>void receiver.reviewNext(),10000);timer.unref();
 const cleaner=setInterval(()=>void receiver.cleanOrphans().catch(()=>{}),3600000);cleaner.unref();
 void receiver.reviewNext();return receiver;
}
