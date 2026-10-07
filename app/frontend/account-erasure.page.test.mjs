import assert from 'node:assert/strict';
import test from 'node:test';
import {accountErasurePage,settingsPage} from './pages.mjs';

test('account deletion is a separate confirmation page with disclosure and no destructive GET',()=>{
  const user={user_id:'owner',display_name:'User',email:'mail@example.test'};
  assert.match(settingsPage(user,[]),/href="\/account\/delete">Удалить аккаунт/);
  const html=accountErasurePage(user,{csrf:'"<unsafe>',hasPassword:true});
  assert.match(html,/method="post" action="\/account\/delete"/);
  assert.match(html,/name="currentPassword"/);assert.match(html,/pattern="УДАЛИТЬ"/);
  assert.match(html,/защищённые отпечатки email и кабинетов маркетплейсов/);
  assert.match(html,/Резервные копии/);assert.match(html,/&quot;&lt;unsafe&gt;/);
  assert.doesNotMatch(accountErasurePage(user,{hasPassword:false}),/name="currentPassword"/);
});
