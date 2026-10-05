import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {authenticateIntegration,createLeadsReceiver} from '../application-platform/leads-receiver.js';
const config={id:'handycash',companyName:'Handycash Home Credit Ltd',token:'a'.repeat(64),openaiApiKey:'private-test-key'};
function memory(){
 const db={application_statement_uploads:[],loan_applications:[],users:[]},files=new Map(),signs=[];let user={email:'staff@example.com',email_confirmed_at:'2026-01-01'};
 return {db,files,signs,setUser:value=>user=value,client:{
  auth:{getUser:async()=>({data:{user},error:null})},
  storage:{from:()=>({createSignedUploadUrl:async path=>({data:{signedUrl:'https://project.supabase.co/storage/v1/object/upload/sign/application-statements/'+path}}),download:async path=>files.has(path)?{data:new Blob([files.get(path)])}:{error:{}},createSignedUrl:async(path,expiry)=>{signs.push({path,expiry});return {data:{signedUrl:'https://project.supabase.co/private?token=short-lived'}};},remove:async paths=>{paths.forEach(path=>files.delete(path));return {data:[]};}})},
  rpc:async()=>{const row=db.loan_applications.find(row=>row.statement_review_state==='pending');if(!row)return {data:[]};row.statement_review_state='processing';row.statement_review_lease_id=randomUUID();return {data:[structuredClone(row)]};},
  from(table){let operation='select',values,filters=[],limit=Infinity;
   const run=()=>{let rows=db[table].filter(row=>filters.every(fn=>fn(row))).slice(0,limit);if(operation==='insert'){const incoming=Array.isArray(values)?values:[values];for(const value of incoming){if(table==='loan_applications'&&db[table].some(row=>row.web_submission_id===value.web_submission_id&&row.company_name===value.company_name))return {error:{code:'23505'}};}rows=incoming.map(value=>({id:randomUUID(),...structuredClone(value)}));db[table].push(...rows);}if(operation==='update')rows.forEach(row=>Object.assign(row,structuredClone(values)));if(operation==='delete')db[table]=db[table].filter(row=>!rows.includes(row));return {data:structuredClone(rows),error:null};};
   const builder={select(){return this;},insert(value){operation='insert';values=value;return this;},update(value){operation='update';values=value;return this;},delete(){operation='delete';return this;},eq(key,value){filters.push(row=>row[key]===value);return this;},is(key,value){filters.push(row=>(row[key]??null)===value);return this;},lt(key,value){filters.push(row=>row[key]<value);return this;},limit(value){limit=value;return this;},async maybeSingle(){const result=run();return {...result,data:result.data?.[0]||null};},async single(){return this.maybeSingle();},then(resolve,reject){return Promise.resolve(run()).then(resolve,reject);}};return builder;
  },
 }};
}
async function uploaded(receiver,store,route='visit'){
 const submissionId=randomUUID(),ticket=await receiver.uploads(config,{submissionId,route,consent:true,mime:'application/pdf'});
 store.files.set(store.db.application_statement_uploads[0].path,Buffer.from('%PDF-synthetic-test'));
 return {submissionId,route,statement:ticket,fields:{first_name:'Alex',surname:'Example',amount_requested:'£100',loan_term:'15'},formRows:[{label:'Your name',value:'Alex Example'}],quote:{amount:100},confirmations:{complete_application:true},...(route==='remote'?{lendingReference:'HCF000123'}:{})};
}
test('receiver authenticates tenant-specific private keys and keeps unfinished dashboard connection disabled',async()=>{
 const integrations={handycash:config};assert.throws(()=>authenticateIntegration({'x-application-company':'handycash',authorization:'Bearer wrong'},integrations),e=>e.status===401);
 assert.equal(authenticateIntegration({'x-application-company':'handycash',authorization:'Bearer '+config.token},integrations).id,'handycash');
 const store=memory(),receiver=createLeadsReceiver({supabase:store.client});await assert.rejects(()=>receiver.uploads(config,{}),e=>e.status===503);assert.equal(store.db.application_statement_uploads.length,0);
});
test('accepted applications are durable and idempotent, with tenant and upload-secret checks',async()=>{
 const store=memory(),receiver=createLeadsReceiver({supabase:store.client,dashboardReady:true});const request=await uploaded(receiver,store);
 const result=await receiver.applications(config,request);assert.equal(result.agentVisit,true);assert.equal(store.db.loan_applications.length,1);assert.equal(store.db.loan_applications[0].status,'New');assert.equal(store.db.loan_applications[0].review_mode,'staff-review-v1');assert.equal(store.db.loan_applications[0].lending_reference,null);
 assert.equal((await receiver.applications(config,request)).duplicate,true);assert.equal(store.db.loan_applications.length,1);
 await assert.rejects(()=>receiver.applications(config,{...request,fields:{...request.fields,first_name:'Changed'}}),e=>e.status===409);
 await assert.rejects(()=>receiver.applications(config,{...request,statement:{...request.statement,secret:'0'.repeat(64)}}),e=>e.status===422);
 await assert.rejects(()=>receiver.applications({...config,id:'other-company'},request),e=>e.status===422);
});
test('remote report preserves its lending reference and never calls a lending-system endpoint',async()=>{
 const store=memory(),receiver=createLeadsReceiver({supabase:store.client,dashboardReady:true});const request=await uploaded(receiver,store,'remote');await receiver.applications(config,request);assert.equal(store.db.loan_applications[0].lending_reference,'HCF000123');assert.equal(store.db.loan_applications[0].application_route,'remote');
});
test('expired uploads, oversized or disguised documents cannot create leads',async()=>{
 const store=memory(),receiver=createLeadsReceiver({supabase:store.client,dashboardReady:true});const request=await uploaded(receiver,store),ticket=store.db.application_statement_uploads[0];
 store.files.set(ticket.path,Buffer.from('<html>fake PDF</html>'));await assert.rejects(()=>receiver.applications(config,request),e=>e.status===422);
 store.files.set(ticket.path,Buffer.alloc(11*1024*1024));await assert.rejects(()=>receiver.applications(config,request),e=>e.status===413);
 ticket.expires_at='2000-01-01';await assert.rejects(()=>receiver.applications(config,request),e=>e.status===422);assert.equal(store.db.loan_applications.length,0);
});
test('private statements require a verified staff session and company/assignment authorization',async()=>{
 const store=memory(),receiver=createLeadsReceiver({supabase:store.client,dashboardReady:true});await receiver.applications(config,await uploaded(receiver,store));const lead=store.db.loan_applications[0];store.db.users.push({email:'staff@example.com',name:'Agent Example',role:'agent',company_name:config.companyName});
 await assert.rejects(()=>receiver.download('jwt',lead.id),e=>e.status===403);lead.assigned_agent='Agent Example';assert.ok((await receiver.download('jwt',lead.id)).url);assert.equal(store.signs[0].expiry,60);
 store.db.users[0].company_name='Different company';await assert.rejects(()=>receiver.download('jwt',lead.id),e=>e.status===403);store.setUser(null);await assert.rejects(()=>receiver.download('jwt',lead.id),e=>e.status===401);
});
test('review worker receives only the statement and produces staff-report facts; unreadable files stay with staff',async()=>{
 const store=memory();let calls=0;
 const facts={period_start:null,period_end:null,accounts:[],transactions:[],balances:[],issues:['Unreadable statement']};
 const receiver=createLeadsReceiver({supabase:store.client,integrations:{handycash:config},dashboardReady:true,extract:async input=>{calls++;assert.deepEqual(Object.keys(input).sort(),['apiKey','bytes','consent','mime']);return facts;}});
 await receiver.applications(config,await uploaded(receiver,store));await receiver.reviewNext();assert.equal(calls,1);assert.equal(store.db.loan_applications[0].statement_review_state,'complete');assert.match(store.db.loan_applications[0].ai_decision,/Unreadable statement/);assert.equal(store.db.loan_applications[0].status,'New');
 const failed=createLeadsReceiver({supabase:store.client,integrations:{handycash:config},dashboardReady:true,extract:async()=>{throw Error('private provider details');}});store.db.loan_applications[0].statement_review_state='pending';await failed.reviewNext();assert.equal(store.db.loan_applications[0].statement_review_state,'needs-check');assert.doesNotMatch(store.db.loan_applications[0].ai_decision,/private provider|PASSED|DECLINED/);assert.ok(store.files.size);
});
