const CACHE_NAME='apart-tid-shell-v5';
const OFFLINE_URL='/offline';
const APP_SHELL=[OFFLINE_URL,'/styles.css','/app.js','/manifest.webmanifest','/admin-app','/admin-app.css','/admin-app.js','/admin-manifest.webmanifest','/icons/apart-tid-192.png','/icons/apart-tid-512.png','/icons/apart-tid-maskable-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)));
});

self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;

  if(request.mode==='navigate'){
    event.respondWith(fetch(request).catch(()=>caches.match(OFFLINE_URL)));
    return;
  }

  if(!APP_SHELL.includes(url.pathname))return;
  event.respondWith(fetch(request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy))}
    return response;
  }).catch(()=>caches.match(request)));
});
