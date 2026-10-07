import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssignmentSettingsClient} from '../application-platform/assignment-settings-client.js';

test('settings load and save through authenticated RPCs without a caller-supplied company',async()=>{
 let enabled=false;
 const calls=[];
 const client=createAssignmentSettingsClient({rpc:async(name,args)=>{
  calls.push({name,args});
  if(name==='set_remote_assignment')enabled=args.enabled;
  return {data:{companyName:'Company',assignRemoteApplications:enabled,canManage:true}};
 }});
 assert.deepEqual(await client.load(),{companyName:'Company',enabled:false,canManage:true});
 assert.equal((await client.save(true)).enabled,true);
 assert.equal((await client.load()).enabled,true);
 assert.equal((await client.save(false)).enabled,false);
 assert.equal((await client.load()).enabled,false);
 assert.deepEqual(calls.map(call=>call.name),['get_lead_assignment_settings','set_remote_assignment','get_lead_assignment_settings','set_remote_assignment','get_lead_assignment_settings']);
 assert.deepEqual(calls[1].args,{enabled:true});
});

test('settings errors and malformed responses cannot silently enable assignment',async()=>{
 for(const response of [{error:{message:'Permission denied'}},{data:null},{data:{companyName:'Company',assignRemoteApplications:'true',canManage:true}},{data:{companyName:'Company',assignRemoteApplications:true}},{data:{companyName:'',assignRemoteApplications:true,canManage:true}}]){
  const client=createAssignmentSettingsClient({rpc:async()=>response});
  await assert.rejects(client.load());
  await assert.rejects(client.save(true));
 }
});

test('read-only staff receive the company value and invalid save values never reach storage',async()=>{
 let calls=0;
 const client=createAssignmentSettingsClient({rpc:async()=>{calls++;return {data:{companyName:'Company',assignRemoteApplications:true,canManage:false}};}});
 assert.deepEqual(await client.load(),{companyName:'Company',enabled:true,canManage:false});
 for(const value of [undefined,null,'true',1])await assert.rejects(client.save(value),/Choose on or off/);
 assert.equal(calls,1);
});
