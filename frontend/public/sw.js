const CACHE_NAME = "scout-ai-v2";
const urlsToCache = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Network-first strategy for API calls
  if (event.request.url.includes("/prod/")) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ message: "You are offline." }), {
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    return;
  }

  // Always revalidate page navigations so a previously cached fallback page
  // cannot mask a newly deployed static route such as /dashboard.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cachedPage = await caches.match(event.request);
        if (cachedPage) return cachedPage;

        const requestUrl = new URL(event.request.url);
        if (requestUrl.pathname === "/") {
          const cachedHome = await caches.match("/");
          if (cachedHome) return cachedHome;
        }

        return new Response("You are offline.", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      })
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) return response;
      return fetch(event.request).then((fetchResponse) => {
        if (
          fetchResponse &&
          fetchResponse.status === 200 &&
          fetchResponse.type === "basic"
        ) {
          const responseToCache = fetchResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return fetchResponse;
      });
    })
  );
});
