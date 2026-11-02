import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const fullSource = readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const source = fullSource.split('const localApi =')[0];
const photoHelper = fullSource.slice(fullSource.indexOf('const taskPhotos ='), fullSource.indexOf('const taskMediaUrls ='));
function setup(mode='ok', seed={}, options={}) {
 const disk=new Map(Object.entries(seed)), cloud=new Map(), writes=[];
 const storage={getItem(key,cb){if(mode==='hang')return;cb(null,cloud.get(key)||'');},setItem(key,value,cb){writes.push(key);if(mode==='hang')return;if(mode==='error')return cb('storage full');cloud.set(key,value);cb(null);},removeItem(key,cb){cloud.delete(key);cb(null);}};
 const records=options.records;
 const indexedDB=records && {open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(){const tx={objectStore(){return {put(record){if(options.failCache) throw new Error('disk full');records.set(record.taskId,structuredClone(record));},get(id){const r={};queueMicrotask(()=>{r.result=records.get(id);r.onsuccess?.();});return r;}}}};queueMicrotask(()=>tx.oncomplete?.());return tx;}};request.onsuccess?.();});return request;}};
 const context=vm.createContext({window:{indexedDB,Telegram:{WebApp:{version:'8.0',ready(){},expand(){},CloudStorage:options.offline?null:storage}}},indexedDB,location:{search:''},URLSearchParams,document:{body:{dataset:{}}},localStorage:{getItem:k=>disk.get(k)||null,setItem:(k,v)=>{if(v.length>(options.quota||Infinity))throw new Error('quota exceeded');disk.set(k,v);},removeItem:k=>disk.delete(k)},setTimeout,clearTimeout,console:{warn(){}},Map,Date});
 vm.runInContext(source+'\n'+photoHelper+'\nglobalThis.test = {writeStoredTasks,readStoredTasks,drain:()=>writeQueue};',context);
 return {api:context.test,disk,cloud,writes};
}
const key='domashka_tasks_1754545781';
const task={id:1,title:'test',photos:['data:image/jpeg;base64,'+'a'.repeat(15000)],photoThumbs:['data:image/jpeg;base64,abc']};
{
 const t=setup('hang');const start=Date.now();await t.api.writeStoredTasks([task]);assert.ok(Date.now()-start<1000);assert.equal(JSON.parse(t.disk.get(key))[0].photos[0],task.photos[0]);await t.api.drain();assert.ok(t.disk.has(key+'_pending'));console.log('PASS missing callback: save returns immediately, pending data retained');
 const reopened=setup('hang',Object.fromEntries(t.disk));assert.equal((await reopened.api.readStoredTasks())[0].title,'test');await reopened.api.drain();console.log('PASS reopen restores unsynced homework');
}
{
 const t=setup();await t.api.writeStoredTasks([task]);await t.api.drain();assert.equal(t.disk.has(key+'_pending'),false);assert.equal(JSON.parse(t.cloud.get('domashka_tasks'))[0].photoChunks[0],4);console.log('PASS photo chunks and metadata sync, pending removed after confirmation');
 const metadata=JSON.parse(t.cloud.get('domashka_tasks'))[0];await t.api.writeStoredTasks([{...metadata,photos:[],photoThumbs:task.photoThumbs,status:'done'},{id:2,title:'new'}]);await t.api.drain();assert.equal(JSON.parse(t.cloud.get('domashka_tasks'))[0].photoChunks[0],4);assert.ok(t.cloud.has('domashka_photo_1_0_0'));console.log('PASS new task preserves existing unloaded photos');
}
{
 const t=setup('error');await t.api.writeStoredTasks([task]);await t.api.drain();assert.ok(t.disk.has(key+'_pending'));assert.equal(t.cloud.has('domashka_tasks'),false);console.log('PASS write failure keeps retry data and does not publish incomplete metadata');
}
{
 const t=setup();const many=Array.from({length:80},(_,id)=>({id,title:`homework-${id}-`+'x'.repeat(80),subject:'Math',status:'todo'}));await t.api.writeStoredTasks(many);await t.api.drain();const count=Number(t.cloud.get('domashka_tasks_index'));assert.ok(count>1);assert.equal(t.cloud.has('domashka_tasks'),false);console.log('PASS oversized task lists use CloudStorage metadata chunks');
}
{
 const records=new Map();
 const original='data:image/jpeg;base64,'+'a'.repeat(4_000_000);
 const large={...task,photos:[original],photoSyncs:[original]};
 const t=setup('ok',{}, {records,quota:100_000,offline:true});
 await t.api.writeStoredTasks([large]);
 const metadata=JSON.parse(t.disk.get(key))[0];
 assert.equal(metadata.photos,undefined);assert.equal(metadata.photoSyncs,undefined);
 const reopened=setup('ok',Object.fromEntries(t.disk),{records,quota:100_000,offline:true});
 const restored=(await reopened.api.readStoredTasks())[0];
 assert.equal(restored.photos[0],original);assert.equal(restored.photoSyncs[0],original);
 console.log('PASS large originals bypass localStorage quota and survive reopening byte-for-byte');
}
{
 const seed={[key]:JSON.stringify([{id:2,title:'existing'}])};
 const t=setup('ok',seed,{records:new Map(),failCache:true,quota:1000,offline:true});
 await assert.rejects(t.api.writeStoredTasks([task]),/Не удалось сохранить фото/);
 assert.equal(t.disk.get(key),seed[key]);
 console.log('PASS storage failure keeps existing tasks and reports an error instead of dropping attachments');
}
