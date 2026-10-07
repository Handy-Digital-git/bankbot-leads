import test from 'node:test';
import assert from 'node:assert/strict';
import {canAssignLead,registerLeadAssignmentGuards} from '../application-platform/assignment-policy.js';

test('only agent visits and legacy doorstep applications allow assignment',()=>{
 for(const lead of [{application_route:'visit'},{application_route:' VISIT '},{method_collection:'Agent visit'},{method_collection:'Doorstep Collections'}]) assert.equal(canAssignLead(lead),true);
 for(const lead of [null,{}, {application_route:'remote'}, {application_route:'remote',method_collection:'Agent visit'}, {method_collection:'Remote bank transfer'}, {method_collection:'Remote Doorstep'}, {application_route:'unknown',method_collection:'Doorstep Collections'}, {method_collection:'Other'}]) assert.equal(canAssignLead(lead),false);
});

function setup(result) {
 const routes=new Map(),reads=[];
 registerLeadAssignmentGuards({use:(path,handler)=>routes.set(path,handler)},{supabase:{from:table=>({select:fields=>({eq:(key,id)=>({maybeSingle:async()=>{reads.push({table,fields,key,id});return result;}})})})}});
 const response={code:200,body:null,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 let calls=0;
 return {reads,response,run:async(path,body,method='POST')=>{await routes.get(path)({body,method},response,()=>{calls++;});return calls;}};
}

test('remote applications cannot be assigned even when the caller claims they are agent visits',async()=>{
 for(const path of ['/assign-lead','/assign-branch']) {
  const check=setup({data:{id:'remote-id',application_route:'remote',method_collection:'Remote bank transfer'}});
  const calls=await check.run(path,{lead:{id:'remote-id',application_route:'visit',method_collection:'Agent visit'},agentId:'agent-id',leadId:'remote-id',branchId:'branch-id'});
  assert.equal(calls,0);assert.equal(check.response.code,409);assert.match(check.response.body.error,/Only agent visit/);
  assert.deepEqual(check.reads[0],{table:'loan_applications',fields:'id,application_route,method_collection',key:'id',id:'remote-id'});
 }
});

test('stored visit routes proceed to existing assignment and notification handlers',async()=>{
 for(const path of ['/assign-lead','/assign-branch']) {
  const check=setup({data:{id:'visit-id',application_route:'visit'}});
  assert.equal(await check.run(path,{lead:{id:'visit-id'},leadId:'visit-id'}),1);
  assert.equal(check.response.body,null);
 }
});

test('missing records or unavailable storage cannot start assignment',async()=>{
 for(const [result,status] of [[{data:null},404],[{error:{message:'private database failure'}},503]]) {
  const check=setup(result);
  assert.equal(await check.run('/assign-lead',{lead:{id:'id'}}),0);
  assert.equal(check.response.code,status);assert.ok(!check.response.body.error.includes('private database failure'));
 }
 const check=setup({data:null});
 assert.equal(await check.run('/assign-lead',{}),0);assert.equal(check.response.code,400);assert.equal(check.reads.length,0);
});
