// Receives voice notes shared from WhatsApp into the installed app, hands them to the page.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method === 'POST' && u.pathname === '/share-target') {
    e.respondWith((async function () {
      var f = (await e.request.formData()).get('audio');
      if (f) { var c = await caches.open('sunlo-share'); await c.put('/shared-audio', new Response(f, { headers: { 'Content-Type': f.type || 'audio/ogg' } })); }
      return Response.redirect('/?shared=1', 303);
    })());
  }
});
