/* Templum Artis Music — PWA 프론트엔드.
   Google Drive의 음악을 스트리밍 재생하고, MP3 태그(USLT)에 심어둔 싱크 가사를
   재생에 맞춰 표시한다. 백엔드 없이 브라우저에서 Drive API를 직접 호출한다. */
"use strict";

/* ───────────────────── 유틸 ───────────────────── */
const APP_VERSION = "v19";  // 화면에 표시 — 폰이 최신 코드인지 눈으로 확인용
const CROSSFADE_MS = 800;   // 곡 전환 시 교차 페이드 길이(데스크톱과 동일)
const FADE_STEP_MS = 40;    // 페이드 갱신 간격
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
// 음악은 읽기 전용(drive.readonly). 플레이리스트는 음악 폴더의 _playlists.json으로
// PC와 공유하며, 그 파일을 쓰려면 쓰기 권한이 필요하다. 사용자 파일 전체가 아니라
// '이 앱이 만든 파일'만 접근하는 최소 권한(drive.file)을 함께 요청한다 → 폰이 그 파일을
// 만들고 이후 계속 읽고 쓴다. PC는 로컬 마운트로 같은 파일을 본다.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
const AUDIO_EXTS = [".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma"];
// 기존 Templum Sapientiae Mobile PWA와 같은 Google Cloud 프로젝트의 OAuth 클라이언트 ID.
// 같은 github.io 계정(=같은 출처)에 올리면 승인된 JS 원본이 이미 등록돼 새 설정이 불필요하다.
// (다른 도메인에 올릴 경우, Cloud 콘솔에서 그 원본만 추가하면 됨.)
const DEFAULT_CLIENT_ID = "113629352800-he0vmc6f2m3f3vn5clr968db12sf6t4u.apps.googleusercontent.com";

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ───────────────────── 상태 ───────────────────── */
let CLIENT_ID = LS.get("client_id", "") || DEFAULT_CLIENT_ID;
let tokenClient = null, accessToken = "", tokenExp = 0;
let curCoverUrl = null;
// 저장해 둔 액세스 토큰이 아직 유효하면 메모리로 복원(재진입 시 로그인 화면 생략).
(function restoreToken() {
  const t = LS.get("token", null);
  if (t && t.t && t.exp > Date.now()) { accessToken = t.t; tokenExp = t.exp; }
})();
let library = [];            // [{id, name, title, artist, size, album, year, genre, enriched}]
let filtered = [];
let curIndex = -1;
let curObjectUrl = null;
let shownCoverForId = null;   // 지금 커버가 표시된 곡 id(캐시/태그 중복 표시 방지)
let shuffle = false, repeat = "off";  // off|all|one
let lyrics = null;           // [{t, text}] | {plain}
let curLyricLine = -1;
let playlists = [];          // [{id, name, rel:[상대경로], ts}] — syncPlaylists에서 로드
let plTombs = {};            // {id: ts} 삭제 기록(PC에도 전파)
let selectedPlaylistId = null;   // 상세 뷰로 열어본 플레이리스트(null이면 목록)
let plQueue = null;          // 재생 큐(플레이리스트 재생 시 라이브러리 인덱스 배열)
let plQueuePos = -1;         // 큐 내 현재 위치
let pendingCoverPl = null;   // 커버 사진 선택 중인 플레이리스트 id
let pickerPlId = null;       // '곡 추가' 피커가 대상으로 하는 플레이리스트 id
let activeTab = "library";
let appEntered = false;
let sortMode = LS.get("sort_mode", "title");   // title|artist|album|year|genre
let viewMode = "list";       // list|album

// 크로스페이드용 오디오 2개. audio는 항상 '활성' 요소를 가리키고, spare는 대기.
// 곡을 바꿀 때 spare에 새 곡을 올려 서로 볼륨을 교차시킨 뒤 역할을 바꾼다.
let audio = $("#audio");
let spare = document.createElement("audio");
spare.preload = "auto";
document.body.appendChild(spare);
// Web Audio(공간감 효과)로 태우려면 스트림이 CORS로 받아져야 무음이 안 된다.
// SW가 이미 mode:"cors"로 Drive를 받아 정상 재생 중이므로 crossOrigin을 붙여도 안전하다.
audio.crossOrigin = "anonymous";
spare.crossOrigin = "anonymous";
// iOS Safari는 audio.volume이 읽기 전용(하드웨어 볼륨만) → 크로스페이드 불가.
// 값을 넣어보고 반영되는지로 판별하고, 안 되면 즉시 전환으로 폴백한다.
let crossfadeOK = false;
(function detectVolume() {
  try { audio.volume = 0.3; crossfadeOK = Math.abs(audio.volume - 0.3) < 0.01; audio.volume = 1; }
  catch (_) { crossfadeOK = false; }
})();
let fadeTimer = null;
let advancing = false;       // 곡 끝 무렵 다음 곡으로 미리 넘어가는 중(중복 방지)
let enriching = false, enrichStop = false;
let seeking = false, posTick = 0;
const LYRIC_LEAD_MS = 400;   // 가사를 살짝 앞당겨 표시(데스크톱과 동일한 체감)

/* ───────────────────── 앱 설치(홈 화면 추가) ─────────────────────
   자동 설치 배너는 브라우저가 자주 생략하고 iOS엔 아예 없다. 직접 누를 수 있는
   설치 버튼을 띄운다. Android는 네이티브 프롬프트, iOS는 수동 안내. */
let deferredPrompt = null;
function isStandalone() {
  return window.matchMedia && window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;   // iOS 홈 화면 실행 여부
}
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function showInstallFab() { const b = $("#install-fab"); if (b && !isStandalone()) b.hidden = false; }
function hideInstallFab() { const b = $("#install-fab"); if (b) b.hidden = true; }
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();       // 브라우저 기본 배너 대신 우리 버튼을 쓴다
  deferredPrompt = e;
  showInstallFab();
});
window.addEventListener("appinstalled", () => { deferredPrompt = null; hideInstallFab(); toast("설치되었습니다"); });

/* ───────────────────── OAuth (GIS) ───────────────────── */
function waitForGIS() {
  return new Promise((res) => {
    const tick = () => (window.google?.accounts?.oauth2 ? res() : setTimeout(tick, 100));
    tick();
  });
}
async function initToken() {
  await waitForGIS();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: () => {},   // 매 요청마다 갈아끼움
  });
}
function requestToken(interactive) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error("토큰 클라이언트 미초기화"));
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      accessToken = resp.access_token;
      tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
      LS.set("signed_in", true);
      LS.set("token", { t: accessToken, exp: tokenExp });   // 재진입 시 재사용(만료 전까지)
      sendTokenToSW();   // SW가 <audio> 스트리밍 요청에 인증을 주입할 수 있도록 전달
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
  });
}
async function ensureToken() {
  if (accessToken && Date.now() < tokenExp) return accessToken;
  return requestToken(false);
}
// 액세스 토큰을 서비스워커에 전달(메모리 보관). <audio src>가 Drive URL을 직접
// 요청할 때 SW가 Authorization 헤더를 넣어준다.
function sendTokenToSW() {
  if (!("serviceWorker" in navigator) || !accessToken) return;
  // 1) 캐시에 저장 → 백그라운드에서 SW가 종료·재시작돼도 인증 토큰을 읽을 수 있음.
  if (window.caches) caches.open("ta-auth").then((c) => c.put("token", new Response(accessToken))).catch(() => {});
  // 2) 실행 중인 SW에 즉시 전달.
  navigator.serviceWorker.ready.then((reg) => {
    (navigator.serviceWorker.controller || reg.active)?.postMessage({ type: "token", token: accessToken });
  }).catch(() => {});
}
// 태그(메타/커버/USLT)만 파싱하려고 파일 앞부분(ID3v2 영역)만 Range로 받는다.
async function fetchTagBytes(fileId, lastByte = 1048575) {
  const token = await ensureToken();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Range: `bytes=0-${lastByte}` }, cache: "no-store" });
  if (!r.ok && r.status !== 206) return null;
  return r.arrayBuffer();
}
// 커버 포함 태그를 받는다. 첫 요청에 256KB를 받아 '대부분의 앨범아트를 한 번의 왕복'에
// 가져온다(모바일에선 왕복 지연이 커서, 16KB→재요청 2왕복보다 256KB 1왕복이 더 빠르다).
// 커버가 256KB보다 크면(고해상도) 그때만 태그 크기만큼 두 번째로 받는다.
async function fetchTagExact(fileId) {
  const head = await fetchTagBytes(fileId, 262143);   // 256KB (한 왕복)
  if (!head) return null;
  const v = new Uint8Array(head);
  if (v.length < 10 || v[0] !== 0x49 || v[1] !== 0x44 || v[2] !== 0x33) return head; // ID3 아님
  const size = ((v[6] & 0x7f) << 21) | ((v[7] & 0x7f) << 14) | ((v[8] & 0x7f) << 7) | (v[9] & 0x7f);
  const end = 10 + size;                              // 태그 전체 끝(APIC 포함)
  if (end <= v.length) return head;                  // 대개 256KB 안에 다 들어옴 → 1왕복 끝
  return fetchTagBytes(fileId, Math.min(end, 4 * 1024 * 1024) - 1);   // 초대형 커버만 재요청
}

/* ── 커버 영구 캐시 (Cache API, 파일ID:크기 키) ──
   한 번 추출한 커버를 로컬에 저장해 재생 시 즉시 표시(재다운로드 없음).
   키에 파일 크기를 넣어, 파일이 바뀌면(재태깅) 자동으로 새로 받는다. LRU로 개수 제한. */
const COVER_CACHE = "ta-covers";
const COVER_KEYS = "cover_keys";
const COVER_MAX = 500;   // 최근 재생·프리페치한 커버 보관 수(대략 40~60MB)
function coverKey(t) { return `cover/${t.id}:${t.size || 0}`; }
async function getCachedCover(t) {
  try {
    const c = await caches.open(COVER_CACHE);
    const r = await c.match(coverKey(t));
    if (!r) return null;
    return URL.createObjectURL(await r.blob());
  } catch (_) { return null; }
}
async function putCachedCover(t, bytes, mime) {
  try {
    const c = await caches.open(COVER_CACHE);
    const key = coverKey(t);
    await c.put(key, new Response(new Blob([bytes], { type: mime || "image/jpeg" })));
    let keys = LS.get(COVER_KEYS, []).filter((k) => k !== key);
    keys.push(key);
    while (keys.length > COVER_MAX) { const old = keys.shift(); c.delete(old).catch(() => {}); }
    LS.set(COVER_KEYS, keys);
  } catch (_) {}
}
// 한 곡 커버를 백그라운드로 미리 받아 캐시.
async function prefetchCover(t) {
  if (!t || !t.id) return;
  try {
    const c = await caches.open(COVER_CACHE);
    if (await c.match(coverKey(t))) return;   // 이미 캐시됨
    const buf = await fetchTagExact(t.id);
    if (!buf) return;
    const m = parseID3(buf);
    if (m && m.cover) putCachedCover(t, m.cover.data, m.cover.mime);
  } catch (_) {}
}
// 현재 곡 다음 N곡의 커버를 순서대로 미리 받는다(스킵/자동재생 시 즉시 표시).
// 한꺼번에 몰아 받지 않고 하나씩 이어 받아 재생 스트림 대역폭을 덜 뺏는다.
let prefetchGen = 0;
async function prefetchCoversAhead(fromIndex, n) {
  const gen = ++prefetchGen;               // 곡이 바뀌면 이전 프리페치는 중단
  for (let k = 1; k <= n; k++) {
    if (gen !== prefetchGen) return;
    await prefetchCover(library[fromIndex + k]);
  }
}

