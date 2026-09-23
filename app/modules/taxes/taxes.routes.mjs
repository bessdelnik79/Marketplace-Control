export function createTaxesRoutes({ listStores, send, redirect, sendTaxes, sameOrigin, takeLimit, form, saveTaxSetting, scheduleFinancialCalculation, voidTaxSetting }) {
 async function dispatch(req,res,url,current){
 if(req.method==='POST'&&url.pathname==='/taxes'){
  if(!current)return redirect(res,'/login');if(!sameOrigin(req))return send(res,403,'Запрос отклонён.');const stores=await listStores(current.user_id),limit=await takeLimit(`tax-write:${current.user_id}`,20,15);
  if(!limit.allowed)return sendTaxes(res,429,current,stores,{error:'Слишком много изменений. Повторите через 15 минут.'});
  try{const d=await form(req);await saveTaxSetting(current.user_id,{effectiveFrom:d.effectiveFrom,regimeCode:d.regimeCode,usnRatePercent:d.usnRatePercent,vatMode:d.vatMode,comment:d.comment});for(const store of stores)scheduleFinancialCalculation(current.user_id,store.id);return redirect(res,'/taxes?saved=1');}
  catch(error){const messages={tax_write_forbidden:'Недостаточно прав для изменения налоговых настроек.',tax_date_invalid:'Проверьте дату начала действия.',tax_regime_invalid:'Выберите налоговый режим.',tax_method_unsupported:'Расчёт выбранного режима пока не поддерживается.',tax_rate_invalid:'Введите ставку от 0 до 100%.',tax_vat_invalid:'Выберите вариант НДС.',tax_comment_invalid:'Сократите комментарий.'};return sendTaxes(res,error.message==='tax_write_forbidden'?403:422,current,stores,{error:messages[error.message]??'Не удалось сохранить налоговую настройку.'});}
 }
 if(req.method==='POST'&&url.pathname==='/taxes/void'){
  if(!current)return redirect(res,'/login');if(!sameOrigin(req))return send(res,403,'Запрос отклонён.');const stores=await listStores(current.user_id);
  try{const d=await form(req);await voidTaxSetting(current.user_id,{settingId:d.settingId});for(const store of stores)scheduleFinancialCalculation(current.user_id,store.id);return redirect(res,'/taxes?voided=1');}
  catch(error){return sendTaxes(res,error.message==='tax_write_forbidden'?403:error.message==='tax_setting_not_found'?404:422,current,stores,{error:error.message==='tax_write_forbidden'?'Недостаточно прав для изменения налоговых настроек.':error.message==='tax_setting_not_found'?'Настройка не найдена.':'Не удалось аннулировать настройку.'});}
 }
 }
 return async function handleTaxes(req,res,url,current){
  if(req.method!=='POST'||!['/taxes','/taxes/void'].includes(url.pathname))return false;
  await dispatch(req,res,url,current);
  return true;
 };
}
