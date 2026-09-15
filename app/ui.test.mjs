import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewPage,settingsPage,placeholderPage,uiRoutes} from './ui.mjs';
const user={id:'test-user',display_name:'<script>alert(1)</script>',email:'" autofocus onfocus="alert(1)'};
test('settings escapes account data in HTML attributes and text',()=>{const html=settingsPage(user);assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&quot; autofocus'));assert.ok(!html.includes('value="" autofocus'));});
test('every screen link resolves to a supported authenticated route or anchor',()=>{for(const html of [overviewPage(user),settingsPage(user),...Array.from(uiRoutes.keys(),route=>placeholderPage(user,route))]){for(const [,href] of html.matchAll(/href="([^"#]+)"/g)){const p=new URL(href,'http://localhost').pathname;assert.ok(uiRoutes.has(p)||['/favicon.svg','/ui.css'].includes(p),`Unsupported link ${href}`)}}});
test('overview labels illustrative data and keeps independent date controls',()=>{const html=overviewPage(user);assert.match(html,/Демонстрационные данные/);assert.match(html,/data-calendar="profit"/);assert.match(html,/data-calendar="current"/);assert.equal((html.match(/class="bar current"/g)||[]).length,6);assert.equal((html.match(/class="bar average"/g)||[]).length,6);});
