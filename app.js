/* Templum Artis Music — PWA 프론트엔드.
   Google Drive의 음악을 스트리밍 재생하고, MP3 태그(USLT)에 심어둔 싱크 가사를
   재생에 맞춰 표시한다. 백엔드 없이 브라우저에서 Drive API를 직접 호출한다. */
"use strict";

/* ───────────────────── 유틸 ───────────────────── */
const APP_VERSION = "v7";   // 화면에 표시 — 폰이 최신 코드인지 눈으로 확인용
const CROSSFADE_MS = 800;   // 곡 전환 시 교차 페이드 길이(데스크톱과 동일)
const FADE_STEP_MS = 40;    // 페이드 갱신 간격
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
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
let shuffle = false, repeat = "off";  // off|all|one
let lyrics = null;           // [{t, text}] | {plain}
let curLyricLine = -1;
let playlists = LS.get("playlists", []);
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
function toTrack(f) {
  const stem = f.name.replace(/\.[^.]+$/, "");
  const dash = stem.indexOf(" - ");
  return { id: f.id, name: f.name, size: +f.size || 0,
    title: dash > 0 ? stem.slice(0, dash) : stem,
    artist: dash > 0 ? stem.slice(dash + 3) : "" };
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
async function listFolderAudio(rootIds, onProgress) {
  const out = [], seen = new Set(), queue = [...rootIds];
  while (queue.length) {
    const parent = queue.shift();
    let pageToken = "";
    do {
      const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}` +
        `&fields=nextPageToken,files(id,name,size,mimeType)&pageSize=1000&orderBy=name&spaces=drive` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const data = await driveFetch(url, false);
      for (const f of data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") { queue.push(f.id); continue; }
        if (isAudioFile(f) && !seen.has(f.id)) { seen.add(f.id); out.push(toTrack(f)); }
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

async function playByLibIndex(i, opts = {}) {
  if (i < 0 || i >= library.length) return;
  advancing = false;                 // 자동 크로스페이드 예약 해제(새 곡 시작)
  curIndex = i;
  const track = library[i];
  $("#mini").hidden = false;
  setNowPlaying({ title: track.title, artist: track.artist, album: track.album || "",
                  year: track.year, genre: track.genre, cover: null });
  updateMediaSession(track.title, track.artist, track.album || "", null);   // 잠금화면 즉시(태그 전)
  $("#mini-play").textContent = "…"; $("#btn-play").textContent = "…";
  lyrics = null; curLyricLine = -1;
  refresh();
  $("#lyrics").innerHTML = `<div class="spinner"></div>`;

  try {
    await ensureToken();
    sendTokenToSW();   // <audio> 요청 전에 SW가 토큰을 갖고 있도록
    // 스트리밍 재생 — SW가 Authorization을 주입하므로 Drive URL을 직접 <audio>에.
    if (curObjectUrl) { URL.revokeObjectURL(curObjectUrl); curObjectUrl = null; }
    startPlayback(driveUrl(track.id), opts.crossfade !== false);
    // 메타/커버/가사 — 파일 앞부분(태그)만 받아 파싱(전체 다운로드 없음).
    const buf = await fetchTagBytes(track.id);
    if (i !== curIndex) return;   // 그새 다른 곡으로 넘어갔으면 무시
    if (buf) {
      const m = parseID3(buf);
      const title = m.title || track.title, artist = m.artist || track.artist;
      track.title = title; track.artist = artist;
      track.album = m.album || ""; track.year = m.year || ""; track.genre = m.genre || "";
      track.enriched = true;
      persistLibrary();               // 읽은 태그를 캐시에 저장(다음엔 앨범/정렬에 바로 반영)
      if (curCoverUrl) { URL.revokeObjectURL(curCoverUrl); curCoverUrl = null; }
      if (m.cover) curCoverUrl = URL.createObjectURL(new Blob([m.cover.data], { type: m.cover.mime }));
      setNowPlaying({ title, artist, album: m.album, year: m.year, genre: m.genre, cover: curCoverUrl });
      setLyrics(m.uslt);
      updateMediaSession(title, artist, m.album, curCoverUrl);
      refresh();
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
  const art = cover || "";
  $("#mini-art").src = art; $("#cover").src = art;
  $("#mini-art").style.visibility = art ? "visible" : "hidden";
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
  if (!library.length) return;
  if (repeat === "one" && auto) { audio.currentTime = 0; audio.play(); return; }
  let n;
  if (shuffle) { do { n = Math.floor(Math.random() * library.length); } while (library.length > 1 && n === curIndex); }
  else { n = curIndex + 1; if (n >= library.length) { if (repeat !== "all" && auto) return; n = 0; } }
  playByLibIndex(n);
}
function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
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

/* ───────────────────── 플레이리스트 ───────────────────── */
function savePlaylists() { LS.set("playlists", playlists); }
function renderPlaylists() {
  const box = $("#pl-list");
  if (!playlists.length) { box.innerHTML = `<div class="pl-empty">플레이리스트가 없습니다.<br>+새로 만들어 곡을 담아보세요.</div>`; return; }
  box.innerHTML = playlists.map((p) => `
    <div class="pl-item" data-pl="${p.id}">
      <div class="track-thumb">≡</div>
      <div class="pl-item-body">
        <div class="pl-item-name">${escapeHtml(p.name)}</div>
        <div class="pl-item-sub">${p.ids.length}곡</div>
      </div>
      <button class="track-add" data-plplay="${p.id}">▶</button>
    </div>`).join("");
}
function addCurrentToPlaylist() {
  if (curIndex < 0) return toast("재생 중인 곡이 없습니다.");
  const track = library[curIndex];
  const names = playlists.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const ans = prompt(`담을 플레이리스트 번호 (또는 새 이름 입력):\n${names || "(없음)"}`, "");
  if (ans == null) return;
  let pl = playlists[+ans - 1];
  if (!pl) { pl = { id: Date.now().toString(36), name: ans.trim() || "새 목록", ids: [] }; playlists.push(pl); }
  if (!pl.ids.includes(track.id)) pl.ids.push(track.id);
  savePlaylists(); renderPlaylists(); toast(`'${pl.name}'에 담았어요.`);
}
function playPlaylist(id) {
  const pl = playlists.find((p) => p.id === id); if (!pl || !pl.ids.length) return toast("빈 목록입니다.");
  const first = library.findIndex((t) => t.id === pl.ids[0]);
  if (first >= 0) playByLibIndex(first); else toast("곡을 찾을 수 없습니다(라이브러리 새로고침 필요).");
}

/* ───────────────────── 화면 전환 ───────────────────── */
function openPlayer() {
  const p = $("#player");
  if (!p.hidden) return;
  // 히스토리 상태를 하나 쌓아, 안드로이드 '이전' 버튼이 앱을 나가는 대신
  // 이 상태를 되돌리며(popstate) 재생화면만 닫게 한다 → 앱 유지 → 재생 지속.
  try { history.pushState({ taPlayer: 1 }, ""); } catch (_) {}
  p.hidden = false;
  requestAnimationFrame(() => p.classList.add("up"));
}
function closePlayerUI() {
  const p = $("#player");
  if (p.hidden) return;
  p.classList.remove("up");
  setTimeout(() => (p.hidden = true), 340);
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

/* ───────────────────── 태그 캐시 / 일괄 읽기 ───────────────────── */
let saveTimer = null;
function persistLibrary() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { LS.set("lib_cache", library); } catch (_) {} }, 600);
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
  const cached = LS.get("lib_cache", null);
  if (cached && !forceRefresh) {
    library = cached; applySearch();
    status.textContent = `${library.length}곡 (캐시) · ⟳ 로 새로고침`;
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
    LS.set("lib_cache", library);
    applySearch();
    status.textContent = `${library.length}곡` + (missing.length ? ` · ⚠️ 못 찾은 폴더: ${missing.join(", ")}` : "");
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
  loadLibrary(false);
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
    if (add) { e.stopPropagation(); const t = library.find((x) => x.id === add.dataset.add); if (t) { curIndex = library.indexOf(t); addCurrentToPlaylist(); } return; }
    const card = e.target.closest(".album-card");
    if (card) {
      const firstId = card.dataset.ids.split(",")[0];
      playByLibIndex(library.findIndex((t) => t.id === firstId));
      openPlayer();
      return;
    }
    const li = e.target.closest(".track"); if (!li) return;
    playByLibIndex(library.findIndex((t) => t.id === li.dataset.id));
    openPlayer();
  });

  // 하단 탭
  $$(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // 플레이리스트
  $("#btn-pl-new").addEventListener("click", () => {
    const name = prompt("새 플레이리스트 이름"); if (!name) return;
    playlists.push({ id: Date.now().toString(36), name: name.trim(), ids: [] });
    savePlaylists(); renderPlaylists();
  });
  $("#pl-list").addEventListener("click", (e) => {
    const play = e.target.closest("[data-plplay]");
    if (play) { playPlaylist(play.dataset.plplay); openPlayer(); return; }
  });

  // 미니 플레이어
  $("#mini").addEventListener("click", (e) => { if (!e.target.closest(".mini-btn")) openPlayer(); });
  $("#mini-play").addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
  $("#mini-next").addEventListener("click", (e) => { e.stopPropagation(); nextTrack(false); });

  // 미디어 알림을 탭하면 앱이 포그라운드로 온다 → 재생 중이면 전체 재생화면을 편다.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && curIndex >= 0 && !audio.paused && $("#player").hidden) {
      openPlayer();
    }
  });

  // 안드로이드 '이전' 버튼: 앱을 닫지 않는다(음악 유지 우선).
  //  · 전체 재생화면 열림 → 그것만 닫고 라이브러리로
  //  · 어느 경우든 히스토리 트랩을 다시 세워 '이전'으로 앱이 종료되지 않게 함
  //  → 완전히 끄려면 홈(백그라운드 재생 유지) 또는 '최근 앱'에서 밀기.
  window.addEventListener("popstate", () => {
    if (!$("#player").hidden) { closePlayerUI(); pushGuard(); return; }
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
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then((reg) => { try { reg.update(); } catch (_) {} }).catch(() => {});
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
