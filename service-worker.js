const CACHE='genesis3d-20260724-modelos-v1';
const CORE=['./','./index.html','./corrigido.html','./manifest.json'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('genesis3d-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);if(u.origin!==self.location.origin)return;
  if(r.mode==='navigate'){
    e.respondWith(fetch(r).then(res=>{if(res&&res.ok)caches.open(CACHE).then(c=>c.put(r,res.clone()));return res;}).catch(async()=>await caches.match(r)||await caches.match('./corrigido.html')));return;
  }
  e.respondWith(caches.match(r).then(cached=>cached||fetch(r).then(res=>{if(res&&res.ok)caches.open(CACHE).then(c=>c.put(r,res.clone()));return res;})));
});
