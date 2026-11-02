import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=readFileSync(new URL('../reminders-server/worker/index.js',import.meta.url),'utf8');
let now='2026-10-31T13:59:00Z';
class TestDate extends Date { constructor(...args){super(...(args.length?args:[now]));}static now(){return new Date(now).getTime();} }
const records=new Map(),calls=[];
const env={BOT_TOKEN:'test-token',REMINDER_CHAT_ID:'1754545781',REMINDERS:{
  async get(key){return records.has(key)?{body:records.get(key)}:null;},
  async put(key,value){records.set(key,value);},
}};
const context=vm.createContext({Date:TestDate,Intl,Map,URL,Request,Response,AbortController,setTimeout,clearTimeout,
  fetch:async(url,options)=>{calls.push({method:url.split('/').at(-1),payload:JSON.parse(options.body)});return Response.json({ok:true,result:{id:1754545781,message_id:123}});},
});
vm.runInContext(source.replace('export default {','const worker = {')+';globalThis.worker=worker;',context);
async function invoke(args={}){
  const req=new Request('https://private-reminder.test/reminders/homework',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});
  const response=await context.worker.fetch(req,env);return response.json();
}
function result(reply){assert.ok(!reply.error,JSON.stringify(reply));return reply;}
assert.equal((await invoke({chat_id:'different-user'})).error,'Invalid request');assert.equal(calls.length,0);
console.log('PASS callers cannot change the recipient or message');
assert.equal(result(await invoke({dry_run:true})).status,'ready');assert.equal(calls.length,1);assert.equal(calls[0].method,'getChat');assert.equal(records.size,0);
console.log('PASS dry run verifies the bot chat without sending a message');
assert.equal(result(await invoke()).status,'outside_delivery_window');assert.equal(calls.length,1);
now='2026-10-31T14:00:00Z';
await Promise.all([invoke(),invoke()]);assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
assert.equal(result(await invoke()).status,'already_sent');assert.equal(records.size,1);
assert.deepEqual(calls[1].payload,{chat_id:'1754545781',text:'не забудь внести домашнее задание'});
console.log('PASS 14:00 UTC is 17:00 Moscow; correct recipient and text, one send per day');
now='2026-11-01T14:00:00Z';assert.equal(result(await invoke()).status,'sent');assert.equal(records.size,2);
console.log('PASS a new Moscow day permits the next daily reminder');
now='2026-11-02T20:00:00Z';assert.equal(result(await invoke()).status,'outside_delivery_window');
const health=await context.worker.fetch(new Request('https://private-reminder.test/health'),env);assert.equal((await health.json()).service,'domashka-reminders');
console.log('PASS late runs do not send at night; reminder health route remains available');
