export function createBillingRoutes({requestTariff,listStores,getBillingSummary,tariffPage,sameOrigin,form,send,redirect}){
  return async(req,res,url,current)=>{
    if(req.method!=='POST'||url.pathname!=='/tariff/select')return false;
    if(!current){redirect(res,'/login');return true;}
    if(!sameOrigin(req)){send(res,403,'Запрос отклонён.');return true;}
    const data=await form(req),stores=await listStores(current.user_id);
    let status=200,options;
    try{await requestTariff(current.user_id,data.plan);options={notice:'Выбор тарифа сохранён. Оплата пока не подключена; действующий доступ не изменён.'};}
    catch(error){
      if(!['tariff_choice_invalid','tariff_write_forbidden'].includes(error.message))throw error;
      status=error.message==='tariff_write_forbidden'?403:422;
      options={error:status===403?'Недостаточно прав для выбора тарифа.':'Выберите платный тариф. Бесплатный доступ восстанавливается после окончания оплаченного периода.'};
    }
    send(res,status,tariffPage(current,stores,await getBillingSummary(current.user_id),options));return true;
  };
}