/* ───────────────────── Drive API ───────────────────── */
async function driveFetch(url, asBlob) {
  const token = await ensureToken();
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 401) { accessToken = ""; const t2 = await ensureToken();
    const r2 = await fetch(url, { headers: { Authorization: "Bearer " + t2 } });
    if (!r2.ok) throw new Error("Drive " + r2.status); return asBlob ? r2.arrayBuffer() : r2.json();
  }
  if (!r.ok) throw new Error("Drive " + r.status);
  return asBlob ? r.arrayBuffer() : r.json();
}
function escQ(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function isAudioFile(f) {
  if ((f.mimeType || "").startsWith("audio/")) return true;
  return AUDIO_EXTS.some((e) => f.name.toLowerCase().endsWith(e));
}
function toTrack(f, rel) {
  const stem = f.name.replace(/\.[^.]+$/, "");
  const dash = stem.indexOf(" - ");
  // 파일 태그를 읽기 전의 '임시 추정'일 뿐이다. 실제 표시는 태그(TIT2/TPE1)를 우선하며,
  // 태그가 없을 때만 이 값이 남는다. 파일명 규칙은 "아티스트 - 제목"(데스크톱 저장 형식).
  // rel = 음악 폴더 기준 상대경로(예: "26.07.16/나무.mp3") — PC와 공유하는 곡 식별 열쇠.
  return { id: f.id, name: f.name, size: +f.size || 0, rel: rel || f.name,
    artist: dash > 0 ? stem.slice(0, dash) : "",
    title: dash > 0 ? stem.slice(dash + 3) : stem,
    guessed: true };   // 아직 태그 미확인(추정값)
}
// 저장된 음악 폴더 경로 목록(My Drive 기준). 기본은 데스크톱 라이브러리 폴더.
function getFolderPaths() {
  const v = LS.get("folder_paths", null);
  return (Array.isArray(v) && v.length) ? v : ["Junho's Data/취미/음악"];
}
function setFolderPaths(arr) { LS.set("folder_paths", arr); }

// "A/B/C" 경로를 폴더 ID로 변환(My Drive 루트부터). 못 찾으면 null.
async function resolveFolderPath(path) {
  let parent = "root";
  for (const seg of path.split("/").map((s) => s.trim()).filter(Boolean)) {
    const q = encodeURIComponent(
      `name='${escQ(seg)}' and '${parent}' in parents and ` +
      `mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=2&spaces=drive`;
    const data = await driveFetch(url, false);
    if (!data.files || !data.files.length) return null;
    parent = data.files[0].id;
  }
  return parent;
}
// 지정 폴더들의 오디오 파일만 하위 폴더까지 재귀로 수집(드라이브 전체 아님).
// 각 곡에 음악 폴더 기준 상대경로(rel)를 붙인다 — PC와 공유하는 곡 식별 열쇠.
async function listFolderAudio(rootIds, onProgress) {
  const out = [], seen = new Set();
  const queue = rootIds.map((id) => ({ id, prefix: "" }));   // 루트는 prefix 없음
  while (queue.length) {
    const { id: parent, prefix } = queue.shift();
    let pageToken = "";
    do {
      const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}` +
        `&fields=nextPageToken,files(id,name,size,mimeType)&pageSize=1000&orderBy=name&spaces=drive` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const data = await driveFetch(url, false);
      for (const f of data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          queue.push({ id: f.id, prefix: prefix + f.name + "/" });
          continue;
        }
        if (isAudioFile(f) && !seen.has(f.id)) {
          seen.add(f.id);
          out.push(toTrack(f, prefix + f.name));
        }
      }
      pageToken = data.nextPageToken || "";
      onProgress && onProgress(out.length);
    } while (pageToken);
  }
  out.sort((a, b) => a.title.localeCompare(b.title, "ko"));
  return out;
}

/* ───────────────────── ID3v2 파서 ─────────────────────
   mutagen이 쓴 태그를 읽어 제목/아티스트/앨범/커버/USLT(싱크가사)를 추출. */
function synchsafe(b0, b1, b2, b3) { return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3; }
function decodeText(bytes, enc) {
  try {
    if (enc === 0) return new TextDecoder("iso-8859-1").decode(bytes);
    if (enc === 1) return new TextDecoder("utf-16").decode(bytes);      // BOM 포함
    if (enc === 2) return new TextDecoder("utf-16be").decode(bytes);
    return new TextDecoder("utf-8").decode(bytes);                       // enc===3
  } catch { return ""; }
}
function parseID3(buf) {
  const v = new Uint8Array(buf);
  const meta = { title: "", artist: "", album: "", year: "", genre: "", cover: null, uslt: "" };
  if (v.length < 10 || v[0] !== 0x49 || v[1] !== 0x44 || v[2] !== 0x33) return meta; // "ID3"
  const ver = v[3];
  const size = synchsafe(v[6], v[7], v[8], v[9]);
  let pos = 10;
  const end = Math.min(10 + size, v.length);
  const idOf = (p) => String.fromCharCode(v[p], v[p + 1], v[p + 2], v[p + 3]);
  const nullLen = (enc) => (enc === 1 || enc === 2) ? 2 : 1;  // UTF-16이면 널이 2바이트

  while (pos + 10 <= end) {
    const id = idOf(pos);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    let fsize;
    if (ver === 4) fsize = synchsafe(v[pos + 4], v[pos + 5], v[pos + 6], v[pos + 7]);
    else fsize = (v[pos + 4] << 24) | (v[pos + 5] << 16) | (v[pos + 6] << 8) | v[pos + 7];
    const dstart = pos + 10;
    if (fsize <= 0 || dstart + fsize > end) break;
    const body = v.subarray(dstart, dstart + fsize);

    if (id[0] === "T") {                       // 텍스트 프레임
      const txt = decodeText(body.subarray(1), body[0]).replace(/\0+$/, "");
      if (id === "TIT2") meta.title = txt;
      else if (id === "TPE1") meta.artist = txt;
      else if (id === "TALB") meta.album = txt;
      else if (id === "TCON") meta.genre = txt;
      else if (id === "TYER" || id === "TDRC") meta.year = txt.slice(0, 4);
    } else if (id === "APIC") {                // 앨범아트
      let p = 1;
      const enc = body[0];
      while (p < body.length && body[p] !== 0) p++;   // MIME (latin1 null-term)
      const mime = decodeText(body.subarray(1, p), 0);
      p += 1; p += 1;                                 // null + picture type
      const nl = nullLen(enc);                        // description null-term
      while (p + nl <= body.length && !(body[p] === 0 && (nl === 1 || body[p + 1] === 0))) p += nl;
      p += nl;
      if (p < body.length) meta.cover = { mime: mime || "image/jpeg", data: body.subarray(p).slice() };
    } else if (id === "USLT") {                // 가사(우리가 LRC 텍스트를 심어둠)
      const enc = body[0];
      let p = 4;                                      // enc(1) + lang(3)
      const nl = nullLen(enc);
      while (p + nl <= body.length && !(body[p] === 0 && (nl === 1 || body[p + 1] === 0))) p += nl;
      p += nl;                                        // descriptor 건너뜀
      meta.uslt = decodeText(body.subarray(p), enc).replace(/\0+$/, "");
    }
    pos = dstart + fsize;
  }
  return meta;
}

/* ───────────────────── LRC 파서 ───────────────────── */
function parseLRC(text) {
  const out = [];
  for (const line of (text || "").split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const body = line.replace(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g, "").trim();
    for (const m of tags) {
      const cs = m[3] ? parseInt((m[3] + "00").slice(0, 3)) : 0;
      const t = (+m[1]) * 60000 + (+m[2]) * 1000 + cs;
      out.push({ t, text: body });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ───────────────────── 라이브러리 렌더 ───────────────────── */
// 정렬 키를 뽑는다. 값이 없으면(예: 아직 태그를 안 읽은 곡의 앨범) 맨 뒤로 보낸다.
const _SORT_TAIL = "￿";
function sortKey(t) {
  if (sortMode === "artist") return (t.artist || _SORT_TAIL);
  if (sortMode === "album") return (t.album || _SORT_TAIL);
  if (sortMode === "year") return (t.year || _SORT_TAIL);
  if (sortMode === "genre") return (t.genre || _SORT_TAIL);
  return t.title || _SORT_TAIL;
}
function sortTracks(arr) {
  return arr.sort((a, b) =>
    sortKey(a).localeCompare(sortKey(b), "ko") || (a.title || "").localeCompare(b.title || "", "ko"));
}
function applySearch() {
  const q = $("#search").value.trim().toLowerCase();
  filtered = q
    ? library.filter((t) => (t.title + " " + t.artist + " " + (t.album || "") + " " + t.name).toLowerCase().includes(q))
    : library.slice();
  sortTracks(filtered);
  render();
  updateEnrichBtn();
}
function render() {
  if (viewMode === "album") renderAlbums();
  else renderList();
}
// 재생 표시/태그 갱신만 반영(스크롤 유지). 전체 재렌더(render)는 innerHTML을 갈아
// 스크롤이 맨 위로 튀므로, 곡을 누를 때는 이걸 쓴다.
function refresh() {
  if (viewMode === "list") renderWindow(true);   // 현재 창만 제자리 갱신
  // 앨범 보기는 곡별 표시가 없어 다시 그릴 필요 없음
}

/* ── 목록(가상화) ──
   2200곡을 전부 DOM에 넣으면 폰 메모리·스크롤이 무겁다. 보이는 구간만 실제로 그린다. */
const V_ROW = 62;      // 행 높이(px, .track 기준). 첫 렌더 후 실측값으로 보정.
const V_BUFFER = 6;    // 화면 위아래로 미리 그려둘 행 수
let vRowH = V_ROW, vStart = -1, vEnd = -1;
function rowHtml(t) {
  const playing = t.id === library[curIndex]?.id ? " playing" : "";
  return `<div class="track${playing}" data-id="${t.id}">
      <div class="track-thumb">♪</div>
      <div class="track-body">
        <div class="track-title">${escapeHtml(t.title)}</div>
        <div class="track-artist">${escapeHtml(t.artist || "알 수 없는 아티스트")}</div>
      </div>
      <button class="track-add" data-add="${t.id}">＋</button>
    </div>`;
}
function renderList() {
  const box = $("#track-list");
  box.classList.remove("album-mode");
  if (!filtered.length) {
    box.innerHTML = `<div class="entries-empty">${library.length ? "검색 결과가 없습니다." : "곡이 없습니다."}</div>`;
    return;
  }
  box.innerHTML = `<div class="vlist"><div class="vlist-inner"></div></div>`;
  vStart = vEnd = -1;
  renderWindow(true);
}
function renderWindow(force) {
  if (viewMode !== "list") return;
  const box = $("#track-list");
  const vlist = box.querySelector(".vlist");
  const inner = box.querySelector(".vlist-inner");
  if (!vlist || !inner) return;
  vlist.style.height = filtered.length * vRowH + "px";
  const top = box.scrollTop;
  const viewH = box.clientHeight || 500;
  const start = Math.max(0, Math.floor(top / vRowH) - V_BUFFER);
  const end = Math.min(filtered.length, Math.ceil((top + viewH) / vRowH) + V_BUFFER);
  if (!force && start === vStart && end === vEnd) return;
  inner.style.transform = `translateY(${start * vRowH}px)`;
  inner.innerHTML = filtered.slice(start, end).map(rowHtml).join("");
  vStart = start; vEnd = end;
  // 보이는 곡의 실제 태그를 읽어 채운다(태그 우선, 없으면 파일명 추정 유지).
  for (const t of filtered.slice(start, end)) queueEnrich(t);
  // 실제 행 높이를 한 번 재서 보정(폰 글꼴/배율에 따라 달라짐).
  if (force) {
    const first = inner.querySelector(".track");
    if (first) {
      const h = first.getBoundingClientRect().height;
      if (h > 10 && Math.abs(h - vRowH) > 0.5) { vRowH = h; renderWindow(true); }
    }
  }
}

/* ── 앨범 그리드 ──
   앨범 태그로 묶는다. 아직 태그를 안 읽은 곡은 앨범이 비어 "(앨범 미확인)"에 모인다.
   상단 '곡 정보 읽기'로 채울 수 있다(아래 enrichAll). */
function renderAlbums() {
  const box = $("#track-list");
  box.classList.add("album-mode");
  if (!filtered.length) {
    box.innerHTML = `<div class="entries-empty">${library.length ? "검색 결과가 없습니다." : "곡이 없습니다."}</div>`;
    return;
  }
  const groups = new Map();
  for (const t of filtered) {
    const key = t.album || "(앨범 미확인)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const cards = [...groups.entries()].map(([album, ts]) => {
    const ids = ts.map((t) => t.id).join(",");
    return `<div class="album-card" data-ids="${ids}">
      <div class="album-art">♪</div>
      <div class="album-cap">
        <div class="album-name">${escapeHtml(album)}</div>
        <div class="album-artist">${escapeHtml(ts[0].artist || "")} · ${ts.length}곡</div>
      </div>
    </div>`;
  }).join("");
  box.innerHTML = `<div class="album-grid">${cards}</div>`;
}

/* ───────────────────── 재생 ───────────────────── */
function driveUrl(id) { return `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`; }
function clearFade() { if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; } }

// 새 곡을 재생한다. crossfade=true이고 현재 곡이 재생 중이면 대기 요소에 새 곡을
// 올려 볼륨을 교차시키고, 끝나면 역할을 바꾼다. iOS(볼륨 읽기전용) 등에서는 즉시 전환.
function startPlayback(url, crossfade) {
  clearFade();
  const canCross = crossfade && crossfadeOK && !audio.paused && audio.currentTime > 0
    && audio.src && audio.src !== url;
  if (canCross) {
    const outgoing = audio, incoming = spare;
    try { incoming.volume = 0; } catch (_) {}
    incoming.src = url;
    try { incoming.currentTime = 0; } catch (_) {}
    audio = incoming; spare = outgoing;   // 새 요소를 '활성'으로 → 이벤트가 새 곡에 귀속
    incoming.play().catch(() => {});
    let t = 0;
    fadeTimer = setInterval(() => {
      t += FADE_STEP_MS;
      const r = Math.min(1, t / CROSSFADE_MS);
      try { incoming.volume = r; } catch (_) {}
      try { outgoing.volume = 1 - r; } catch (_) {}
      if (r >= 1) {
        clearFade();
        outgoing.pause();
        try { outgoing.currentTime = 0; outgoing.volume = 1; } catch (_) {}
        outgoing.removeAttribute("src"); try { outgoing.load(); } catch (_) {}
      }
    }, FADE_STEP_MS);
  } else {
    try { spare.pause(); spare.removeAttribute("src"); } catch (_) {}
    try { audio.volume = 1; } catch (_) {}
    audio.src = url;
    audio.play().catch(() => {});
  }
}

/* ───────────────────── 공간감/울림 효과 (Web Audio) ─────────────────────
   갤럭시 내장 Dolby Atmos는 OS가 출력 전체에 거는 것이라 앱이 못 켠다. 이건 그와
   별개로, 앱이 <audio> 출력을 Web Audio 그래프에 태워 리버브(울림)+스테레오 확장을
   직접 거는 효과다. 두 오디오 요소(크로스페이드용) 모두 한 그래프에 물린다.
   기본 꺼짐. 켤 때만 그래프를 만든다(안 켜면 기존 재생 경로를 전혀 안 건드림). */
// 그래프: source → spComp(음량 평준화 컴프) → spMakeup → [spDry(통과) + spPre→spConv→spWet(리버브)] → 출력
// 공간감(리버브)과 음량 평준화(컴프레션)를 한 체인에서 각각 켜고 끈다. 둘 다 꺼져 있으면
// 그래프를 아예 만들지 않아 기존 재생 경로를 안 건드린다.
let actx = null, spDry = null, spWet = null, spConv = null, spPre = null, spComp = null, spMakeup = null;
let spaceReady = false, spaceApplied = false, normApplied = false;
const spaceSources = new WeakMap();
const SPACE_PRESETS = {
  off:  { dry: 1.0, wet: 0.0, pre: 0.0, ir: null },
  soft: { dry: 0.92, wet: 0.16, pre: 0.02, ir: [2.0, 2.4] },
  wide: { dry: 0.85, wet: 0.32, pre: 0.03, ir: [2.6, 1.8] },
};
function makeIR(seconds, decay) {
  const rate = actx.sampleRate, len = Math.max(1, (seconds * rate) | 0);
  const buf = actx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
// 컴프레서를 '투명'(압축 안 함)으로 — 음량 평준화 끔 상태.
function setCompTransparent() {
  if (!spComp) return;
  spComp.threshold.value = 0; spComp.knee.value = 0; spComp.ratio.value = 1;
  spComp.attack.value = 0.003; spComp.release.value = 0.25;
  if (spMakeup) spMakeup.gain.value = 1;
}
function routeSpace(el) {
  if (!actx || spaceSources.has(el)) return;
  try {
    const s = actx.createMediaElementSource(el);
    s.connect(spComp);            // 모든 소리는 컴프레서를 먼저 지난다(투명이면 무변화)
    spaceSources.set(el, s);
  } catch (_) { /* 이미 연결됐거나 실패 — 무시 */ }
}
function ensureSpaceGraph() {
  if (spaceReady) return true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    actx = new AC();
    spComp = actx.createDynamicsCompressor(); setCompTransparent();
    spMakeup = actx.createGain(); spMakeup.gain.value = 1;
    spDry = actx.createGain(); spWet = actx.createGain();
    spConv = actx.createConvolver(); spPre = actx.createDelay(0.2);
    spConv.buffer = makeIR(2.2, 2.0);
    spComp.connect(spMakeup);
    spMakeup.connect(spDry); spMakeup.connect(spPre);
    spPre.connect(spConv); spConv.connect(spWet);
    spDry.connect(actx.destination); spWet.connect(actx.destination);
    routeSpace(audio); routeSpace(spare);
    spaceReady = true;
    return true;
  } catch (_) { spaceReady = false; return false; }
}
function reflectSpaceUI(mode) {
  document.querySelectorAll("#fxrow .fx-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.fx === mode));
}
function applySpace(mode, save) {
  if (!SPACE_PRESETS[mode]) mode = "off";
  if (save !== false) LS.set("space_fx", mode);
  reflectSpaceUI(mode);
  if (mode === "off") {
    if (spaceReady) { spDry.gain.value = 1; spWet.gain.value = 0; }   // 그래프는 둔 채 통과만
    return;
  }
  if (!ensureSpaceGraph()) { toast("이 기기에선 공간감 효과를 쓸 수 없어요."); LS.set("space_fx", "off"); reflectSpaceUI("off"); return; }
  if (actx.state === "suspended") actx.resume().catch(() => {});
  const p = SPACE_PRESETS[mode];
  if (p.ir) spConv.buffer = makeIR(p.ir[0], p.ir[1]);
  spPre.delayTime.value = p.pre;
  spDry.gain.value = p.dry; spWet.gain.value = p.wet;
}
// 음량 평준화: 완만한 컴프레션 + 메이크업 게인으로 곡 간 볼륨 차를 줄인다(PC normvol과 결 맞춤).
function reflectNormUI(on) { const b = $("#fx-norm"); if (b) b.classList.toggle("active", !!on); }
function applyNormalize(on, save) {
  on = !!on;
  if (save !== false) LS.set("norm_fx", on ? "1" : "");
  reflectNormUI(on);
  if (!on) { if (spaceReady) setCompTransparent(); return; }
  if (!ensureSpaceGraph()) { toast("이 기기에선 음량 평준화를 쓸 수 없어요."); LS.set("norm_fx", ""); reflectNormUI(false); return; }
  if (actx.state === "suspended") actx.resume().catch(() => {});
  spComp.threshold.value = -24; spComp.knee.value = 30; spComp.ratio.value = 3;
  spComp.attack.value = 0.01; spComp.release.value = 0.3;
  spMakeup.gain.value = 1.6;   // 눌린 큰음을 보상해 조용한 곡을 끌어올림
}

async function playByLibIndex(i, opts = {}) {
  if (i < 0 || i >= library.length) return;
  advancing = false;                 // 자동 크로스페이드 예약 해제(새 곡 시작)
  curIndex = i;
  // 저장된 공간감·음량 평준화 설정을 첫 재생(=사용자 제스처) 때 한 번 실제로 건다.
  if (!spaceApplied) { spaceApplied = true; const m = LS.get("space_fx", "off"); if (m !== "off") applySpace(m, false); }
  if (!normApplied) { normApplied = true; if (LS.get("norm_fx", "")) applyNormalize(true, false); }
  const track = library[i];
  $("#mini").hidden = false;
  // 정보는 태그에서 온 것만 보여준다. 아직 태그를 안 읽은 곡이면 추정값(파일명)을
  // 띄우지 않고 '불러오는 중'으로 두었다가, 아래에서 태그를 읽어 채운다.
  // (목록에서 보이던 곡은 이미 태그를 읽어둬서 known=true → 즉시 정확히 표시)
  const known = !!track.enriched;
  if (curCoverUrl) { URL.revokeObjectURL(curCoverUrl); curCoverUrl = null; }
  shownCoverForId = null;
  setNowPlaying({
    title: known ? track.title : "불러오는 중…",
    artist: known ? track.artist : "",
    album: known ? (track.album || "") : "",
    year: known ? track.year : "", genre: known ? track.genre : "",
    cover: null,
  });
  updateMediaSession(known ? track.title : (track.title || ""),
                     known ? track.artist : "", known ? (track.album || "") : "", null);
  $("#mini-play").textContent = "…"; $("#btn-play").textContent = "…";
  lyrics = null; curLyricLine = -1;
  refresh();
  $("#lyrics").innerHTML = `<div class="spinner"></div>`;

  // 캐시된 커버가 있으면 다운로드를 기다리지 않고 즉시 표시(가장 큰 체감 개선).
  getCachedCover(track).then((url) => {
    if (!url) return;
    if (i !== curIndex || shownCoverForId === track.id) { URL.revokeObjectURL(url); return; }
    if (curCoverUrl) URL.revokeObjectURL(curCoverUrl);
    curCoverUrl = url; shownCoverForId = track.id;
    setCoverImg("#cover", url); setCoverImg("#mini-art", url);
  });

  try {
    await ensureToken();
    sendTokenToSW();   // <audio> 요청 전에 SW가 토큰을 갖고 있도록
    // 스트리밍 재생 — SW가 Authorization을 주입하므로 Drive URL을 직접 <audio>에.
    if (curObjectUrl) { URL.revokeObjectURL(curObjectUrl); curObjectUrl = null; }
    startPlayback(driveUrl(track.id), opts.crossfade !== false);
    // 메타/커버/가사 — 태그만 '딱 필요한 만큼' 받아 파싱(1MB 고정 아님).
    const buf = await fetchTagExact(track.id);
    if (i !== curIndex) return;   // 그새 다른 곡으로 넘어갔으면 무시
    if (buf) {
      const m = parseID3(buf);
      const title = m.title || track.title, artist = m.artist || track.artist;
      track.title = title; track.artist = artist;
      track.album = m.album || ""; track.year = m.year || ""; track.genre = m.genre || "";
      track.enriched = true;
      persistLibrary();               // 읽은 태그를 캐시에 저장(다음엔 앨범/정렬에 바로 반영)
      if (m.cover) {
        putCachedCover(track, m.cover.data, m.cover.mime);   // 다음 재생 땐 즉시 표시
        // 캐시가 이미 이 곡 커버를 띄웠으면 다시 만들지 않는다(깜빡임 방지).
        if (shownCoverForId !== track.id) {
          if (curCoverUrl) URL.revokeObjectURL(curCoverUrl);
          curCoverUrl = URL.createObjectURL(new Blob([m.cover.data], { type: m.cover.mime }));
          shownCoverForId = track.id;
        }
      }
      setNowPlaying({ title, artist, album: m.album, year: m.year, genre: m.genre, cover: curCoverUrl });
      setLyrics(m.uslt);
      updateMediaSession(title, artist, m.album, curCoverUrl);
      refresh();
      // 순차 재생이면 '다음 여러 곡' 커버를 미리 받아둔다(스킵 시 즉시 표시). 셔플은 예측 불가라 생략.
      if (!shuffle && i === curIndex) prefetchCoversAhead(i, 4);
    }
  } catch (e) {
    toast("재생 실패: " + e.message);
    $("#mini-play").textContent = "▶"; $("#btn-play").textContent = "▶";
  }
}
function setNowPlaying({ title, artist, album, year, genre, cover }) {
  $("#mini-title").textContent = title || "—";
  $("#mini-artist").textContent = artist || "";
  $("#np-title").textContent = title || "—";
  $("#np-artist").textContent = artist || "";
  $("#np-album").textContent = album || "";
  $("#np-extra").textContent = [year, genre].filter(Boolean).join(" · ");
  setCoverImg("#cover", cover);
  setCoverImg("#mini-art", cover);
}
// 커버 <img> 설정. 커버가 없으면 src=""를 넣지 않는다 — 빈 src는 '깨진 이미지'
// 아이콘을 띄우기 때문이다. 대신 src 속성을 지워 CSS 플레이스홀더(♪)가 보이게 한다.
function setCoverImg(sel, url) {
  const img = $(sel);
  if (!img) return;
  img.onload = img.onerror = null;
  if (url) {
    // 로드 '성공'했을 때만 보이게 한다(has-art). 그 전엔 투명(=♪ 플레이스홀더가 보임)이라
    // 로딩 중이거나 실패해도 '깨진 이미지' 아이콘이 절대 안 뜬다.
    img.classList.remove("has-art");
    img.onload = () => img.classList.add("has-art");
    img.onerror = () => { img.removeAttribute("src"); img.classList.remove("has-art"); };
    img.src = url;
  } else {
    img.removeAttribute("src");
    img.classList.remove("has-art");
  }
}
function setLyrics(uslt) {
  const box = $("#lyrics");
  if (!uslt || !uslt.trim()) { lyrics = { plain: "" }; box.innerHTML = `<div class="ly-empty">가사가 없습니다.<br>(연주곡이거나 태그에 가사가 없어요)</div>`; return; }
  const synced = parseLRC(uslt);
  if (synced.length) {
    lyrics = synced;
    box.innerHTML = synced.map((l, i) => `<div class="ly-line" data-i="${i}">${escapeHtml(l.text || "♪")}</div>`).join("")
      + `<div class="ly-src">USLT · 동기화</div>`;
  } else {
    lyrics = { plain: uslt };
    box.innerHTML = `<div class="ly-plain">${escapeHtml(uslt)}</div>`;
  }
  curLyricLine = -1;
}
function syncLyrics() {
  if (!Array.isArray(lyrics)) return;
  const at = audio.currentTime * 1000 + LYRIC_LEAD_MS;   // 살짝 앞당김
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) { if (lyrics[i].t <= at) idx = i; else break; }
  if (idx === curLyricLine) return;
  const box = $("#lyrics");
  const lines = box.querySelectorAll(".ly-line");
  if (curLyricLine >= 0 && lines[curLyricLine]) lines[curLyricLine].classList.remove("active");
  curLyricLine = idx;
  if (idx >= 0 && lines[idx]) {
    lines[idx].classList.add("active");
    if (!$("#player").hidden && activePPanel() === "lyrics")
      lines[idx].scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
function nextTrack(auto) {
  if (repeat === "one" && auto) { audio.currentTime = 0; audio.play(); return; }
  // 플레이리스트 재생 중이면 그 큐 안에서 다음 곡으로.
  if (plQueue && plQueue.length) {
    let p;
    if (shuffle) { do { p = Math.floor(Math.random() * plQueue.length); } while (plQueue.length > 1 && p === plQueuePos); }
    else { p = plQueuePos + 1; if (p >= plQueue.length) { if (repeat !== "all" && auto) return; p = 0; } }
    plQueuePos = p; playByLibIndex(plQueue[p]); return;
  }
  if (!library.length) return;
  let n;
  if (shuffle) { do { n = Math.floor(Math.random() * library.length); } while (library.length > 1 && n === curIndex); }
  else { n = curIndex + 1; if (n >= library.length) { if (repeat !== "all" && auto) return; n = 0; } }
  playByLibIndex(n);
}
function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (plQueue && plQueue.length) {
    let p = plQueuePos - 1; if (p < 0) p = plQueue.length - 1;
    plQueuePos = p; playByLibIndex(plQueue[p]); return;
  }
  let n = curIndex - 1; if (n < 0) n = library.length - 1;
  playByLibIndex(n);
}
function togglePlay() {
  if (curIndex < 0 && library.length) return playByLibIndex(0);
  if (audio.paused) { audio.play(); return; }
  // 페이드 도중 일시정지: 페이드를 즉시 끝내고(활성 요소만 남김) 멈춘다.
  if (fadeTimer) { clearFade(); try { spare.pause(); spare.removeAttribute("src"); audio.volume = 1; } catch (_) {} }
  audio.pause();
}
// 완전 정지(미디어 알림을 밀어 없앨 때 호출됨) — 재생 멈추고 잠금화면 세션 제거.
function stopPlayback() {
  clearFade();
  audio.pause();
  try { spare.pause(); spare.removeAttribute("src"); audio.volume = 1; } catch (_) {}
  try { audio.currentTime = 0; } catch (_) {}
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = "none";
    try { navigator.mediaSession.metadata = null; } catch (_) {}
  }
}

/* 미디어세션(잠금화면/알림/헤드셋 컨트롤) — 앱을 나가도(백그라운드/잠금) OS가
   재생을 이어가고 컨트롤을 띄우게 한다. */
function updateMediaSession(title, artist, album, cover) {
  if (!("mediaSession" in navigator)) return;
  const artwork = cover
    ? [96, 128, 192, 256, 384, 512].map((s) => ({ src: cover, sizes: `${s}x${s}`, type: "image/jpeg" }))
    : [{ src: "./icon-512.png", sizes: "512x512", type: "image/png" }];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || "", artist: artist || "", album: album || "", artwork,
    });
  } catch (_) {}
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (_) {} };
  set("play", () => audio.play());
  set("pause", () => audio.pause());
  set("previoustrack", prevTrack);
  set("nexttrack", () => nextTrack(false));
  set("stop", stopPlayback);   // 미디어 알림을 밀어 없애면 재생 중단
  set("seekbackward", (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  set("seekforward", (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
  set("seekto", (d) => { if (d.seekTime != null && audio.duration) audio.currentTime = d.seekTime; });
}
// 잠금화면 진행바용 위치 상태(간헐 갱신). duration이 유효할 때만.
function updatePositionState() {
  const ms = navigator.mediaSession;
  if (!ms || !ms.setPositionState) return;
  const d = audio.duration;
  if (!d || !isFinite(d)) return;
  try { ms.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, d) }); }
  catch (_) {}
}

/* ───────────────────── 플레이리스트 (PC와 양방향 동기화) ─────────────────────
   곡을 '음악 폴더 기준 상대경로(rel)'로 저장해 PC와 공유한다(폰=Drive 파일ID, PC=로컬
   경로라 공통 열쇠가 필요). 공용 파일은 음악 폴더의 _playlists.json 하나. 폰은 그 파일을
   drive.file 권한으로 만들고 읽고 쓰며, PC는 로컬 마운트로 같은 파일을 본다.
   형식: { v:1, items:[ {id,name,rel:[...],ts} | {id,deleted:true,ts} ] } (playlist_sync와 동일). */
const PL_FILE = "_playlists.json";
let plFileId = null;          // 공용 파일 id 캐시
let plParentId = null;        // 공용 파일을 둘 음악 루트 폴더 id (loadLibrary에서 설정)
let plSaveTimer = null;
let relToId = new Map();      // 상대경로 → Drive 파일 id (재생용)
let idToRel = new Map();      // Drive 파일 id → 상대경로 (구 플레이리스트 이관용)
const TOMB_TTL = 30 * 24 * 3600 * 1000;

function buildRelMap() {
  relToId = new Map(); idToRel = new Map();
  for (const t of library) { relToId.set(t.rel, t.id); idToRel.set(t.id, t.rel); }
}

// items ↔ 상태(playlists + plTombs) 변환
function plItems() {
  const items = playlists.map((p) => ({ id: p.id, name: p.name, rel: p.rel.slice(), ts: p.ts || 0 }));
  for (const [id, ts] of Object.entries(plTombs)) items.push({ id, deleted: true, ts });
  return items;
}
function plFromItems(items) {
  const pls = [], tombs = {};
  for (const it of items || []) {
    if (!it || !it.id) continue;
    if (it.deleted) tombs[it.id] = it.ts || 0;
    else pls.push({ id: it.id, name: it.name || "", rel: Array.isArray(it.rel) ? it.rel : [], ts: it.ts || 0 });
  }
  playlists = pls; plTombs = tombs;
}
// playlist_sync.merge 의 JS 판(동일 규칙): id별 최신 ts 우선 + 오래된 tombstone 제거.
function mergeItems(local, remote, now) {
  const by = {};
  for (const it of [...(local || []), ...(remote || [])]) {
    if (!it || !it.id) continue;
    if (!(it.id in by) || (it.ts || 0) > (by[it.id].ts || 0)) by[it.id] = it;
  }
  return Object.values(by).filter((it) => !(it.deleted && now - (it.ts || 0) > TOMB_TTL));
}

// 공용 파일 id 찾기(음악 루트 폴더 안에서). 없으면 null.
async function findPlaylistFile() {
  if (plFileId) return plFileId;
  if (!plParentId) return null;
  const token = await ensureToken();
  const q = encodeURIComponent(`name='${PL_FILE}' and '${plParentId}' in parents and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1&spaces=drive`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("Drive " + r.status);
  const data = await r.json();
  plFileId = (data.files && data.files[0]) ? data.files[0].id : null;
  return plFileId;
}
async function readSharedItems() {
  try {
    const id = await findPlaylistFile();
    if (!id) return [];
    const token = await ensureToken();
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
      { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    if (!r.ok) return [];
    const doc = await r.json();
    return (doc && Array.isArray(doc.items)) ? doc.items : [];
  } catch (_) { return []; }
}
// 공용 파일 저장(있으면 PATCH, 없으면 음악 폴더에 생성). 권한 없으면 한 번 동의받고 재시도.
async function writeSharedItems(items) {
  const body = JSON.stringify({ v: 1, items });
  async function write() {
    const token = await ensureToken();
    const id = await findPlaylistFile();
    if (id) {
      const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
        method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body });
      if (!r.ok) throw new Error("Drive " + r.status);
    } else {
      if (!plParentId) throw new Error("no-parent");
      const meta = { name: PL_FILE, parents: [plParentId] };
      const boundary = "ta" + Date.now().toString(36);
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": `multipart/related; boundary=${boundary}` },
        body: multipart });
      if (!r.ok) throw new Error("Drive " + r.status);
      const j = await r.json().catch(() => null);
      if (j && j.id) plFileId = j.id;
    }
  }
  try { await write(); }
  catch (e) {
    if (/40[13]/.test(e.message)) {   // 아직 쓰기 권한 동의 전 → 한 번 받고 재시도
      await requestToken(true); await write();
    } else throw e;
  }
}

// 라이브러리 로드 후 호출: 로컬+공용 병합 → 반영 → 공용 저장. 구(파일ID) 플레이리스트도 이관.
let plSynced = false;
async function syncPlaylists() {
  buildRelMap();
  // 공용 파일을 둘 음악 루트 폴더 id 확보(캐시 로드 땐 폴더 해석을 안 하므로 여기서 보강).
  if (!plParentId) {
    plParentId = LS.get("pl_parent", null);
    if (!plParentId) {
      try { plParentId = await resolveFolderPath(getFolderPaths()[0]); LS.set("pl_parent", plParentId); }
      catch (_) {}
    }
  }
  // 로컬 상태 로드(신형식 items)
  plFromItems(LS.get("pl_items", []));
  // 구형식(파일ID 기반 배열) 1회 이관 → rel
  const legacy = LS.get("playlists", null);
  if (Array.isArray(legacy) && legacy.length) {
    const now = Date.now();
    for (const old of legacy) {
      const rel = (old.ids || []).map((fid) => idToRel.get(fid)).filter(Boolean);
      if (!playlists.some((p) => p.id === old.id))
        playlists.push({ id: old.id, name: old.name || "새 목록", rel, ts: now });
    }
    LS.set("playlists", []);   // 이관 완료 표시
    LS.set("pl_items", plItems());
  }
  // 공용 파일과 병합
  try {
    const merged = mergeItems(plItems(), await readSharedItems(), Date.now());
    plFromItems(merged);
    LS.set("pl_items", plItems());
    await writeSharedItems(plItems());   // 폰이 파일을 만들거나 갱신(양쪽 수렴)
    plSynced = true;
  } catch (_) { /* 오프라인/권한 거부면 로컬만 사용 */ }
  if (activeTab === "playlists") renderPlaylists();
}

// 새로고침 버튼: 공용 파일(_playlists.json)만 다시 읽어 PC 변경을 즉시 반영.
// 라이브러리는 다시 안 읽으므로 빠르다(rel 매핑은 이미 있음).
let plRefreshing = false;
async function refreshPlaylists() {
  if (plRefreshing) return;
  plRefreshing = true;
  document.querySelectorAll("#btn-pl-refresh, #pl-refresh-btn").forEach((b) => b.classList.add("spinning"));
  try {
    const before = JSON.stringify(plItems());
    const merged = mergeItems(plItems(), await readSharedItems(), Date.now());
    plFromItems(merged);
    LS.set("pl_items", plItems());
    await writeSharedItems(plItems());   // 양쪽 수렴(폰 로컬 변경도 함께 반영)
    if (activeTab === "playlists") renderPlaylists();
    toast(JSON.stringify(plItems()) === before ? "이미 최신입니다." : "PC 변경 내용을 불러왔어요.");
  } catch (_) {
    toast("불러오지 못했습니다. 네트워크를 확인하세요.");
  } finally {
    plRefreshing = false;
    document.querySelectorAll("#btn-pl-refresh, #pl-refresh-btn").forEach((b) => b.classList.remove("spinning"));
  }
}

function savePlaylists() {
  LS.set("pl_items", plItems());
  // 공용 저장은 약간 미뤄 묶는다. 저장 전 공용과 병합해 다른 기기 변경을 지키지 않도록.
  clearTimeout(plSaveTimer);
  plSaveTimer = setTimeout(async () => {
    try {
      const merged = mergeItems(plItems(), await readSharedItems(), Date.now());
      plFromItems(merged); LS.set("pl_items", plItems());
      await writeSharedItems(plItems());
      if (activeTab === "playlists") renderPlaylists();
    } catch (_) {}
  }, 800);
}
/* ── 커버(커스텀=로컬 저장, 없으면 첫 곡 앨범커버) ── */
function plCustomCovers() { return LS.get("pl_covers", {}); }
function plGetCustomCover(id) { return plCustomCovers()[id] || null; }
function plSetCustomCover(id, dataUrl) {
  const m = plCustomCovers();
  if (dataUrl) m[id] = dataUrl; else delete m[id];
  LS.set("pl_covers", m);
}
function trackByRel(rel) { const id = relToId.get(rel); return id ? library.find((t) => t.id === id) : null; }
// 썸네일 img에 url을 걸되, 로드 성공 시에만 보이게(깨진 아이콘 방지 → 뒤의 ♪가 보임).
function setThumb(img, url) {
  if (!img) return;
  img.onload = img.onerror = null;
  if (url) {
    img.classList.remove("has-art");
    img.onload = () => img.classList.add("has-art");
    img.onerror = () => { img.removeAttribute("src"); img.classList.remove("has-art"); };
    img.src = url;
  } else { img.removeAttribute("src"); img.classList.remove("has-art"); }
}
// 플레이리스트 커버 URL을 콜백으로 전달: 커스텀 > 첫 곡 앨범커버 > null(=♪).
function plCoverUrl(pl, cb) {
  const custom = plGetCustomCover(pl.id);
  if (custom) return cb(custom);
  const first = pl.rel.length ? trackByRel(pl.rel[0]) : null;
  if (!first) return cb(null);
  getCachedCover(first).then((url) => {
    if (url) return cb(url);
    prefetchCover(first).then(() => getCachedCover(first).then((u) => cb(u || null)));   // 없으면 받아 캐시 후 갱신
  });
}

function renderPlaylists() {
  const box = $("#pl-list");
  const head = $(".pl-head");
  if (selectedPlaylistId) { if (head) head.hidden = true; box.classList.add("detail"); return renderPlaylistDetail(box); }
  if (head) head.hidden = false;
  box.classList.remove("detail");
  if (!playlists.length) { box.innerHTML = `<div class="pl-empty">플레이리스트가 없습니다.<br>+새로 만들어 곡을 담아보세요.</div>`; return; }
  box.innerHTML = playlists.map((p) => `
    <div class="pl-item" data-plopen="${p.id}">
      <div class="pl-thumb"><img class="pl-cover" data-plc="${p.id}" alt=""></div>
      <div class="pl-item-body">
        <div class="pl-item-name">${escapeHtml(p.name)}</div>
        <div class="pl-item-sub">${p.rel.length}곡</div>
      </div>
      <button class="pl-play-btn" data-plplay="${p.id}">▶</button>
    </div>`).join("");
  for (const p of playlists) {
    const img = box.querySelector(`.pl-cover[data-plc="${p.id}"]`);
    if (img) plCoverUrl(p, (url) => setThumb(img, url));
  }
}
function renderPlaylistDetail(box) {
  const pl = playlists.find((p) => p.id === selectedPlaylistId);
  if (!pl) { selectedPlaylistId = null; return renderPlaylists(); }
  const rows = pl.rel.map((rel, i) => {
    const t = trackByRel(rel);
    if (t && !t.enriched) queueEnrich(t);   // 태그 미확인 곡은 우선 읽어 실제 제목/아티스트로 갱신
    const title = t ? t.title : (rel.split("/").pop() || rel);
    const artist = t ? (t.artist || "알 수 없는 아티스트") : "라이브러리에 없음";
    return `<div class="pld-track${t ? "" : " missing"}" data-pos="${i}"${t ? ` data-id="${t.id}"` : ""}>
        <span class="pld-grip" data-grip="${i}" title="끌어서 순서 변경">⠿</span>
        <div class="track-body">
          <div class="track-title">${escapeHtml(title)}</div>
          <div class="track-artist">${escapeHtml(artist)}</div>
        </div>
        <button class="pld-remove" data-rm="${i}" title="목록에서 빼기">×</button>
      </div>`;
  }).join("") || `<div class="pl-empty">담긴 곡이 없습니다.<br>‘＋ 곡’으로 담아보세요.</div>`;
  box.innerHTML = `
    <div class="pld-head">
      <button class="pld-back" id="pl-back">‹</button>
      <div class="pld-name">${escapeHtml(pl.name)} <span class="pld-cnt">${pl.rel.length}곡</span></div>
      <button class="pld-icon" id="pl-refresh-btn" title="PC 변경 내용 불러오기">⟳</button>
      <button class="pld-icon" id="pl-cover-btn" title="커버 사진 설정">🖼</button>
      <button class="pld-icon" id="pl-del-btn" title="플레이리스트 삭제">🗑</button>
      <button class="pld-add" id="pl-add-btn">＋ 곡</button>
    </div>
    <div class="pld-list">${rows}</div>`;
}
// 새 곡을 특정 플레이리스트에 담는다(curIndex 안 건드림).
function addRelToPlaylist(pl, rel) {
  if (!rel) return false;
  if (pl.rel.includes(rel)) return false;
  pl.rel.push(rel); pl.ts = Date.now();
  savePlaylists();
  return true;
}
function removeFromPlaylistAt(pl, pos) {
  if (pos < 0 || pos >= pl.rel.length) return;
  pl.rel.splice(pos, 1); pl.ts = Date.now();
  savePlaylists(); renderPlaylists();
}

/* ── 곡 순서 바꾸기(손잡이 ⠿ 를 끌어서) ─────────────────────────────
   포인터 이벤트로 터치·마우스 모두 지원. 끄는 행은 손가락을 따라 이동하고,
   지나치는 행들은 자리를 비켜준다. 놓으면 새 순서를 rel에 반영·저장. */
let pldDrag = null;
function pldGripDown(e) {
  const grip = e.target.closest(".pld-grip");
  if (!grip) return;
  const row = grip.closest(".pld-track");
  const list = row && row.parentElement;
  if (!row || !list) return;
  e.preventDefault();
  const rows = Array.from(list.querySelectorAll(".pld-track"));
  const from = rows.indexOf(row);
  pldDrag = { row, rows, startY: e.clientY, height: row.getBoundingClientRect().height, from, cur: from };
  row.classList.add("dragging");
  row.setPointerCapture && row.setPointerCapture(e.pointerId);
  document.addEventListener("pointermove", pldGripMove);
  document.addEventListener("pointerup", pldGripUp);
  document.addEventListener("pointercancel", pldGripUp);
}
function pldGripMove(e) {
  const d = pldDrag; if (!d) return;
  const dy = e.clientY - d.startY;
  d.row.style.transform = `translateY(${dy}px)`;
  let target = d.from + Math.round(dy / d.height);
  target = Math.max(0, Math.min(d.rows.length - 1, target));
  if (target !== d.cur) {
    d.cur = target;
    d.rows.forEach((r, i) => {
      if (r === d.row) return;
      let shift = 0;
      if (d.from < target && i > d.from && i <= target) shift = -d.height;
      else if (d.from > target && i >= target && i < d.from) shift = d.height;
      r.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  }
}
function pldGripUp() {
  const d = pldDrag; if (!d) return;
  pldDrag = null;
  document.removeEventListener("pointermove", pldGripMove);
  document.removeEventListener("pointerup", pldGripUp);
  document.removeEventListener("pointercancel", pldGripUp);
  const pl = playlists.find((p) => p.id === selectedPlaylistId);
  if (pl && d.from !== d.cur) {
    const [moved] = pl.rel.splice(d.from, 1);
    pl.rel.splice(d.cur, 0, moved);
    pl.ts = Date.now();
    savePlaylists();
  }
  renderPlaylists();   // 트랜스폼 초기화 겸 새 순서로 다시 그림
}
// 현재 재생 곡을 플레이리스트에 담기(기존 진입점 유지 — 재생화면 ＋ 버튼용).
function addCurrentToPlaylist() {
  if (curIndex < 0) return toast("재생 중인 곡이 없습니다.");
  addTrackToPlaylist(library[curIndex]);
}
// 임의의 트랙을 담기: 대상 플레이리스트를 고르거나 새로 만든다(prompt).
function addTrackToPlaylist(track) {
  if (!track) return;
  const names = playlists.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const ans = prompt(`담을 플레이리스트 번호 (또는 새 이름 입력):\n${names || "(없음)"}`, "");
  if (ans == null) return;
  let pl = playlists[+ans - 1];
  if (!pl) { pl = { id: Date.now().toString(36), name: ans.trim() || "새 목록", rel: [], ts: Date.now() }; playlists.push(pl); }
  const added = addRelToPlaylist(pl, track.rel);
  renderPlaylists();
  toast(added ? `'${pl.name}'에 담았어요.` : `이미 '${pl.name}'에 있어요.`);
}

/* ── 재생 큐(플레이리스트를 순서대로) ── */
function playlistIndices(pl) {
  const out = [];
  for (const rel of pl.rel) {
    const id = relToId.get(rel);
    const idx = id ? library.findIndex((t) => t.id === id) : -1;
    if (idx >= 0) out.push(idx);
  }
  return out;
}
function playPlaylistFrom(pl, startRelPos) {
  const idxs = playlistIndices(pl);
  if (!idxs.length) return toast("재생할 수 있는 곡이 없습니다(라이브러리 새로고침 필요).");
  let qpos = 0;
  if (startRelPos != null) {   // rel 인덱스 → 큐(라이브러리에 있는 곡만) 위치로 환산
    for (let i = 0; i < startRelPos && i < pl.rel.length; i++) {
      const id = relToId.get(pl.rel[i]);
      if (id && library.some((t) => t.id === id)) qpos++;
    }
    if (qpos >= idxs.length) qpos = 0;
  }
  plQueue = idxs; plQueuePos = qpos;
  playByLibIndex(plQueue[plQueuePos]);
}
function playPlaylist(id) {
  const pl = playlists.find((p) => p.id === id);
  if (!pl || !pl.rel.length) return toast("빈 목록입니다.");
  playPlaylistFrom(pl, 0);
}
function deleteSelectedPlaylist() {
  const pl = playlists.find((p) => p.id === selectedPlaylistId);
  if (!pl) return;
  if (!confirm(`'${pl.name}' 플레이리스트를 삭제할까요?`)) return;
  playlists = playlists.filter((p) => p.id !== pl.id);
  plTombs[pl.id] = Date.now();          // 삭제 기록(PC에도 전파)
  plSetCustomCover(pl.id, null);
  selectedPlaylistId = null;
  savePlaylists(); renderPlaylists();
  toast("삭제했습니다.");
}
// 이미지를 정사각형으로 center-crop 후 size px로 줄여 data URL(JPEG)로 만든다.
function fileToCoverDataUrl(file, size, cb) {
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = size; c.height = size;
        const ctx = c.getContext("2d");
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        cb(c.toDataURL("image/jpeg", 0.85));
      } catch (_) { cb(null); }
    };
    img.onerror = () => cb(null);
    img.src = r.result;
  };
  r.onerror = () => cb(null);
  r.readAsDataURL(file);
}

/* ── '곡 추가' 피커(전체화면 오버레이) ── */
function openAddPicker() {
  if (!selectedPlaylistId) return;
  pickerPlId = selectedPlaylistId;
  const pl = playlists.find((p) => p.id === pickerPlId);
  $("#plp-name").textContent = pl ? pl.name : "";
  $("#plp-search").value = "";
  $("#pl-picker").hidden = false;
  renderPickerList("");
  try { history.pushState({ taPicker: 1 }, ""); } catch (_) {}
  $("#plp-search").focus();
}
function closeAddPicker() {
  const p = $("#pl-picker");
  if (p.hidden) return;
  p.hidden = true; pickerPlId = null;
  renderPlaylists();   // 담은 결과 반영
}
function renderPickerList(q) {
  const box = $("#plp-list");
  const pl = playlists.find((p) => p.id === pickerPlId);
  const has = new Set(pl ? pl.rel : []);
  q = (q || "").trim().toLowerCase();
  let list = library;
  if (q) list = library.filter((t) => (t.title || "").toLowerCase().includes(q) || (t.artist || "").toLowerCase().includes(q));
  const CAP = 200;
  const shown = list.slice(0, CAP);
  box.innerHTML = shown.map((t) => {
    const inp = has.has(t.rel);
    return `<div class="track" data-pick="${t.id}">
        <div class="track-body">
          <div class="track-title">${escapeHtml(t.title)}</div>
          <div class="track-artist">${escapeHtml(t.artist || "알 수 없는 아티스트")}</div>
        </div>
        <button class="track-add${inp ? " added" : ""}" data-pickadd="${t.id}">${inp ? "✓" : "＋"}</button>
      </div>`;
  }).join("") + (list.length > CAP ? `<div class="pl-empty">…외 ${list.length - CAP}곡. 검색으로 좁혀주세요.</div>` : "")
    || `<div class="pl-empty">검색 결과가 없습니다.</div>`;
}

/* ───────────────────── 화면 전환 ───────────────────── */
function openPlayer() {
  const p = $("#player");
  if (!p.hidden) return;
  // 히스토리 상태를 하나 쌓아, 안드로이드 '이전' 버튼이 앱을 나가는 대신
  // 이 상태를 되돌리며(popstate) 재생화면만 닫게 한다 → 앱 유지 → 재생 지속.
  try { history.pushState({ taPlayer: 1 }, ""); } catch (_) {}
  p.hidden = false;
  // 전체화면 재생 화면이 뜨는 동안 하단 미니바·설치 버튼은 숨긴다(화면 전체 차지).
  $("#mini").hidden = true;
  hideInstallFab();
  requestAnimationFrame(() => p.classList.add("up"));
}
function closePlayerUI() {
  const p = $("#player");
  if (p.hidden) return;
  p.classList.remove("up");
  setTimeout(() => {
    p.hidden = true;
    if (curIndex >= 0) $("#mini").hidden = false;   // 닫히면 미니바 복귀(재생 중일 때)
  }, 340);
}
function closePlayer() {
  // ▾ 닫기 버튼: 히스토리를 되돌려 popstate 경로로 닫음(상태 일관 유지).
  if (history.state && history.state.taPlayer) history.back();
  else closePlayerUI();
}
// 메인 화면에서 '이전'을 눌러도 바로 앱이 꺼지지 않도록 히스토리에 트랩을 하나 쌓는다.
function pushGuard() { try { history.pushState({ taGuard: 1 }, ""); } catch (_) {} }
function activePPanel() { return $(".ptab.active")?.dataset.ptab; }
function switchTab(tab) {
  activeTab = tab;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tabview").forEach((v) => (v.hidden = v.dataset.view !== tab));
  if (tab === "playlists") renderPlaylists();
}

/* ───────────────────── 태그 캐시 / 읽기 ───────────────────── */
// 캐시 버전 — toTrack 추정 방향을 고쳐서, 옛 캐시(제목·아티스트가 뒤바뀐)를 자동 폐기한다.
const LIB_CACHE_VER = 2;
function saveLibCache() { try { LS.set("lib_cache", { v: LIB_CACHE_VER, tracks: library }); } catch (_) {} }
function readLibCache() {
  const c = LS.get("lib_cache", null);
  return (c && c.v === LIB_CACHE_VER && Array.isArray(c.tracks)) ? c.tracks : null;
}
let saveTimer = null;
function persistLibrary() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLibCache, 600);
}

// 화면에 보이는 곡의 실제 태그를 읽어 목록/그리드를 채운다. 파일명 추정은 태그가
// 없거나 아직 안 읽었을 때만 남는 폴백이다. 커버는 제외하고 앞부분(~96KB)만 받아
// 가볍게, 동시 3개까지만. 결과는 영구 캐시.
const enrichPending = new Set();   // 대기/진행 중인 곡 id
let enrichActive = 0;
const enrichQueue = [];
const ENRICH_CONC = 6;   // 동시 태그 읽기 수(브라우저 호스트당 동시 연결 한도 안쪽)

function queueEnrich(t) {
  if (!t || t.enriched || enrichPending.has(t.id)) return;
  enrichPending.add(t.id);
  enrichQueue.push(t);
  pumpEnrich();
}
function pumpEnrich() {
  while (enrichActive < ENRICH_CONC && enrichQueue.length) {
    const t = enrichQueue.shift();
    enrichActive++;
    enrichOne(t).finally(() => {
      enrichActive--; enrichPending.delete(t.id); pumpEnrich();
    });
  }
}
async function enrichOne(t) {
  try {
    const buf = await fetchTagBytes(t.id, 32767);   // 32KB — 텍스트 프레임은 대개 태그 앞쪽(커버 앞)
    if (buf) {
      const m = parseID3(buf);
      if (m.title) t.title = m.title;
      if (m.artist) t.artist = m.artist;
      t.album = m.album || ""; t.year = m.year || ""; t.genre = m.genre || "";
      t.guessed = !(m.title || m.artist);   // 태그가 있으면 추정 해제
    }
  } catch (_) { return; }   // 실패 시 enriched 표시 안 함 → 다음에 다시 시도
  t.enriched = true;
  persistLibrary();
  updateRowInPlace(t);
}
// 로드 후 백그라운드로 '전 곡'의 태그를 미리 읽어 캐시에 채운다. 그러면 다음부턴
// 목록·재생 정보가 추정값 없이 처음부터 실제 태그로 뜬다(곡당 32KB, 한 번만·영구 캐시).
// 큐(동시 6개)로 처리하므로 재생/커버 프리페치와 함께 돌아도 무리가 없다.
function enrichAllBg() {
  for (const t of library) if (!t.enriched) queueEnrich(t);
}
// 이미 화면에 있는 행이면 값만 제자리 갱신(다시 그리지 않아 스크롤·깜빡임 없음).
function updateRowInPlace(t) {
  // 라이브러리 목록 + (열려 있으면) 플레이리스트 상세 — 같은 곡의 모든 행을 갱신.
  const rows = document.querySelectorAll(
    `#track-list .track[data-id="${t.id}"], #pl-list .pld-track[data-id="${t.id}"]`);
  rows.forEach((row) => {
    const ti = row.querySelector(".track-title");
    const ar = row.querySelector(".track-artist");
    if (ti) ti.textContent = t.title || "";
    if (ar) ar.textContent = t.artist || "알 수 없는 아티스트";
  });
}
// 앨범/연도/장르는 파일 태그에만 있어, 재생하지 않은 곡은 비어 있다. 원할 때
// 곡마다 태그 앞부분(커버 제외, ~96KB)만 받아 채운다. 결과는 영구 캐시.
async function enrichAll() {
  if (enriching) { enrichStop = true; return; }
  const todo = library.filter((t) => !t.enriched);
  if (!todo.length) return toast("이미 모든 곡 정보를 읽었습니다.");
  const est = Math.max(1, Math.round(todo.length * 96 / 1024));
  if (!confirm(`${todo.length}곡의 앨범·연도·장르를 읽습니다.\n대략 ${est}MB를 한 번만 받아 저장합니다(커버 제외).\n계속할까요?`)) return;
  enriching = true; enrichStop = false;
  updateEnrichBtn();
  const status = $("#lib-status");
  const queue = todo.slice();
  let done = 0;
  async function worker() {
    while (queue.length && !enrichStop) {
      const t = queue.shift();
      try {
        const buf = await fetchTagBytes(t.id, 98303);   // 96KB — 텍스트 프레임엔 충분
        if (buf) {
          const m = parseID3(buf);
          if (m.title) t.title = m.title;
          if (m.artist) t.artist = m.artist;
          t.album = m.album || ""; t.year = m.year || ""; t.genre = m.genre || "";
        }
      } catch (_) {}
      t.enriched = true; done++;
      if (done % 10 === 0) { status.textContent = `곡 정보 읽는 중… ${done}/${todo.length} (탭하면 중단)`; persistLibrary(); }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  enriching = false; persistLibrary();
  status.textContent = `${library.length}곡` + (enrichStop ? " · 중단됨(나머지는 다시 읽기 가능)" : "");
  updateEnrichBtn();
  applySearch();
}
// 앨범 보기/태그 정렬을 볼 때, 아직 안 읽은 곡이 있으면 '곡 정보 읽기' 버튼을 띄운다.
function updateEnrichBtn() {
  const btn = $("#btn-enrich");
  if (!btn) return;
  const tagView = viewMode === "album" || sortMode === "album" || sortMode === "year" || sortMode === "genre";
  const pending = library.some((t) => !t.enriched);
  btn.textContent = enriching ? "읽는 중… (중단)" : "곡 정보 읽기";
  btn.hidden = !(tagView && pending);
}

/* ───────────────────── 라이브러리 로딩 ───────────────────── */
async function loadLibrary(forceRefresh) {
  const status = $("#lib-status");
  const cached = readLibCache();
  if (cached && !forceRefresh) {
    library = cached; applySearch();
    status.textContent = `${library.length}곡 (캐시) · ⟳ 로 새로고침`;
    syncPlaylists();   // 라이브러리 준비됨 → 플레이리스트 동기화(rel 매핑 필요)
    enrichAllBg();     // 캐시에 아직 태그 없는 곡이 있으면 백그라운드로 마저 채운다
    return;
  }
  const paths = getFolderPaths();
  status.textContent = "음악 폴더 찾는 중…";
  $("#track-list").innerHTML = `<div class="spinner"></div>`;
  try {
    const rootIds = [], missing = [];
    for (const p of paths) {
      const id = await resolveFolderPath(p);
      if (id) rootIds.push(id); else missing.push(p);
    }
    if (!rootIds.length) {
      status.textContent = "";
      $("#track-list").innerHTML = `<li class="entries-empty">음악 폴더를 찾지 못했습니다:<br>${
        paths.map(escapeHtml).join("<br>")}<br><br>상단 📁 로 경로를 확인/수정하세요.<br>(My Drive 기준, 예: Junho's Data/취미/음악)</li>`;
      return;
    }
    library = await listFolderAudio(rootIds, (n) => (status.textContent = `불러오는 중… ${n}곡`));
    saveLibCache();
    applySearch();
    status.textContent = `${library.length}곡` + (missing.length ? ` · ⚠️ 못 찾은 폴더: ${missing.join(", ")}` : "");
    plParentId = rootIds[0];           // 공용 플레이리스트 파일을 둘 음악 루트 폴더
    LS.set("pl_parent", plParentId);   // 캐시 로드 시 재사용
    syncPlaylists();                   // 플레이리스트 PC와 동기화
    enrichAllBg();                     // 전 곡 태그를 백그라운드로 미리 읽어 캐시(처음부터 실제 태그)
  } catch (e) {
    status.textContent = "";
    $("#track-list").innerHTML = `<li class="entries-empty">목록 로딩 실패: ${escapeHtml(e.message)}</li>`;
  }
}
// 음악 폴더 경로 편집(로그인 후 📁 버튼) → 다시 스캔.
function editFolders() {
  const ans = prompt("음악 폴더 경로 (My Drive 기준, 한 줄에 하나):", getFolderPaths().join("\n"));
  if (ans == null) return;
  const arr = ans.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!arr.length) return;
  setFolderPaths(arr);
  loadLibrary(true);
}

/* ───────────────────── 인증 흐름 ───────────────────── */
async function signIn() {
  const id = $("#client-id").value.trim();
  if (!id) return showAuthError("클라이언트 ID를 입력하세요.");
  CLIENT_ID = id; LS.set("client_id", id);
  const fp = $("#folder-paths").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (fp.length) setFolderPaths(fp);
  try {
    if (!tokenClient) await initToken();
    await requestToken(true);
    enterApp();
  } catch (e) { showAuthError("로그인 실패: " + e.message); }
}
function showAuthError(msg) { const el = $("#auth-error"); el.textContent = msg; el.hidden = false; }
function enterApp() {
  $("#screen-auth").hidden = true;
  $("#screen-main").hidden = false;
  if (!appEntered) { appEntered = true; pushGuard(); }  // '이전' 버튼 트랩 시작
  acquireWakeLock();    // 앱을 쓰는 동안 화면이 꺼지지 않게
  loadLibrary(false);   // 로드가 끝나면 내부에서 syncPlaylists()가 플레이리스트를 PC와 동기화
}

// 화면 꺼짐 방지(Wake Lock). 화면이 잠기거나 탭이 숨으면 락이 자동 해제되므로,
// 다시 보일 때 재획득한다. 미지원 기기(구형 iOS 등)에서는 조용히 무시.
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (_) { wakeLock = null; }
}
function signOut() {
  accessToken = ""; tokenExp = 0; LS.set("signed_in", false); LS.set("token", null);
  if (window.google?.accounts?.oauth2 && accessToken) google.accounts.oauth2.revoke(accessToken);
  audio.pause();
  location.reload();
}

/* ───────────────────── 이벤트 바인딩 ───────────────────── */
function bind() {
  $$(".ver").forEach((el) => (el.textContent = APP_VERSION));
  $("#client-id").value = CLIENT_ID;
  $("#folder-paths").value = getFolderPaths().join("\n");
  $("#btn-signin").addEventListener("click", signIn);
  $("#install-fab").addEventListener("click", async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (_) {}
      deferredPrompt = null; hideInstallFab();
      return;
    }
    // 네이티브 프롬프트가 없는 경우(iOS 등) → 수동 안내
    if (isIOS()) alert("Safari 하단의 공유 버튼(□↑)을 누른 뒤 '홈 화면에 추가'를 선택하세요.");
    else alert("브라우저 메뉴(⋮)에서 '앱 설치' 또는 '홈 화면에 추가'를 누르세요.");
  });
  $("#btn-folders").addEventListener("click", editFolders);
  $("#btn-refresh").addEventListener("click", () => loadLibrary(true));
  $("#btn-signout").addEventListener("click", signOut);
  $("#search").addEventListener("input", applySearch);

  // 정렬 / 보기 전환 / 곡 정보 읽기
  const sortSel = $("#sort-mode");
  sortSel.value = sortMode;
  sortSel.addEventListener("change", () => {
    sortMode = sortSel.value; LS.set("sort_mode", sortMode); applySearch();
  });
  $$(".vt-btn").forEach((b) => b.addEventListener("click", () => {
    viewMode = b.dataset.viewMode;
    $$(".vt-btn").forEach((x) => x.classList.toggle("active", x === b));
    applySearch();
  }));
  $("#btn-enrich").addEventListener("click", enrichAll);

  // 목록 가상화: 스크롤하면 보이는 구간만 다시 그린다.
  $("#track-list").addEventListener("scroll", () => renderWindow(false), { passive: true });
  window.addEventListener("resize", () => renderWindow(true));

  // 트랙 목록 / 앨범 카드: 재생 / 담기
  $("#track-list").addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) { e.stopPropagation(); const t = library.find((x) => x.id === add.dataset.add); if (t) addTrackToPlaylist(t); return; }
    const card = e.target.closest(".album-card");
    if (card) {
      const firstId = card.dataset.ids.split(",")[0];
      plQueue = null;   // 라이브러리에서 직접 재생 → 플레이리스트 큐 해제
      playByLibIndex(library.findIndex((t) => t.id === firstId));
      openPlayer();
      return;
    }
    const li = e.target.closest(".track"); if (!li) return;
    plQueue = null;
    playByLibIndex(library.findIndex((t) => t.id === li.dataset.id));
    openPlayer();
  });

  // 하단 탭
  $$(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // 플레이리스트
  $("#btn-pl-new").addEventListener("click", () => {
    const name = prompt("새 플레이리스트 이름"); if (!name) return;
    playlists.push({ id: Date.now().toString(36), name: name.trim(), rel: [], ts: Date.now() });
    savePlaylists(); renderPlaylists();
  });
  $("#btn-pl-refresh").addEventListener("click", refreshPlaylists);
  $("#pl-list").addEventListener("pointerdown", pldGripDown);
  $("#pl-list").addEventListener("click", (e) => {
    if (e.target.closest(".pld-grip")) return;   // 손잡이 탭은 무시(순서 변경 전용)
    const play = e.target.closest("[data-plplay]");
    if (play) { e.stopPropagation(); playPlaylist(play.dataset.plplay); openPlayer(); return; }
    const open = e.target.closest("[data-plopen]");
    if (open) { selectedPlaylistId = open.dataset.plopen; renderPlaylists(); return; }
    if (e.target.closest("#pl-back")) { selectedPlaylistId = null; renderPlaylists(); return; }
    if (e.target.closest("#pl-refresh-btn")) { refreshPlaylists(); return; }
    if (e.target.closest("#pl-add-btn")) { openAddPicker(); return; }
    if (e.target.closest("#pl-cover-btn")) { pendingCoverPl = selectedPlaylistId; $("#pl-cover-file").click(); return; }
    if (e.target.closest("#pl-del-btn")) { deleteSelectedPlaylist(); return; }
    const rm = e.target.closest(".pld-remove");
    if (rm) { e.stopPropagation(); const pl = playlists.find((p) => p.id === selectedPlaylistId); if (pl) removeFromPlaylistAt(pl, parseInt(rm.dataset.rm)); return; }
    const row = e.target.closest(".pld-track");
    if (row) { const pl = playlists.find((p) => p.id === selectedPlaylistId); if (pl) { playPlaylistFrom(pl, parseInt(row.dataset.pos)); openPlayer(); } return; }
  });
  // '곡 추가' 피커
  $("#plp-close").addEventListener("click", () => { if (history.state && history.state.taPicker) history.back(); else closeAddPicker(); });
  let pickerSearchT = null;
  $("#plp-search").addEventListener("input", (e) => {
    clearTimeout(pickerSearchT);
    const v = e.target.value;
    pickerSearchT = setTimeout(() => renderPickerList(v), 150);
  });
  $("#plp-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pickadd]");
    if (!b) return;
    const pl = playlists.find((p) => p.id === pickerPlId);
    const t = library.find((x) => x.id === b.dataset.pickadd);
    if (!pl || !t) return;
    if (addRelToPlaylist(pl, t.rel)) { b.textContent = "✓"; b.classList.add("added"); toast("담았어요."); }
    else toast("이미 담겨 있어요.");
  });

  // 커버 사진 선택 → 정사각 400px로 축소해 로컬 저장(동기화 안 함, 용량 최소화).
  const coverFile = $("#pl-cover-file");
  if (coverFile) coverFile.addEventListener("change", () => {
    const f = coverFile.files && coverFile.files[0]; coverFile.value = "";
    if (!f || !pendingCoverPl) return;
    const pid = pendingCoverPl; pendingCoverPl = null;
    fileToCoverDataUrl(f, 400, (url) => {
      if (!url) return toast("이미지를 불러오지 못했습니다.");
      plSetCustomCover(pid, url);
      if (activeTab === "playlists") renderPlaylists();
      toast("커버를 설정했습니다.");
    });
  });

  // 미니 플레이어
  $("#mini").addEventListener("click", (e) => { if (!e.target.closest(".mini-btn")) openPlayer(); });
  $("#mini-play").addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
  $("#mini-next").addEventListener("click", (e) => { e.stopPropagation(); nextTrack(false); });

  // 미디어 알림을 탭하면 앱이 포그라운드로 온다 → 재생 중이면 전체 재생화면을 편다.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (appEntered) acquireWakeLock();   // 화면 꺼짐 방지 락은 숨김 시 해제되므로 재획득
    if (curIndex >= 0 && !audio.paused && $("#player").hidden) openPlayer();
  });

  // 안드로이드 '이전' 버튼: 앱을 닫지 않는다(음악 유지 우선).
  //  · 전체 재생화면 열림 → 그것만 닫고 라이브러리로
  //  · 어느 경우든 히스토리 트랩을 다시 세워 '이전'으로 앱이 종료되지 않게 함
  //  → 완전히 끄려면 홈(백그라운드 재생 유지) 또는 '최근 앱'에서 밀기.
  window.addEventListener("popstate", () => {
    if (!$("#pl-picker").hidden) { closeAddPicker(); pushGuard(); return; }   // 피커 먼저 닫기
    if (!$("#player").hidden) { closePlayerUI(); pushGuard(); return; }
    if (selectedPlaylistId && activeTab === "playlists") { selectedPlaylistId = null; renderPlaylists(); pushGuard(); return; }
    if (!LS.get("back_hint", false)) {   // 메인에서 첫 '이전' 때 한 번만 안내
      toast("홈 버튼으로 나가면 음악이 계속 재생됩니다");
      LS.set("back_hint", true);
    }
    pushGuard();
  });

  // 전체 재생 화면
  $("#player-close").addEventListener("click", closePlayer);
  $("#player-add").addEventListener("click", addCurrentToPlaylist);
  $$(".ptab").forEach((b) => b.addEventListener("click", () => {
    $$(".ptab").forEach((x) => x.classList.remove("active")); b.classList.add("active");
    $$(".ppanel").forEach((p) => (p.hidden = p.dataset.ppanel !== b.dataset.ptab));
    if (b.dataset.ptab === "lyrics") { curLyricLine = -1; syncLyrics(); }
  }));
  $("#btn-play").addEventListener("click", togglePlay);
  $("#btn-next").addEventListener("click", () => nextTrack(false));
  $("#btn-prev").addEventListener("click", prevTrack);
  $("#btn-shuffle").addEventListener("click", (e) => { shuffle = !shuffle; e.currentTarget.classList.toggle("dim", !shuffle); });
  $("#btn-repeat").addEventListener("click", (e) => {
    repeat = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
    e.currentTarget.textContent = repeat === "one" ? "🔂" : "🔁";
    e.currentTarget.classList.toggle("dim", repeat === "off");
  });
  $("#btn-shuffle").classList.add("dim"); $("#btn-repeat").classList.add("dim");

  // 공간감/울림 효과 — 클릭은 사용자 제스처라 AudioContext resume이 허용된다.
  const fxrow = $("#fxrow");
  if (fxrow) fxrow.addEventListener("click", (e) => {
    const b = e.target.closest(".fx-btn"); if (!b) return;
    if (b.id === "fx-norm") { applyNormalize(!b.classList.contains("active"), true); return; }
    applySpace(b.dataset.fx, true);
  });
  reflectSpaceUI(LS.get("space_fx", "off"));   // 저장된 설정 표시(그래프는 첫 재생/토글 때 생성)
  reflectNormUI(!!LS.get("norm_fx", ""));

  // 시크바
  const seek = $("#seek");
  seek.addEventListener("input", () => { seeking = true; $("#cur-time").textContent = fmtTime((seek.value / 1000) * (audio.duration || 0)); });
  seek.addEventListener("change", () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });

  // 오디오 이벤트 — 크로스페이드용으로 요소가 2개라, 둘 다에 붙이고
  // '활성' 요소(audio)의 이벤트만 UI에 반영한다. 페이드 중 물러나는 요소가
  // 내는 pause/timeupdate는 무시된다.
  bindAudioEvents(audio);
  bindAudioEvents(spare);
}

