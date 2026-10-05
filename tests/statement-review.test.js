import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatementExtractor, createStatementReport, validateStatementExtraction, validateStatementFile, statementExtractionSchema } from '../application-platform/statement-review.js';
const tx = (category, out, incoming=0, source='p1-r1') => ({ account_id:'main',date:'2026-10-02',description:'Observed merchant',money_out_pence:out,money_in_pence:incoming,category,classification_certain:true,provider:null,source_page:1,source_reference:source,evidence:'Statement row' });
const balance = (amount, source='p1-b1') => ({account_id:'main',date:'2026-10-02',balance_pence:amount,source_page:1,source_reference:source,evidence:'Balance column'});
const facts = () => ({period_start:'2026-10-01',period_end:'2026-10-31',accounts:[{id:'main',kind:'main',currency:'GBP'}],transactions:[],balances:[],issues:[]});
test('report records factual spending without using balances or incoming gambling funds as money out',()=>{
  const data=facts();data.transactions=[tx('gambling',12000,0,'p1-r1'),tx('gambling',10000,0,'p1-r2'),tx('gambling',0,9000,'p1-r3'),tx('bnpl',4800,0,'p1-r4'),tx('credit_repayment',6000,0,'p1-r5')];data.balances=[balance(-12500)];
  const result=createStatementReport(data);
  assert.equal(result.reviewMode,'staff-review-v1');assert.equal(result.status,'Awaiting staff review');
  assert.match(result.report,/Total identified money out: £220\.00/);assert.match(result.report,/-£125\.00/);
  assert.match(result.report,/£48\.00/);assert.match(result.report,/£60\.00/);
  assert.doesNotMatch(result.report,/PASSED|DECLINED|Likelihood|\d+%/);
});
test('savings pots, foreign currencies and unknown accounts never contribute to report balances or spending',()=>{
  const data=facts();data.accounts.push({id:'pot',kind:'savings_pot',currency:'GBP'},{id:'unknown',kind:'unknown',currency:'GBP'},{id:'foreign',kind:'main',currency:'EUR'});
  for(const id of ['pot','unknown','foreign']){data.transactions.push({...tx('gambling',99900,0,id),account_id:id});data.balances.push({...balance(-99900,id),account_id:id});}
  data.transactions.push(tx('gambling',2000));data.balances.push(balance(3000));
  const {report}=createStatementReport(data);assert.match(report,/£20\.00/);assert.match(report,/£30\.00/);assert.doesNotMatch(report,/£999\.00/);assert.match(report,/excluded/);
});
test('unreadable and balance-only documents produce review issues rather than a pass',()=>{
  const data=facts();data.balances=[balance(8000)];data.issues=['Only summary page readable.'];
  const {report}=createStatementReport(data);assert.match(report,/No main-account transaction history extracted/);assert.match(report,/Only summary page readable/);assert.match(report,/Awaiting staff review/);
  data.transactions=[tx('gambling',null,null)];assert.match(createStatementReport(data).report,/uncertain classifications, dates or amounts/);
});
test('uncertain merchant classifications are not silently counted as gambling or loan spending',()=>{
  const data=facts();data.transactions=[{...tx('gambling',55000),classification_certain:false}];
  const {report}=createStatementReport(data);assert.doesNotMatch(report,/Total identified money out/);assert.match(report,/check the original statement/);
});
test('duplicate extraction locations are rejected while identical separate transactions remain distinct',()=>{
  const data=facts();data.transactions=[tx('gambling',5000),tx('gambling',5000)];assert.throws(()=>validateStatementExtraction(data),e=>e.status===502);
  data.transactions[1].source_reference='p1-r2';assert.match(createStatementReport(data).report,/Total identified money out: £100\.00/);
});
test('invalid dates, money, contradictory directions, missing evidence and unknown accounts require review',()=>{
  for(const patch of [{date:'2026-02-30'},{date:'2026-99-99'},{money_out_pence:1.5},{money_out_pence:-10},{money_in_pence:100},{account_id:'missing'},{evidence:''}]){
    const data=facts();data.transactions=[{...tx('other',2000),...patch}];assert.throws(()=>validateStatementExtraction(data),e=>e.status===502);
  }
});
test('cash-flow section reports observed income weekdays and dated balance ranges without predicting success',()=>{
  const data=facts();data.transactions=[tx('income',0,40000)];data.balances=[balance(30000),{...balance(12000,'p1-b2'),date:'2026-10-03'}];
  const {report}=createStatementReport(data);assert.match(report,/2026-10-02 \(Friday\): £400\.00/);assert.match(report,/2026-09-28: £120\.00 to £300\.00/);assert.doesNotMatch(report,/best day|likelihood|reliably/i);
});
test('source text cannot inject Markdown headings, links or HTML into the staff report',()=>{
  const data=facts();data.transactions=[{...tx('bnpl',1000),description:'<script> **PASSED**\n# Heading [link](https://bad.example)'}];
  const {report}=createStatementReport(data);assert.ok(!report.includes('<script>'));assert.ok(!report.includes('\n# Heading'));assert.ok(!report.includes('[link]'));assert.ok(!report.includes('**PASSED**'));
});
test('file size and signatures are checked and permission/configuration are required before provider calls',async()=>{
  let calls=0;const extract=createStatementExtractor({fetchImpl:async()=>{calls++;throw Error('unexpected');}});
  const file={bytes:Buffer.from('%PDF-fixture'),mime:'application/pdf',apiKey:'test-key'};
  assert.throws(()=>validateStatementFile(Buffer.from('<html>'),'application/pdf'),e=>e.status===422);
  assert.throws(()=>validateStatementFile(Buffer.alloc(10*1024*1024+1),'application/pdf'),e=>e.status===422);
  await assert.rejects(()=>extract(file),e=>e.status===422);await assert.rejects(()=>extract({...file,consent:true,apiKey:''}),e=>e.status===503);assert.equal(calls,0);
});
test('provider request uses a private structured factual extraction and rejects incomplete/refused/error responses',async()=>{
  let request;const data=facts();data.transactions=[tx('other',1000)];
  const extract=createStatementExtractor({fetchImpl:async(url,options)=>{request={url,options};return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]});}});
  const file={bytes:Buffer.from('%PDF-fixture'),mime:'application/pdf',apiKey:'private-test-key',consent:true};
  assert.deepEqual(await extract(file),data);const body=JSON.parse(request.options.body);
  assert.equal(body.store,false);assert.equal(body.model,'gpt-5-mini');assert.equal(body.text.format.strict,true);assert.deepEqual(body.text.format.schema,statementExtractionSchema);assert.equal(body.input[0].content[1].type,'input_file');assert.match(body.instructions,/untrusted/);
  for(const result of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not JSON'}]}]}]){
    const bad=createStatementExtractor({fetchImpl:async()=>Response.json(result)});await assert.rejects(()=>bad(file),e=>e.status===502);
  }
  const failed=createStatementExtractor({fetchImpl:async()=>new Response('Secret provider error private-test-key',{status:500})});await assert.rejects(()=>failed(file),e=>e.status===502&&!e.message.includes('private-test-key'));
});
