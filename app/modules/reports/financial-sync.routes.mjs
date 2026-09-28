export function createFinancialSyncRoutes({listStores,getFinancialSyncState,financialSyncView,send}){
  return async function handleFinancialSync(req,res,url,current){
    if(req.method!=='GET'||url.pathname!=='/financial-reports/status')return false;
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
    if(!current){send(res,401,JSON.stringify({error:'auth_required'}),headers);return true;}
    const stores=await listStores(current.user_id),store=stores.find(item=>item.id===url.searchParams.get('storeId'));
    if(!store){send(res,404,JSON.stringify({error:'store_not_found'}),headers);return true;}
    const state=await getFinancialSyncState(current.user_id,store.id);
    send(res,200,JSON.stringify(financialSyncView(state,store)),headers);
    return true;
  };
}
