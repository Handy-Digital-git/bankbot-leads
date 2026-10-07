// Explicit application routes take precedence over older collection-method labels.
export function canAssignLead(lead) {
  if (!lead || typeof lead !== 'object') return false;
  const route = String(lead.application_route || '').trim().toLowerCase();
  if (route) return route === 'visit';
  const method = String(lead.method_collection || '').trim().toLowerCase();
  return !method.includes('remote') && (method === 'agent visit' || method.includes('doorstep'));
}

export function registerLeadAssignmentGuards(app, {supabase}) {
  for (const path of ['/assign-lead', '/assign-branch']) {
    app.use(path, async (req, res, next) => {
      if (req.method !== 'POST') return next();
      const id = path === '/assign-lead' ? req.body?.lead?.id : req.body?.leadId;
      if (!id) return res.status(400).json({success:false,error:'A lead ID is required.'});
      try {
        const {data:lead,error} = await supabase.from('loan_applications')
          .select('id,application_route,method_collection').eq('id',id).maybeSingle();
        if (error) return res.status(503).json({success:false,error:'Unable to check this application. Please try again.'});
        if (!lead) return res.status(404).json({success:false,error:'Application not found.'});
        if (!canAssignLead(lead)) return res.status(409).json({success:false,error:'Only agent visit applications can be assigned.'});
        return next();
      } catch {
        return res.status(503).json({success:false,error:'Unable to check this application. Please try again.'});
      }
    });
  }
}
