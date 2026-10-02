/* Templum Artis Music — 서비스 워커.
   · 앱 셸(HTML/CSS/JS/아이콘): 캐시 우선 → 오프라인에서도 앱이 열림.
   · Drive 오디오(alt=media): <audio>가 직접 스트리밍. SW가 Authorization 헤더를
     주입하고 Range 요청을 그대로 전달(206) → 통째 다운로드 없이 즉시 재생/탐색.
   (스트리밍 인증 주입 기법은 Templum Sapientiae Mobile PWA에서 검증된 방식.) */
const CACHE = "ta-music-v38";
const AUTH_CACHE = "ta-auth";   // Drive 토큰 보관(SW 재시작 후에도 읽기 위함)
const COVER_CACHE = "ta-covers";   // 추출한 앨범 커버(재생 시 즉시 표시). 갱신 때 지우지 않는다.
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js",
  "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png",
  "./icon-maskable.png", "./apple-touch-icon.png",
];
const SHELL_TIMEOUT_MS = 4000;   // 약한·로그인형 와이파이에서 OS 타임아웃(수십 초)까지 흰 화면으로 기다리지 않게

// 페이지가 보내준 Drive 액세스 토큰(메모리에만). <audio> 직접요청에 헤더 주입용.
let swToken = null;

self.addEventListener("install", (e) => {
  // cache:"reload" — GitHub Pages 의 10분 HTTP 캐시에서 옛 파일을 집어 새 버전 셸에 섞지 않게
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      // ‼ 캐시 저장소는 출처(dreamtree2863.github.io) 단위다 — 같은 출처의 학습 앱(templum-*) 캐시도
      //   여기 보인다. 내 것(ta-*)만 정리한다. 남의 것까지 지우면 그 앱의 오프라인 문서·토큰이 날아간다.
      keys.filter((k) => k.startsWith("ta-") && k !== CACHE && k !== AUTH_CACHE && k !== COVER_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});
self.addEventListener("message", (e) => {
  const d = e.data;
  if (d === "skipWaiting") return self.skipWaiting();
  if (d && d.type === "token" && d.token) {
    swToken = d.token;
    swBroker = d.broker || null;
    caches.open(AUTH_CACHE).then((c) => c.put("token", new Response(d.token))).catch(() => {});
  }
});

/* 토큰 중계(Apps Script) — 화면이 꺼져 페이지 타이머가 멈춘 채 토큰이 만료돼도,
   SW 가 401 을 받으면 직접 중계에서 새 읽기 토큰을 받아 같은 요청을 다시 보낸다.
   (그래야 백그라운드 재생이 1시간에서 끊기지 않는다) */
let swBroker = null, brokerInflight = null;
async function brokerConfig() {
  if (swBroker) return swBroker;
  try {
    const r = await (await caches.open(AUTH_CACHE)).match("broker");
    if (r) swBroker = JSON.parse(await r.text());
  } catch (_) {}
  return swBroker;
}
function brokerToken() {
  if (brokerInflight) return brokerInflight;
  brokerInflight = (async () => {
    const cfg = await brokerConfig();
    if (!cfg || !cfg.url || !cfg.key) return "";
    const r = await fetch(`${cfg.url}?key=${encodeURIComponent(cfg.key)}&app=music-sw`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!d.token) return "";
    swToken = d.token;
    caches.open(AUTH_CACHE).then((c) => c.put("token", new Response(d.token))).catch(() => {});
    return d.token;
  })().catch(() => "").finally(() => { brokerInflight = null; });
  return brokerInflight;
}
async function streamWithAuth(req) {
  const injected = !req.headers.has("Authorization");   // <audio> 직접 요청만 우리가 인증을 채운다
  let res = await fetch(authReq(req, await getToken()), { cache: "no-store" });
  if (res.status === 401 && injected) {
    const fresh = await brokerToken();
    if (fresh) res = await fetch(authReq(req, fresh), { cache: "no-store" });
  }
  return res;
}

// 메모리 토큰이 없으면(백그라운드에서 SW가 종료됐다 재시작된 경우) 캐시에서 복원.
async function getToken() {
  if (swToken) return swToken;
  try {
    const c = await caches.open(AUTH_CACHE);
    const r = await c.match("token");
    if (r) swToken = await r.text();
  } catch (_) {}
  return swToken;
}
// 인증 헤더가 없으면(=<audio>의 직접요청) 토큰으로 채워 새 Request 생성.
// Range 등 원래 헤더는 그대로 복사 → 스트리밍/탐색 유지.
function authReq(req, tok) {
  if (req.headers.has("Authorization") || !tok) return req;
  const h = new Headers(req.headers);
  h.set("Authorization", "Bearer " + tok);
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
      e.respondWith(
        streamWithAuth(req).catch(() => new Response("", { status: 504 }))
      );
    }
    return; // 그 외 alt=media(메타 range fetch 등)는 페이지가 직접 인증해 가져감
  }

  // 앱 셸 — 네트워크 우선(항상 최신 코드), 오프라인이면 캐시로 폴백.
  // cache:"no-store"로 브라우저 HTTP 캐시를 건너뛴다. GitHub Pages가 max-age=600(10분)을
  // 걸어, 그냥 fetch하면 코드를 바꿔도 최대 10분간 옛 파일이 나온다(=v버전 안 바뀜).
  if (req.method === "GET" && url.origin === self.location.origin) {
    e.respondWith(shellFetch(req));
  }
  // 그 외(Drive 목록 API, OAuth 등)는 그냥 네트워크로 통과.
});

// 앱 셸: 네트워크 우선이되 4초 안에 안 오면 캐시본으로 먼저 띄운다(받아지면 다음 실행에 반영).
// 쿼리(?v=, 바로가기 파라미터)가 달라도 같은 셸로 본다.
async function shellFetch(req) {
  const net = fetch(req, { cache: "no-store" }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
    return res;
  });
  const cached = () => caches.match(req, { ignoreSearch: true });
  const timeout = new Promise((r) => setTimeout(r, SHELL_TIMEOUT_MS, "timeout"));
  try {
    const first = await Promise.race([net, timeout]);
    if (first !== "timeout") return first;
    return (await cached()) || (await net);
  } catch (_) {
    return (await cached()) || new Response("오프라인입니다", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
