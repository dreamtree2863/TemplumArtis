/* Templum Artis Music — PWA 프론트엔드.
   Google Drive의 음악을 스트리밍 재생하고, MP3 태그(USLT)에 심어둔 싱크 가사를
   재생에 맞춰 표시한다. 백엔드 없이 브라우저에서 Drive API를 직접 호출한다. */
"use strict";

/* ───────────────────── 유틸 ───────────────────── */
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
let library = [];            // [{id, name, title, artist, size}]
let filtered = [];
let curIndex = -1;
let curObjectUrl = null;
let shuffle = false, repeat = "off";  // off|all|one
let lyrics = null;           // [{t, text}] | {plain}
let curLyricLine = -1;
let playlists = LS.get("playlists", []);
let activeTab = "library";

const audio = $("#audio");

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
  navigator.serviceWorker.ready.then((reg) => {
    (navigator.serviceWorker.controller || reg.active)?.postMessage({ type: "token", token: accessToken });
  }).catch(() => {});
}
// 태그(메타/커버/USLT)만 파싱하려고 파일 앞부분(ID3v2 영역)만 Range로 받는다.
async function fetchTagBytes(fileId) {
  const token = await ensureToken();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Range: "bytes=0-1048575" }, cache: "no-store" });
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
function applySearch() {
  const q = $("#search").value.trim().toLowerCase();
  filtered = q
    ? library.filter((t) => (t.title + " " + t.artist + " " + t.name).toLowerCase().includes(q))
    : library.slice();
  renderList();
}
function renderList() {
  const ul = $("#track-list");
  if (!filtered.length) {
    ul.innerHTML = `<li class="entries-empty">${library.length ? "검색 결과가 없습니다." : "곡이 없습니다."}</li>`;
    return;
  }
  ul.innerHTML = filtered.map((t) => {
    const playing = t.id === library[curIndex]?.id ? " playing" : "";
    return `<li class="track${playing}" data-id="${t.id}">
      <div class="track-thumb">♪</div>
      <div class="track-body">
        <div class="track-title">${escapeHtml(t.title)}</div>
        <div class="track-artist">${escapeHtml(t.artist || "알 수 없는 아티스트")}</div>
      </div>
      <button class="track-add" data-add="${t.id}">＋</button>
    </li>`;
  }).join("");
}

