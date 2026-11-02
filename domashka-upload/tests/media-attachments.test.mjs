import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('const taskPhotos ='),source.indexOf('function render()'));
const mediaOrigin='https://domashka-media-vault.sparklesgrc.chatgpt.site';
const uploaded=[];
const context=vm.createContext({
  MEDIA_SERVER_URL:mediaOrigin,
  mediaUrl:(taskId,index)=>`${mediaOrigin}/v1/media/1/${taskId}/${index}`,
  userId:'1',AbortController,setTimeout,clearTimeout,
  yieldToBrowser:()=>Promise.resolve(),
  fetch:async(url,options)=>{
    if(url.startsWith('data:'))return {ok:true,blob:async()=>({type:'image/png',original:url})};
    uploaded.push({url,body:options.body});
    return {ok:true,json:async()=>({url})};
  },
});
vm.runInContext(helpers+'\nglobalThis.test={taskPhotoSources,uploadMediaPhotos};',context);

const existing=`${mediaOrigin}/v1/media/1/42/0?v=old`;
const originals=['data:image/png;base64,first','data:image/png;base64,second'];
const urls=await context.test.uploadMediaPhotos(42,[existing,...originals]);
assert.equal(urls.length,3);
assert.equal(urls[0],existing);
assert.equal(uploaded.length,2);
assert.equal(uploaded[0].body.original,originals[0]);
assert.equal(uploaded[1].body.original,originals[1]);
assert.match(urls[1],/\/42\/1$/);
assert.match(urls[2],/\/42\/2$/);
console.log('PASS appending attachments retains existing media URLs and uploads each new original separately');

const sources=context.test.taskPhotoSources({photos:[],mediaUrls:['',existing]});
assert.equal(sources.length,1);assert.equal(sources[0],existing);
console.log('PASS a missing first media URL does not hide later attached photos');
