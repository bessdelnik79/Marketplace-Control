import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{business:{type:'string'},plan:{type:'string'},event:{type:'string'},'confirmed-at':{type:'string'}},strict:true});
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required for administrative issuance');
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.business??'')||
  !['minimum','plus','pro'].includes(values.plan)||!values.event?.trim()||values.event.length>200)throw new Error('Use --business UUID --plan minimum|plus|pro --event UNIQUE_KEY [--confirmed-at ISO_TIMESTAMP]');
const {pool}=await import('../app/infrastructure/database/client.mjs');
const client=await pool.connect();
try{
  await client.query('begin');
  await client.query("select set_config('app.business_id',$1,true)",[values.business]);
  const existing=(await client.query('select confirmed_at::text from mc.tariff_lifecycle_events where event_key=$1',[values.event])).rows[0];
  const at=values['confirmed-at']??existing?.confirmed_at??new Date().toISOString();
  if(Number.isNaN(new Date(at).getTime()))throw new Error('Invalid confirmation timestamp');
  const result=(await client.query('select mc.apply_tariff_period($1,$2,$3,$4) as period_end',[values.business,values.plan,values.event,at])).rows[0];
  await client.query('commit');
  console.log(JSON.stringify({plan:values.plan,periodEnd:result.period_end}));
}catch(error){await client.query('rollback');throw error;}finally{client.release();await pool.end();}
