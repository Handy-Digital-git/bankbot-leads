// Explicit application routes take precedence over older collection-method labels.
export function isRemoteLead(lead) {
  if (!lead || typeof lead !== 'object') return false;
  const route = String(lead.application_route || '').trim().toLowerCase();
  return route ? route === 'remote' : String(lead.method_collection || '').toLowerCase().includes('remote');
}

export function canAssignLead(lead, assignRemoteApplications = false) {
  if (!lead || typeof lead !== 'object') return false;
  const route = String(lead.application_route || '').trim().toLowerCase();
  if (route) return route === 'visit' || (route === 'remote' && assignRemoteApplications === true);
  const method = String(lead.method_collection || '').trim().toLowerCase();
  if (method.includes('remote')) return assignRemoteApplications === true;
  return method === 'agent visit' || method.includes('doorstep');
}

export function registerLeadAssignmentGuards(app, {supabase}) {
  for (const path of ['/assign-lead', '/assign-branch']) {
    app.use(path, async (req, res, next) => {
      if (req.method !== 'POST') return next();
      const id = path === '/assign-lead' ? req.body?.lead?.id : req.body?.leadId;
      if (!id) return res.status(400).json({success:false,error:'A lead ID is required.'});
      try {
        const {data:lead,error} = await supabase.from('loan_applications')
          .select('id,application_route,method_collection,company_name').eq('id',id).maybeSingle();
        if (error) return res.status(503).json({success:false,error:'Unable to check this application. Please try again.'});
        if (!lead) return res.status(404).json({success:false,error:'Application not found.'});
        let assignRemoteApplications = false;
        if (isRemoteLead(lead) && lead.company_name) {
          const settings = await supabase.from('lead_assignment_settings')
            .select('assign_remote_applications').eq('company_name',lead.company_name).maybeSingle();
          if (settings.error) return res.status(503).json({success:false,error:'Unable to check assignment settings. Please try again.'});
          assignRemoteApplications = settings.data?.assign_remote_applications === true;
        }
        if (!canAssignLead(lead,assignRemoteApplications)) return res.status(409).json({success:false,error:isRemoteLead(lead) ? 'Remote assignment is switched off in company settings.' : 'This application cannot be assigned.'});
        return next();
      } catch {
        return res.status(503).json({success:false,error:'Unable to check this application. Please try again.'});
      }
    });
  }
}
