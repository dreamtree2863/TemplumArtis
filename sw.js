/* Templum Artis Music — 서비스 워커.
   · 앱 셸(HTML/CSS/JS/아이콘): 캐시 우선 → 오프라인에서도 앱이 열림.
   · Drive 오디오(alt=media): <audio>가 직접 스트리밍. SW가 Authorization 헤더를
     주입하고 Range 요청을 그대로 전달(206) → 통째 다운로드 없이 즉시 재생/탐색.
   (스트리밍 인증 주입 기법은 Templum Sapientiae Mobile PWA에서 검증된 방식.) */
const CACHE = "ta-music-v3";
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js",
  "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png",
];

// 페이지가 보내준 Drive 액세스 토큰(메모리에만). <audio> 직접요청에 헤더 주입용.
let swToken = null;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("message", (e) => {
  const d = e.data;
  if (d === "skipWaiting") return self.skipWaiting();
  if (d && d.type === "token" && d.token) swToken = d.token;
});

// 인증 헤더가 없으면(=<audio>의 직접요청) 보관 토큰으로 채워 새 Request 생성.
// Range 등 원래 헤더는 그대로 복사 → 스트리밍/탐색 유지.
function withAuth(req) {
  if (req.headers.has("Authorization") || !swToken) return req;
  const h = new Headers(req.headers);
  h.set("Authorization", "Bearer " + swToken);
  return new Request(req.url, { method: req.method, headers: h, mode: "cors", credentials: "omit", redirect: "follow" });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Drive 오디오 스트리밍 — alt=media GET을 <audio>가 직접 요청.
  if (url.hostname === "www.googleapis.com"
      && url.pathname.startsWith("/drive/v3/files/")
      && url.searchParams.get("alt") === "media") {
    if (req.destination === "audio" || req.destination === "video" || req.headers.has("range")) {
      e.respondWith(fetch(withAuth(req), { cache: "no-store" }).catch(() => new Response("", { status: 504 })));
    }
    return; // 그 외 alt=media(메타 range fetch 등)는 페이지가 직접 인증해 가져감
  }

  // 앱 셸 — 네트워크 우선(항상 최신 코드), 오프라인이면 캐시로 폴백.
  if (req.method === "GET" && url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }).catch(() => caches.match(req))
    );
  }
  // 그 외(Drive 목록 API, OAuth 등)는 그냥 네트워크로 통과.
});