function bindAudioEvents(el) {
  el.addEventListener("play", function () {
    if (this !== audio) return;
    $("#mini-play").textContent = "❚❚"; $("#btn-play").textContent = "❚❚";
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    updatePositionState();
  });
  el.addEventListener("pause", function () {
    if (this !== audio) return;
    $("#mini-play").textContent = "▶"; $("#btn-play").textContent = "▶";
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  });
  el.addEventListener("ended", function () { if (this === audio) nextTrack(true); });
  el.addEventListener("loadedmetadata", function () { if (this === audio) updatePositionState(); });
  el.addEventListener("timeupdate", function () {
    if (this !== audio) return;
    const seek = $("#seek");
    const d = audio.duration || 0, c = audio.currentTime || 0;
    if (!seeking && d) { seek.value = Math.round((c / d) * 1000); $("#cur-time").textContent = fmtTime(c); }
    $("#dur-time").textContent = fmtTime(d);
    $("#mini-prog").firstElementChild.style.width = d ? (c / d * 100) + "%" : "0";
    if (++posTick % 8 === 0) updatePositionState();   // 약 2초마다 잠금화면 진행바 갱신
    // 곡 끝 CROSSFADE_MS 전에 다음 곡으로 미리 넘어가 겹치게 한다(AIMP식).
    // 볼륨 조절이 되는 기기에서만(iOS는 즉시 전환). repeat one은 제외.
    if (crossfadeOK && !advancing && repeat !== "one" && d && c > 1
        && (d - c) <= CROSSFADE_MS / 1000) {
      advancing = true;
      nextTrack(true);
    }
    syncLyrics();
  });
}

