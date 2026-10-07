const line = value => String(value ?? '').replace(/[\r\n]+/g,' ').trim();

export function hasUploadedBankStatement(lead = {}) {
  // A stored file is the evidence of an upload; selecting a document alone is not.
  if (line(lead.statement_path)) return true;
  if (lead.application_details?.statementDeferred === true) return false;
  return ['bank_statement_key','bank_statement_url','bank_statement_link'].some(key=>Boolean(line(lead[key])))
    || lead.bank_statement === true
    || (typeof lead.bank_statement === 'string' && /^https?:\/\//i.test(lead.bank_statement));
}

export function assignmentContactLines(lead) {
  return `Email: ${line(lead.email) || 'Not provided'}\nBank statement: ${hasUploadedBankStatement(lead) ? 'Yes' : 'No'}`;
}

export function buildAssignmentSms(lead,issueLink) {
  return `New lead assigned:

${line(lead.title)} ${line(lead.first_name)} ${line(lead.surname)}
Amount Requested: ${line(lead.amount_requested)} over ${line(lead.loan_term)} weeks
Address: ${line(lead.address)}
Town: ${line(lead.town)}
Postcode: ${line(lead.postcode)}
Best Time To Call: ${line(lead.best_call_time)}
Phone Number: ${line(lead.phone_number)}
${assignmentContactLines(lead)}

Mark as Issued: ${issueLink}`;
}
