function checked(result) {
  if (result.error) throw Error(result.error.message || 'Assignment settings are unavailable.');
  const value = result.data;
  if (!value || typeof value.assignRemoteApplications !== 'boolean' || typeof value.canManage !== 'boolean' || !value.companyName) {
    throw Error('Assignment settings are unavailable.');
  }
  return {enabled:value.assignRemoteApplications,canManage:value.canManage,companyName:value.companyName};
}

export function createAssignmentSettingsClient(supabase) {
  return {
    async load() { return checked(await supabase.rpc('get_lead_assignment_settings')); },
    async save(enabled) {
      if (typeof enabled !== 'boolean') throw Error('Choose on or off.');
      return checked(await supabase.rpc('set_remote_assignment',{enabled}));
    },
  };
}
