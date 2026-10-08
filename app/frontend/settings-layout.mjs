export function settingsBack(esc, storeHref, storeId) {
  return `<a class="outline-button settings-back" href="${esc(storeHref('/settings', storeId))}">← Вернуться в личный кабинет</a>`;
}

export function settingsHeading(title, subtitle, actions = '') {
  return `<div class="settings-heading"><div><h1>${title}</h1><p class="page-lead">${subtitle}</p></div>${actions ? `<div class="settings-heading-actions">${actions}</div>` : ''}</div>`;
}

export function financialMetadata(financial) {
  const count=value=>value==null?'—':String(value);
  const checked=['complete_weeks','empty_weeks','absent_weeks'].some(key=>financial[key]!=null)
    ? ['complete_weeks','empty_weeks','absent_weeks'].reduce((sum,key)=>sum+Number(financial[key]??0),0) : null;
  const date=value=>{if(!value)return '—';const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'—':parsed.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});};
  const coverage=String(financial.coverage_to??'').match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return {
    checked:`${count(checked)} из ${count(financial.total_weeks)}`,
    complete:count(financial.complete_weeks),empty:count(financial.empty_weeks),absent:count(financial.absent_weeks),
    reports:count(financial.report_count),issues:count(financial.issue_count),
    coverage:coverage?new Date(`${coverage}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}):financial.coverage_to instanceof Date?financial.coverage_to.toLocaleDateString('ru-RU'):'—',
    updated:date(financial.last_success_at)
  };
}
