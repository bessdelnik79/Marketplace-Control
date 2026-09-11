import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSessionToken, hashPassword, hashToken, normalizeEmail, validateRegistration, verifyPassword } from './auth.mjs';
import { deleteSession, findPasswordUser, findSession, migrate, pool, registerUser, saveSession } from './db.mjs';
import { authPage, dashboardPage } from './views.mjs';

const port = Number(process.env.PORT ?? 3000);
const sessionDays = 30;
const attempts = new Map();
const dummyHash = await hashPassword('dummy-password-for-equal-work');

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((item) => item.trim().split('=')).filter(([key]) => key));
}
function send(response, status, body, headers = {}) { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); response.end(body); }
function redirect(response, location, cookie) { response.writeHead(303, { location, ...(cookie ? { 'set-cookie': cookie } : {}) }); response.end(); }
function sessionCookie(token, maxAge = sessionDays * 86400) { return `mc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
async function form(request) { const chunks=[]; for await (const chunk of request) { chunks.push(chunk); if (Buffer.concat(chunks).length > 16_384) throw new Error('too_large'); } return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())); }
function allowAttempt(key) { const now=Date.now(); const recent=(attempts.get(key) ?? []).filter((at)=>now-at<15*60_000); if(recent.length>=10) return false; recent.push(now); attempts.set(key,recent); return true; }
async function currentUser(request) { const token=cookies(request).mc_session; return token ? findSession(hashToken(token)) : null; }
async function establishSession(response, userId) { const {token,tokenHash}=createSessionToken(); await saveSession({userId,tokenHash,expiresAt:new Date(Date.now()+sessionDays*86400_000)}); redirect(response,'/',sessionCookie(token)); }

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
    if (request.method === 'GET' && ['/styles.css','/favicon.svg'].includes(url.pathname)) {
      const file = path.join(path.resolve('app/public'), url.pathname.slice(1));
      const type = url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/svg+xml';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' }); return response.end(await readFile(file));
    }
    const user = await currentUser(request);
    if (request.method === 'GET' && url.pathname === '/') return user ? send(response,200,dashboardPage(user)) : redirect(response,'/login');
    if (request.method === 'GET' && url.pathname === '/login') return user ? redirect(response,'/') : send(response,200,authPage({mode:'login'}));
    if (request.method === 'GET' && url.pathname === '/register') return user ? redirect(response,'/') : send(response,200,authPage({mode:'register'}));
    if (request.method === 'POST' && url.pathname === '/register') {
      const data=await form(request); const checked=validateRegistration(data);
      if (checked.error) return send(response,422,authPage({mode:'register',error:checked.error,values:data}));
      if (!allowAttempt(`register:${request.socket.remoteAddress}`)) return send(response,429,authPage({mode:'register',error:'Слишком много попыток. Повторите через 15 минут.',values:data}));
      try { const created=await registerUser({...checked.value,passwordHash:await hashPassword(checked.value.password)}); return establishSession(response,created.id); }
      catch(error) { if(error.code==='23505') return send(response,409,authPage({mode:'register',error:'Аккаунт с таким email уже существует.',values:data})); throw error; }
    }
    if (request.method === 'POST' && url.pathname === '/login') {
      const data=await form(request); const email=normalizeEmail(data.email); const key=`login:${request.socket.remoteAddress}:${email}`;
      if (!allowAttempt(key)) return send(response,429,authPage({mode:'login',error:'Слишком много попыток. Повторите через 15 минут.',values:{email}}));
      const found=await findPasswordUser(email); const valid=await verifyPassword(data.password,found?.password_hash ?? dummyHash);
      if(!found || !valid || found.status!=='active') return send(response,401,authPage({mode:'login',error:'Неверный email или пароль.',values:{email}}));
      return establishSession(response,found.id);
    }
    if (request.method === 'POST' && url.pathname === '/logout') { const token=cookies(request).mc_session; if(token) await deleteSession(hashToken(token)); return redirect(response,'/login',sessionCookie('',0)); }
    return send(response,404,'Страница не найдена');
  } catch (error) { console.error(error); return send(response,500,'Не удалось выполнить запрос. Попробуйте ещё раз.'); }
});

await migrate();
server.listen(port,'0.0.0.0',()=>console.log(`Marketplace Control: http://localhost:${port}`));
async function shutdown(){server.close();await pool.end();}
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
