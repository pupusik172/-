import {readFileSync} from 'node:fs';
import {createHmac, webcrypto} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let now='2026-10-31T14:00:00Z';
class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));}static now(){return new Date(now).getTime();} }
function bucket(){
 const records=new Map();let version=0;
 return {records,
  async put(key,body,options={}){const old=records.get(key),headers=new Headers(options.onlyIf||{});if(headers.get('if-none-match')==='*'&&old)return null;if(headers.has('if-match')&&headers.get('if-match')!==old?.httpEtag)return null;const row={body,httpMetadata:options.httpMetadata,httpEtag:`"${++version}"`};records.set(key,row);return row;},
  async get(key,options){const row=records.get(key);if(!row)return null;let bytes=Buffer.from(row.body);const size=bytes.length;if(options?.range)bytes=bytes.subarray(options.range.offset,options.range.offset+options.range.length);return {...row,size,body:new Blob([bytes]).stream(),json:async()=>JSON.parse(Buffer.from(row.body).toString())};},
  async delete(key){records.delete(key);},
  async list({prefix,cursor,limit=100}){const keys=[...records.keys()].filter(k=>k.startsWith(prefix)).sort(),offset=Number(cursor||0),next=offset+limit;return {objects:keys.slice(offset,next).map(key=>({key})),truncated:next<keys.length,cursor:String(next)};},
 };
}
const mediaBucket=bucket(),reminderBucket=bucket(),messages=[];
const mediaEnv={MEDIA:mediaBucket,BOT_TOKEN:'test-token',REMINDER_CHAT_ID:'1754545781',DEADLINE_SERVICE_KEY:'shared-test-key'};
const reminderEnv={REMINDERS:reminderBucket,BOT_TOKEN:'test-token',REMINDER_CHAT_ID:'1754545781',DEADLINE_SOURCE_URL:'https://media.test',DEADLINE_SERVICE_KEY:'shared-test-key'};
const common={Date:Clock,Intl,Map,Set,URL,URLSearchParams,Request,Response,Headers,Blob,TextEncoder,Uint8Array,crypto:webcrypto,AbortController,setTimeout,clearTimeout};
const mediaContext=vm.createContext({...common});
vm.runInContext(readFileSync(new URL('../media-server/worker/index.js',import.meta.url),'utf8').replace('export default {','const worker={')+';globalThis.worker=worker;',mediaContext);
let beforeFreshRead, redirectSource = false;
const reminderContext=vm.createContext({...common,fetch:async(url,options)=>{
 if(url.startsWith('https://media.test')){assert.equal(options.redirect,'manual');if(redirectSource)return new Response(null,{status:302,headers:{location:'https://other.test'}});if(beforeFreshRead&&new URL(url).searchParams.has('id'))await beforeFreshRead(url);return mediaContext.worker.fetch(new Request(url,options),mediaEnv);}
 const payload=JSON.parse(options.body);if(url.endsWith('/sendMessage'))messages.push(payload);return Response.json({ok:true,result:{message_id:messages.length||1,id:1754545781}});
}});
vm.runInContext(readFileSync(new URL('../reminders-server/worker/index.js',import.meta.url),'utf8').replace('export default {','const worker={')+';globalThis.worker=worker;',reminderContext);
function initData(userId=1754545781){const params=new URLSearchParams({auth_date:String(Math.floor(Clock.now()/1000)),user:JSON.stringify({id:userId,first_name:'Test'})});const check=[...params].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');const secret=createHmac('sha256','WebAppData').update(mediaEnv.BOT_TOKEN).digest();params.set('hash',createHmac('sha256',secret).update(check).digest('hex'));return params.toString();}
async function source(method,path,body,auth=initData()){return mediaContext.worker.fetch(new Request('https://media.test/v1/reminder-tasks'+path,{method,headers:{'content-type':'application/json',...(auth?{'X-Telegram-Init-Data':auth}:{})},...(body?{body:JSON.stringify(body)}:{})}),mediaEnv);}
async function run(body={},path='/reminders/deadlines'){const response=await reminderContext.worker.fetch(new Request('https://private.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),reminderEnv);const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
async function read(){return (await(await mediaContext.worker.fetch(new Request('https://media.test/v1/reminder-tasks',{headers:{'X-Reminder-Service-Key':mediaEnv.DEADLINE_SERVICE_KEY}}),mediaEnv)).json()).tasks;}
const tasks=[
 {id:1,title:'ПР–2',subject:'Информатика',dueDate:'2026-11-02',status:'todo',photos:['private-photo-must-not-be-copied']},
 {id:2,title:'Решить задачи',subject:'Математика',dueDate:'2026-11-01',status:'progress'},
 {id:3,title:'Уже готово',dueDate:'2026-11-02',status:'done'},
 {id:4,title:'Без срока',dueDate:'',status:'todo'},
 {id:5,title:'Удалённое',dueDate:'2026-11-02',status:'todo'},
];
assert.equal((await source('POST','',{tasks},'')).status,401);
assert.equal((await source('POST','',{tasks},initData(999))).status,401);
assert.equal((await mediaContext.worker.fetch(new Request('https://media.test/v1/reminder-tasks'),mediaEnv)).status,403);
assert.equal((await source('POST','',{tasks})).status,200);
assert.equal((await read())[0].photos,undefined);
console.log('PASS signed Telegram owner required; internal reads protected; photos excluded');
await source('DELETE','/5');await source('POST','',{tasks});assert.ok(!(await read()).some(t=>t.id==='5'));
assert.equal((await run({dry_run:true})).eligible,2);assert.equal(messages.length,0);
await Promise.all([run(),run()]);assert.equal(messages.length,2);assert.equal((await run()).sent,0);
assert.ok(messages.some(m=>m.text.startsWith('до сдачи Д/З осталось 2 дня\n\nИнформатика — ПР–2')));
assert.ok(messages.some(m=>m.text.startsWith('до сдачи Д/З остался 1 день\n\nМатематика')));
assert.ok(messages.every(m=>m.chat_id==='1754545781'));
console.log('PASS 2-day and 1-day reminders, done/undated/deleted exclusions and atomic duplicate protection');
now='2026-11-01T14:00:00Z';
await source('PATCH','/1',{changes:{status:'done'},seed:tasks[0]});
await source('POST','',{tasks});
await source('PATCH','/1',{changes:{title:'Новое название'},seed:tasks[0]});
assert.equal((await read()).find(t=>t.id==='1').status,'done');await run();assert.equal(messages.length,2);
console.log('PASS completion after first reminder cancels the second; stale bootstrap and title edits cannot undo done');
const later={id:6,title:'Конспект',subject:'История',dueDate:'2026-11-03',status:'todo'};
await source('POST','',{tasks:[later]});await run();assert.equal(messages.length,3);
now='2026-11-02T14:00:00Z';await run();assert.equal(messages.length,4);assert.ok(messages.at(-1).text.startsWith('до сдачи Д/З остался 1 день'));
console.log('PASS unfinished homework receives both reminder stages on successive Moscow days');
const race={id:7,title:'Быстро завершено',dueDate:'2026-11-04',status:'todo'};
await source('POST','',{tasks:[race]});
beforeFreshRead=async(url)=>{if(new URL(url).searchParams.get('id')==='7')await source('PATCH','/7',{changes:{status:'done'},seed:race});};
await run();assert.equal(messages.length,4);beforeFreshRead=null;
const oldAuth=initData();now='2026-11-04T14:00:00Z';assert.equal((await source('POST','',{tasks:[]},oldAuth)).status,401);
now='2026-11-04T21:30:00Z';assert.equal((await run()).status,'outside_delivery_window');
console.log('PASS status is rechecked immediately before sending; expired sessions rejected; no late-night messages');
await run({request_id:'unit-test-only'},'/reminders/deadlines/test');assert.equal(messages.length,5);
await run({request_id:'unit-test-only'},'/reminders/deadlines/test');assert.equal(messages.length,5);
assert.ok(messages.at(-1).text.startsWith('Проверка напоминаний'));
const mediaPut=await mediaContext.worker.fetch(new Request('https://media.test/v1/media/1754545781/10/0',{method:'PUT',headers:{'X-Telegram-User-Id':'1754545781','Content-Type':'image/png'},body:Buffer.from('original-bytes')}),mediaEnv);assert.equal(mediaPut.status,201);
const mediaGet=await mediaContext.worker.fetch(new Request('https://media.test/v1/media/1754545781/10/0'),mediaEnv);assert.equal(await mediaGet.text(),'original-bytes');
console.log('PASS explicit test message is idempotent; original media bytes remain untouched');
redirectSource = true;
const redirected = await reminderContext.worker.fetch(new Request('https://private.test/reminders/deadlines',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dry_run:true})}),reminderEnv);
assert.equal(redirected.status,502);assert.equal(messages.length,5);
console.log('PASS edge-compatible redirect handling rejects redirected metadata requests');
