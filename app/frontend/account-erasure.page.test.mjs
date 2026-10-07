import assert from 'node:assert/strict';
import test from 'node:test';
import {accountErasurePage,settingsPage} from './pages.mjs';

test('account deletion preserves store navigation and explicit irreversible confirmation',()=>{
  const user={user_id:'owner',display_name:'User',email:'mail@example.test'};
  assert.match(settingsPage(user,[]),/href="\/account\/delete">Удалить аккаунт/);
  const html=accountErasurePage(user,{csrf:'"<unsafe>',hasPassword:true,stores:[{id:'owned-store',name:'Existing store'}]});
  assert.match(html,/method="post" action="\/account\/delete"/);
  assert.match(html,/name="currentPassword"/);assert.match(html,/pattern="УДАЛИТЬ"/);
  assert.match(html,/Existing store/);assert.doesNotMatch(html,/Магазинов пока нет/);
  assert.match(html,/Действие необратимо/);assert.match(html,/Все сеансы завершатся/);
  assert.doesNotMatch(html,/Очистка файлов исходников|Для защиты акций|Резервные копии/);assert.match(html,/&quot;&lt;unsafe&gt;/);
  assert.doesNotMatch(accountErasurePage(user,{hasPassword:false}),/name="currentPassword"/);
});
