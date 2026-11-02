import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const deadlineOutboxKey ='),source.indexOf('const localApi ='));
const disk=new Map(),requests=[];
let offline=true;
const tg={initData:'signed-session-for-test-only'};
const context=vm.createContext({tg,userId:'1754545781',localKey:'tasks',MEDIA_SERVER_URL:'https://media.test',AbortController,setTimeout,clearTimeout,console:{warn(){}},
 localStorage:{getItem:key=>disk.get(key)||null,setItem:(key,value)=>disk.set(key,value),removeItem:key=>disk.delete(key)},
 fetch:async(url,options)=>{requests.push({url,...options});if(offline)throw new Error('offline');return {ok:true};},
});
vm.runInContext(code+';globalThis.outbox={registerDeadlineTasks,updateDeadlineMetadata,queueDeadlineOperation,flushDeadlineOutbox,readDeadlineOutbox,running:()=>deadlineSyncRunning};',context);
const api=context.outbox;
async function idle(){for(let i=0;i<30&&api.running();i++)await setImmediate();assert.equal(api.running(),false);}
const task={id:1,title:'ПР–2',subject:'Информатика',dueDate:'2026-11-02',status:'todo',photos:['private-original'],photoSyncs:['transfer-copy']};
api.registerDeadlineTasks([task]);await idle();
assert.equal(api.readDeadlineOutbox().length,1);
const stored=disk.get('tasks_deadline_updates');assert.ok(!stored.includes('private-original'));assert.ok(!stored.includes('transfer-copy'));assert.ok(!stored.includes(tg.initData));
console.log('PASS deadline queue survives offline mode and never stores photo data or session credentials');
offline=false;tg.initData='fresh-session';await api.flushDeadlineOutbox();await idle();assert.equal(api.readDeadlineOutbox().length,0);assert.equal(requests.at(-1).headers['X-Telegram-Init-Data'],'fresh-session');
const originalCount=requests.length;api.registerDeadlineTasks([task]);await idle();assert.equal(requests.length,originalCount);
api.updateDeadlineMetadata({...task,status:'done'},{status:'done'});await idle();
assert.deepEqual(JSON.parse(requests.at(-1).body).changes,{status:'done'});assert.ok(!requests.at(-1).body.includes('private-original'));
api.queueDeadlineOperation('DELETE','/1');await idle();assert.equal(requests.at(-1).method,'DELETE');assert.equal(requests.at(-1).body,undefined);
console.log('PASS queued changes retry with fresh authentication; completion and deletion use small independent requests');
api.updateDeadlineMetadata(task,{mediaUrls:['https://photo.test/1']});await idle();assert.equal(requests.at(-1).method,'DELETE');
console.log('PASS uploading photo URLs does not trigger redundant deadline updates');