/* ───────────────────── 시작 ───────────────────── */
async function main() {
  bind();
  // iOS Safari는 beforeinstallprompt가 없다. 설치 전(브라우저 실행)이면 버튼을 띄워
  // 수동 안내로라도 설치를 돕는다. 이미 설치돼 실행 중이면 숨긴다.
  if (!isStandalone() && isIOS()) showInstallFab();
  if ("serviceWorker" in navigator) {
    // updateViaCache:"none" — sw.js를 HTTP 캐시 없이 항상 새로 받아 갱신을 확인한다.
    // (GitHub Pages의 max-age=600 때문에 안 그러면 최대 10분간 옛 SW가 유지됨)
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .then((reg) => { try { reg.update(); } catch (_) {} }).catch(() => {});
    // 새 서비스워커가 제어를 넘겨받으면(=코드 갱신) 자동으로 한 번만 새로고침.
    let swReloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (swReloaded) return; swReloaded = true; location.reload();
    });
  }
  // 이전에 로그인한 적이 있으면 로그인 화면 없이 진입 시도.
  if (CLIENT_ID && LS.get("signed_in", false)) {
    // 1) 저장된 토큰이 아직 유효 → 즉시 진입(네트워크·구글 세션 불필요).
    if (accessToken && Date.now() < tokenExp) {
      sendTokenToSW();
      enterApp();
      initToken().catch(() => {});   // 나중 토큰 갱신에 대비해 백그라운드 준비
      return;
    }
    // 2) 만료됐으면 구글 세션으로 조용히 재발급(비번·동의창 없음).
    try { await initToken(); await requestToken(false); enterApp(); return; }
    catch { /* 조용히 실패 → 로그인 화면(원탭) */ }
  }
}
main();
