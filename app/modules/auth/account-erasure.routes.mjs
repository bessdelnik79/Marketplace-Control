import {timingSafeEqual} from 'node:crypto';
import {hashToken} from './auth.mjs';

export function accountErasureCsrf(sessionToken) {
  return sessionToken ? hashToken(`marketplace-control:account-erasure:v1:${sessionToken}`) : '';
}

function validCsrf(value, expected) {
  const supplied=Buffer.from(typeof value==='string'?value:''), wanted=Buffer.from(expected);
  return wanted.length>0&&supplied.length===wanted.length&&timingSafeEqual(supplied,wanted);
}

export function createAccountErasureRoutes({getSessionToken,getPasswordCredential,verifyPassword,
  requestAccountErasure,takeLimit,form,sameOrigin,send,redirect,cookie,accountErasurePage}) {
  return async(req,res,url,current)=>{
    if(url.pathname!=='/account/delete'||!['GET','POST'].includes(req.method))return false;
    if(!current){redirect(res,'/login');return true;}
    const token=getSessionToken(req), csrf=accountErasureCsrf(token);
    const credential=await getPasswordCredential(current.user_id);
    const render=(status,error='')=>send(res,status,accountErasurePage(current,{csrf,hasPassword:Boolean(credential),error}),{'cache-control':'no-store'});
    if(req.method==='GET'){render(200);return true;}
    if(!sameOrigin(req)){send(res,403,'Запрос отклонён.');return true;}
    const data=await form(req);
    if(!validCsrf(data.csrf,csrf)){send(res,403,'Запрос отклонён. Обновите страницу подтверждения.');return true;}
    const limit=await takeLimit(`account-erasure:${current.user_id}`,5,15);
    if(!limit.allowed){render(429,'Слишком много попыток. Повторите через 15 минут.');return true;}
    if(data.confirmation!=='УДАЛИТЬ'){render(422,'Введите УДАЛИТЬ для подтверждения.');return true;}
    if(credential&&!await verifyPassword(String(data.currentPassword??''),credential.password_hash)){
      render(422,'Неверный текущий пароль.');return true;
    }
    try{
      await requestAccountErasure(current.user_id,{sessionTokenHash:hashToken(token),expectedPasswordHash:credential?.password_hash??null});
    }catch(error){
      const messages={
        account_erasure_reauthentication_required:'Войдите в аккаунт заново и подтвердите удаление в течение 10 минут.',
        account_erasure_credential_changed:'Пароль или сеанс изменился. Войдите заново и повторите удаление.',
        account_erasure_shared_business:'Аккаунт связан с совместным бизнесом. Сначала необходимо урегулировать доступ других участников.',
        account_erasure_forbidden:'Недостаточно прав для удаления аккаунта.',
        account_erasure_not_found:'Аккаунт или сеанс уже недоступен. Войдите заново.'
      };
      if(!messages[error.message])throw error;
      render(error.message==='account_erasure_forbidden'?403:409,messages[error.message]);return true;
    }
    redirect(res,'/login?account=deleted',cookie('',0));return true;
  };
}
