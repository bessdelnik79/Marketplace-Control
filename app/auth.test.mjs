import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, hashPassword, hashToken, normalizeEmail, validateRegistration, verifyPassword } from './auth.mjs';

test('registration data is normalized and validated', () => {
  const result=validateRegistration({name:'  Анна   Смирнова  ',email:' ANNA@Example.COM ',password:'очень-надёжный-пароль'});
  assert.deepEqual(result.value,{name:'Анна Смирнова',email:'anna@example.com',password:'очень-надёжный-пароль'});
  assert.equal(normalizeEmail(' TEST@MAIL.RU '),'test@mail.ru');
});
test('weak registration data is rejected', () => {
  assert.match(validateRegistration({name:'А',email:'bad',password:'123'}).error,/имя/i);
  assert.match(validateRegistration({name:'Анна',email:'bad',password:'1234567890'}).error,/email/i);
  assert.match(validateRegistration({name:'Анна',email:'a@b.ru',password:'123'}).error,/пароль/i);
});
test('password hash verifies only the original password', async () => {
  const hash=await hashPassword('длинный секрет 2026');
  assert.equal(await verifyPassword('длинный секрет 2026',hash),true);
  assert.equal(await verifyPassword('другой секрет',hash),false);
  assert.equal(hash.includes('длинный секрет'),false);
});
test('session tokens are random and stored as hashes', () => {
  const first=createSessionToken(), second=createSessionToken();
  assert.notEqual(first.token,second.token); assert.equal(first.tokenHash,hashToken(first.token)); assert.equal(first.tokenHash.length,64);
});
