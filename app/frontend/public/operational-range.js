export async function loadOperationalRange({storeId,start,end,fetchImpl=fetch,timeoutMs=15000}){
  const params=new URLSearchParams({storeId,operationalStart:start,operationalEnd:end});
  const response=await fetchImpl(`/overview/operational?${params}`,{
    headers:{accept:'text/html'},credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(timeoutMs)
  });
  if(!response.ok||response.redirected)throw new Error('operational_range_unavailable');
  return response.text();
}

export async function refreshOperationalRange({storeId,start,end,fetchImpl=fetch,timeoutMs=15000}){
  const response=await fetchImpl('/overview/operational-refresh',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({storeId,operationalStart:start,operationalEnd:end}),
    credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(timeoutMs)
  });
  if(response.status===403)return {queued:0,status:'read_only'};
  if(!response.ok||response.redirected)throw new Error('operational_refresh_unavailable');
  return response.json();
}