/* ───────────────────── 재생 ───────────────────── */
async function playByLibIndex(i) {
  if (i < 0 || i >= library.length) return;
  curIndex = i;
  const track = library[i];
  $("#mini").hidden = false;
  setNowPlaying({ title: track.title, artist: track.artist, album: "", cover: null });
  $("#mini-play").textContent = "…"; $("#btn-play").textContent = "…";
  lyrics = null; curLyricLine = -1;
  renderList();
  $("#lyrics").innerHTML = `<div class="spinner"></div>`;

  try {
    await ensureToken();
    sendTokenToSW();   // <audio> 요청 전에 SW가 토큰을 갖고 있도록
    // 스트리밍 재생 — SW가 Authorization을 주입하므로 Drive URL을 직접 <audio>에.
    if (curObjectUrl) { URL.revokeObjectURL(curObjectUrl); curObjectUrl = null; }
    audio.src = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media&supportsAllDrives=true`;
    audio.play().catch(() => {});
    // 메타/커버/가사 — 파일 앞부분(태그)만 받아 파싱(전체 다운로드 없음).
    const buf = await fetchTagBytes(track.id);
    if (i !== curIndex) return;   // 그새 다른 곡으로 넘어갔으면 무시
    if (buf) {
      const m = parseID3(buf);
      const title = m.title || track.title, artist = m.artist || track.artist;
      library[i].title = title; library[i].artist = artist;
      if (curCoverUrl) { URL.revokeObjectURL(curCoverUrl); curCoverUrl = null; }
      if (m.cover) curCoverUrl = URL.createObjectURL(new Blob([m.cover.data], { type: m.cover.mime }));
      setNowPlaying({ title, artist, album: m.album, cover: curCoverUrl });
      setLyrics(m.uslt);
      updateMediaSession(title, artist, m.album, curCoverUrl);
      renderList();
    }
  } catch (e) {
    toast("재생 실패: " + e.message);
    $("#mini-play").textContent = "▶"; $("#btn-play").textContent = "▶";
  }
}
function setNowPlaying({ title, artist, album, cover }) {
  $("#mini-title").textContent = title || "—";
  $("#mini-artist").textContent = artist || "";
  $("#np-title").textContent = title || "—";
  $("#np-artist").textContent = artist || "";
  $("#np-album").textContent = [album, ""].filter(Boolean).join("");
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
  const at = audio.currentTime * 1000 + 250;   // 살짝 앞당김
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
  if (audio.paused) audio.play(); else audio.pause();
}

/* 미디어세션(잠금화면/헤드셋 컨트롤) */
function updateMediaSession(title, artist, album, cover) {
  if (!("mediaSession" in navigator)) return;
  const artwork = cover ? [{ src: cover, sizes: "512x512", type: "image/jpeg" }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
  navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack(false));
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
function openPlayer() { const p = $("#player"); p.hidden = false; requestAnimationFrame(() => p.classList.add("up")); }
function closePlayer() { const p = $("#player"); p.classList.remove("up"); setTimeout(() => (p.hidden = true), 340); }
function activePPanel() { return $(".ptab.active")?.dataset.ptab; }
function switchTab(tab) {
  activeTab = tab;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tabview").forEach((v) => (v.hidden = v.dataset.view !== tab));
  if (tab === "playlists") renderPlaylists();
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
  loadLibrary(false);
}
function signOut() {
  accessToken = ""; tokenExp = 0; LS.set("signed_in", false);
  if (window.google?.accounts?.oauth2 && accessToken) google.accounts.oauth2.revoke(accessToken);
  audio.pause();
  location.reload();
}

/* ───────────────────── 이벤트 바인딩 ───────────────────── */
function bind() {
  $("#client-id").value = CLIENT_ID;
  $("#folder-paths").value = getFolderPaths().join("\n");
  $("#btn-signin").addEventListener("click", signIn);
  $("#btn-folders").addEventListener("click", editFolders);
  $("#btn-refresh").addEventListener("click", () => loadLibrary(true));
  $("#btn-signout").addEventListener("click", signOut);
  $("#search").addEventListener("input", applySearch);

  // 트랙 목록: 재생 / 담기
  $("#track-list").addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) { e.stopPropagation(); const t = library.find((x) => x.id === add.dataset.add); if (t) { curIndex = library.indexOf(t); addCurrentToPlaylist(); } return; }
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
  const seek = $("#seek"); let seeking = false;
  seek.addEventListener("input", () => { seeking = true; $("#cur-time").textContent = fmtTime((seek.value / 1000) * (audio.duration || 0)); });
  seek.addEventListener("change", () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; seeking = false; });

  // 오디오 이벤트
  audio.addEventListener("play", () => { $("#mini-play").textContent = "❚❚"; $("#btn-play").textContent = "❚❚"; });
  audio.addEventListener("pause", () => { $("#mini-play").textContent = "▶"; $("#btn-play").textContent = "▶"; });
  audio.addEventListener("ended", () => nextTrack(true));
  audio.addEventListener("timeupdate", () => {
    const d = audio.duration || 0, c = audio.currentTime || 0;
    if (!seeking && d) { seek.value = Math.round((c / d) * 1000); $("#cur-time").textContent = fmtTime(c); }
    $("#dur-time").textContent = fmtTime(d);
    $("#mini-prog").firstElementChild.style.width = d ? (c / d * 100) + "%" : "0";
    syncLyrics();
  });
}

/* ───────────────────── 시작 ───────────────────── */
async function main() {
  bind();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  // 이전에 로그인했고 클라이언트 ID가 있으면 조용히 재로그인 시도
  if (CLIENT_ID && LS.get("signed_in", false)) {
    try { await initToken(); await requestToken(false); enterApp(); return; }
    catch { /* 조용히 실패 → 로그인 화면 */ }
  }
}
main();
