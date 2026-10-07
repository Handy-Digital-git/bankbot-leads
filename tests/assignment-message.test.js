import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAssignmentSms,hasUploadedBankStatement,assignmentContactLines} from '../application-platform/assignment-message.js';

test('assignment texts include applicant email and actual uploaded statement status',()=>{
 const lead={first_name:'Alex',surname:'Example',email:'alex@example.com',statement_path:'handycash/submission/statement.pdf',phone_number:'07700900123',loan_term:'15',amount_requested:'£100'};
 const message=buildAssignmentSms(lead,'https://example.com/issued');
 assert.match(message,/Email: alex@example.com\nBank statement: Yes/);
 assert.match(message,/Phone Number: 07700900123/);
 assert.match(message,/Mark as Issued: https:\/\/example.com\/issued/);
 assert.ok(!message.includes('handycash/submission'));
});
test('agent statement deferral and document declarations without files report No',()=>{
 assert.equal(hasUploadedBankStatement({application_details:{statementDeferred:true},statement_path:null}),false);
 assert.equal(hasUploadedBankStatement({application_details:{rows:[{label:'Bank statement for the visit',value:'Latest main-account statement showing all transactions'}]}}),false);
 assert.equal(assignmentContactLines({email:''}),'Email: Not provided\nBank statement: No');
});
test('legacy uploaded statement fields are recognized and email stays on one line',()=>{
 for(const key of ['bank_statement_key','bank_statement_url','bank_statement_link']) assert.equal(hasUploadedBankStatement({[key]:'existing-file'}),true);
 assert.equal(hasUploadedBankStatement({bank_statement:true}),true);
 assert.equal(hasUploadedBankStatement({bank_statement:'https://example.com/private.pdf'}),true);
 assert.equal(hasUploadedBankStatement({bank_statement:false}),false);
 assert.equal(hasUploadedBankStatement({bank_statement:'No'}),false);
 assert.match(assignmentContactLines({email:'alex@example.com\nextra'}),/^Email: alex@example.com extra\nBank statement: No$/);
});
