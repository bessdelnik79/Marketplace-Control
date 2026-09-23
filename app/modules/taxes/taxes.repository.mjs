import { withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { uuidPattern, exactDate, cleanText } from '../../infrastructure/database/input-validation.mjs';

const taxRegimes=new Set(['usn_income','usn_income_expenses','osno']);
const vatModes=new Set(['unmodeled','exempt','general','special']);
const percentRate=value=>{
  const text=String(value??'').trim().replace(',','.');
  return /^(?:100(?:\.0{1,6})?|(?:0|[1-9]\d?)(?:\.\d{1,6})?)$/.test(text)?text:null;
};

export async function getTaxState(userId,{asOf=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date())}={}){
  const date=exactDate(asOf);if(!date)throw new Error('tax_date_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const current=(await client.query(
      `select s.id as setting_id,s.effective_from,v.id as version_id,v.version_no,v.regime_code,v.usn_rate_fraction::text,v.vat_mode,v.state,v.comment,v.created_at
         from mc.tax_settings s join mc.tax_setting_versions v on (v.business_id,v.tax_setting_id,v.id)=(s.business_id,s.id,s.current_version_id)
        where s.business_id=$1 and s.effective_from<=$2 order by s.effective_from desc limit 1`,[businessId,date]
    )).rows[0]??null;
    const history=(await client.query(
      `select s.id as setting_id,s.effective_from,v.id as version_id,v.version_no,v.regime_code,v.usn_rate_fraction::text,v.vat_mode,v.state,v.comment,v.created_at
         from mc.tax_settings s join mc.tax_setting_versions v on (v.business_id,v.tax_setting_id)=(s.business_id,s.id)
        where s.business_id=$1 order by s.effective_from desc,v.version_no desc`,[businessId]
    )).rows;
    return{current,history,asOf:date};
  });
}

export async function saveTaxSetting(userId,{effectiveFrom,regimeCode='usn_income',usnRatePercent,vatMode,comment}){
  const date=exactDate(effectiveFrom),regime=String(regimeCode??'').trim(),vat=String(vatMode??'').trim(),rate=percentRate(usnRatePercent),note=cleanText(comment,500);
  if(!date)throw new Error('tax_date_invalid');if(!taxRegimes.has(regime))throw new Error('tax_regime_invalid');if(!vatModes.has(vat)||vat==='unmodeled')throw new Error('tax_vat_invalid');
  if(regime!=='usn_income')throw new Error('tax_method_unsupported');if(!rate)throw new Error('tax_rate_invalid');if(note===null)throw new Error('tax_comment_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('tax_write_forbidden');
    let setting=(await client.query(`insert into mc.tax_settings(business_id,effective_from) values($1,$2) on conflict(business_id,effective_from) do nothing returning id,current_version_id`,[businessId,date])).rows[0];
    if(!setting)setting=(await client.query(`select id,current_version_id from mc.tax_settings where business_id=$1 and effective_from=$2 for update`,[businessId,date])).rows[0];
    else setting=(await client.query(`select id,current_version_id from mc.tax_settings where id=$1 for update`,[setting.id])).rows[0];
    const current=setting.current_version_id?(await client.query(`select regime_code,usn_rate_fraction::text,vat_mode,state,comment from mc.tax_setting_versions where id=$1`,[setting.current_version_id])).rows[0]:null;
    const sameRate=current?(await client.query(`select $1::numeric=($2::numeric/100) as matches`,[current.usn_rate_fraction,rate])).rows[0].matches:false;
    if(current&&current.regime_code===regime&&sameRate&&current.vat_mode===vat&&current.state==='active'&&(current.comment??'')===(note??''))return{settingId:setting.id,versionId:setting.current_version_id,changed:false};
    const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.tax_setting_versions where tax_setting_id=$1`,[setting.id])).rows[0].n;
    const version=(await client.query(
      `insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,state,changed_by,comment)
       values($1,$2,$3,$4,$5::numeric/100,$6,'active',$7,$8) returning id`,
      [businessId,setting.id,versionNo,regime,rate,vat,userId,note||null]
    )).rows[0];await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[version.id,setting.id]);return{settingId:setting.id,versionId:version.id,changed:true};
  });
}

export async function voidTaxSetting(userId,{settingId}){
  if(!uuidPattern.test(String(settingId??'')))throw new Error('tax_setting_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('tax_write_forbidden');
    const row=(await client.query(
      `select s.id,s.current_version_id,v.* from mc.tax_settings s join mc.tax_setting_versions v on v.id=s.current_version_id
        where s.business_id=$1 and s.id=$2 for update of s`,[businessId,settingId]
    )).rows[0];if(!row)throw new Error('tax_setting_not_found');if(row.state==='voided')return{settingId,versionId:row.current_version_id,changed:false};
    const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.tax_setting_versions where tax_setting_id=$1`,[settingId])).rows[0].n;
    const version=(await client.query(
      `insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,state,currency,changed_by,comment)
       values($1,$2,$3,$4,$5,$6,'voided',$7,$8,$9) returning id`,
      [businessId,settingId,versionNo,row.regime_code,row.usn_rate_fraction,row.vat_mode,row.currency,userId,row.comment]
    )).rows[0];await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[version.id,settingId]);return{settingId,versionId:version.id,changed:true};
  });
}
