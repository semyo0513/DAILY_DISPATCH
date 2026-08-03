/* ==========================================================================
   AI 융합교육 매거진 — app.js
   구조: 설정/캐시(localStorage) → Gmail API 통신 → 메일 파싱 → 렌더링 → 이벤트
   백엔드 없이 브라우저에서 Google OAuth로 직접 로그인해 본인 Gmail만 읽습니다.
   ========================================================================== */

/* -------------------------------------------------------------------------
   0. 기본 설정값 (필요하면 아래 DEFAULT_SETTINGS 값을 바로 수정해도 됩니다)
   ------------------------------------------------------------------------- */
const DEFAULT_SETTINGS = {
  clientId: '',            // Google Cloud Console에서 발급받은 OAuth 클라이언트 ID
  keyword: 'AI 융합교육',   // 메일 제목에 포함되는 고정 검색어
  sender: '',               // (선택) 발신자 이메일 주소로 필터링
  maxResults: 20,
};
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const STORAGE_KEYS = {
  settings: 'aiedu_mag_settings_v1',
  articles: 'aiedu_mag_articles_v1',
};
const MAX_CACHED_ARTICLES = 120;   // localStorage에 보관할 최대 기사 수 (오래된 것부터 정리)
const MAX_CACHED_FULL_BODIES = 40; // 본문 전체를 캐시해 둘 최대 개수

/* -------------------------------------------------------------------------
   1. 전역 상태
   ------------------------------------------------------------------------- */
const state = {
  settings: { ...DEFAULT_SETTINGS },
  articles: {},        // id -> article object
  order: [],           // 최신순 id 배열 (현재 화면에 보여줄 목록)
  nextPageToken: null,
  accessToken: null,
  tokenExpiry: 0,
  tokenClient: null,
  gisReady: false,
};

/* -------------------------------------------------------------------------
   2. localStorage 헬퍼 (용량 초과 등 실패해도 앱이 죽지 않도록 방어)
   ------------------------------------------------------------------------- */
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (raw) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { /* 손상된 값은 기본값으로 대체 */ }
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings)); }
  catch (e) { showToast('설정 저장에 실패했습니다.', true); }
}

function loadCachedArticles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.articles);
    if (raw) {
      const arr = JSON.parse(raw);
      arr.forEach(a => { state.articles[a.id] = a; });
      state.order = arr.map(a => a.id);
    }
  } catch (e) { /* 무시하고 빈 상태로 시작 */ }
}

function persistArticles() {
  try {
    let list = state.order.map(id => state.articles[id]).filter(Boolean);
    if (list.length > MAX_CACHED_ARTICLES) list = list.slice(0, MAX_CACHED_ARTICLES);
    // 본문(bodyHtml)은 용량이 크므로 오래된 기사부터는 본문 캐시를 제거
    list = list.map((a, i) => i < MAX_CACHED_FULL_BODIES ? a : { ...a, bodyHtml: null, bodyText: null, hasFull: false });
    localStorage.setItem(STORAGE_KEYS.articles, JSON.stringify(list));
  } catch (e) {
    // 용량 초과 시: 절반만 저장 재시도
    try {
      const half = state.order.slice(0, Math.floor(MAX_CACHED_ARTICLES / 2)).map(id => state.articles[id]);
      localStorage.setItem(STORAGE_KEYS.articles, JSON.stringify(half));
    } catch (e2) { showToast('저장 공간이 부족해 캐시를 일부만 저장했습니다.', true); }
  }
}

/* -------------------------------------------------------------------------
   3. 제목 파싱: "[분류] 2026-08-03 헤드라인" 형태를 분해
      대괄호나 날짜가 없어도 안전하게 동작하도록 fallback 처리
   ------------------------------------------------------------------------- */
function parseSubject(subject) {
  const s = (subject || '(제목 없음)').trim();
  const m = s.match(/^\[(.+?)\]\s*(?:(\d{4}[-.]\d{2}[-.]\d{2})\s*)?(.*)$/);
  if (m) {
    const category = m[1].trim();
    const headline = (m[3] || '').trim() || category;
    return { category, headline };
  }
  return { category: '매거진', headline: s };
}

function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function formatDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/* -------------------------------------------------------------------------
   4. Gmail API 통신
   ------------------------------------------------------------------------- */
function buildQuery() {
  const parts = [];
  if (state.settings.keyword) parts.push(`subject:(${state.settings.keyword})`);
  if (state.settings.sender) parts.push(`from:(${state.settings.sender})`);
  return parts.join(' ');
}

async function gmailFetch(path, params = {}) {
  const url = new URL(GMAIL_API + path);
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(vv => url.searchParams.append(k, vv));
    else if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${state.accessToken}` } });
  if (res.status === 401) {
    state.accessToken = null;
    updateAuthUI();
    throw new Error('AUTH_EXPIRED');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gmail API 오류 (${res.status}) ${body.slice(0, 120)}`);
  }
  return res.json();
}

async function searchMessageIds(pageToken) {
  const q = buildQuery();
  const data = await gmailFetch('/messages', {
    q,
    maxResults: state.settings.maxResults,
    pageToken: pageToken || undefined,
  });
  return { ids: (data.messages || []).map(m => m.id), nextPageToken: data.nextPageToken || null };
}

async function fetchMetadataBatch(ids) {
  const CHUNK = 5;
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map(id =>
      gmailFetch(`/messages/${id}`, { format: 'metadata', metadataHeaders: ['Subject', 'Date', 'From'] })
        .catch(() => null)
    ));
    out.push(...results.filter(Boolean));
  }
  return out;
}

function decodeBase64Url(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function extractBody(payload) {
  let html = null, text = null;
  (function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    if (part.body && part.body.data) {
      if (mime === 'text/html' && !html) html = decodeBase64Url(part.body.data);
      else if (mime === 'text/plain' && !text) text = decodeBase64Url(part.body.data);
    }
    (part.parts || []).forEach(walk);
  })(payload);
  return { html, text };
}

/* -------------------------------------------------------------------------
   5. 동기화: 목록(메타데이터)만 우선 가져와 카드 표시 → 상세 클릭 시 본문 지연 로딩
   ------------------------------------------------------------------------- */
async function syncArticles() {
  if (!state.accessToken) { showToast('먼저 Google로 로그인해 주세요.', true); return; }
  setLoading(true);
  try {
    const { ids, nextPageToken } = await searchMessageIds();
    state.nextPageToken = nextPageToken;
    const newIds = ids.filter(id => !state.articles[id]);
    if (newIds.length) {
      const metas = await fetchMetadataBatch(newIds);
      metas.forEach(data => {
        const headers = data.payload ? data.payload.headers : [];
        const subject = getHeader(headers, 'Subject');
        const { category, headline } = parseSubject(subject);
        const dateHeader = getHeader(headers, 'Date');
        state.articles[data.id] = {
          id: data.id,
          subject,
          category,
          headline,
          from: getHeader(headers, 'From'),
          dateISO: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
          snippet: (data.snippet || '').trim(),
          bodyHtml: null,
          bodyText: null,
          hasFull: false,
        };
      });
    }
    // 이번 검색 결과 순서(최신순)를 기준으로 order 갱신, 그 뒤에 기존 캐시(더 과거 항목)를 붙임
    const rest = state.order.filter(id => !ids.includes(id));
    state.order = [...ids.filter(id => state.articles[id]), ...rest];
    persistArticles();
    renderAll();
    document.getElementById('syncStatus').textContent = `마지막 갱신 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    document.getElementById('loadMoreWrap').hidden = !state.nextPageToken;
  } catch (err) {
    if (err.message !== 'AUTH_EXPIRED') showToast(err.message || '동기화 중 오류가 발생했습니다.', true);
  } finally {
    setLoading(false);
  }
}

async function loadMore() {
  if (!state.nextPageToken) return;
  setLoading(true);
  try {
    const { ids, nextPageToken } = await searchMessageIds(state.nextPageToken);
    state.nextPageToken = nextPageToken;
    const newIds = ids.filter(id => !state.articles[id]);
    const metas = await fetchMetadataBatch(newIds);
    metas.forEach(data => {
      const headers = data.payload ? data.payload.headers : [];
      const subject = getHeader(headers, 'Subject');
      const { category, headline } = parseSubject(subject);
      const dateHeader = getHeader(headers, 'Date');
      state.articles[data.id] = {
        id: data.id, subject, category, headline,
        from: getHeader(headers, 'From'),
        dateISO: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
        snippet: (data.snippet || '').trim(),
        bodyHtml: null, bodyText: null, hasFull: false,
      };
    });
    state.order = [...state.order, ...ids.filter(id => state.articles[id] && !state.order.includes(id))];
    persistArticles();
    renderAll();
    document.getElementById('loadMoreWrap').hidden = !state.nextPageToken;
  } catch (err) {
    if (err.message !== 'AUTH_EXPIRED') showToast(err.message || '추가 로딩 중 오류가 발생했습니다.', true);
  } finally {
    setLoading(false);
  }
}

/* -------------------------------------------------------------------------
   6. 렌더링
   ------------------------------------------------------------------------- */
function currentFilters() {
  return {
    q: document.getElementById('searchInput').value.trim().toLowerCase(),
    cat: document.getElementById('categoryFilter').value,
  };
}

function visibleArticles() {
  const { q, cat } = currentFilters();
  return state.order
    .map(id => state.articles[id])
    .filter(Boolean)
    .filter(a => !cat || a.category === cat)
    .filter(a => !q || (a.headline + a.snippet).toLowerCase().includes(q));
}

function renderCategoryOptions() {
  const sel = document.getElementById('categoryFilter');
  const cur = sel.value;
  const cats = Array.from(new Set(state.order.map(id => state.articles[id]).filter(Boolean).map(a => a.category)));
  sel.innerHTML = '<option value="">전체 분류</option>' + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (cats.includes(cur)) sel.value = cur;
}

function renderAll() {
  renderCategoryOptions();
  const list = visibleArticles();
  const grid = document.getElementById('grid');
  document.getElementById('emptyState').hidden = list.length > 0;
  grid.innerHTML = list.map((a, i) => cardTemplate(a, state.order.length - state.order.indexOf(a.id))).join('');
  grid.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => openDetail(el.getAttribute('data-id')));
  });
}

function cardTemplate(a, dispatchNo) {
  const d = new Date(a.dateISO);
  return `
    <article class="card" data-id="${a.id}" tabindex="0">
      <div class="card__perf"></div>
      <div class="card__body">
        <div class="card__meta">
          <span>NO. ${String(dispatchNo).padStart(4, '0')}</span>
          <span>${formatDate(d)}</span>
        </div>
        <span class="chip">${escapeHtml(a.category)}</span>
        <h3 class="card__headline">${escapeHtml(a.headline)}</h3>
        <p class="card__snippet">${escapeHtml(a.snippet)}</p>
        <div class="card__footer">전문 보기 →</div>
      </div>
    </article>`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* -------------------------------------------------------------------------
   7. 상세보기 (지연 로딩 + iframe 격리 렌더링)
   ------------------------------------------------------------------------- */
async function openDetail(id) {
  const a = state.articles[id];
  if (!a) return;
  document.getElementById('detailCategory').textContent = a.category;
  document.getElementById('detailDate').textContent = formatDate(new Date(a.dateISO));
  document.getElementById('detailHeadline').textContent = a.headline;
  document.getElementById('detailMeta').textContent = a.from || '';
  document.getElementById('detailGmailLink').href = `https://mail.google.com/mail/u/0/#all/${id}`;
  const bodyEl = document.getElementById('detailBody');
  bodyEl.innerHTML = `<div class="skeleton skeleton--text"></div><div class="skeleton skeleton--text"></div><div class="skeleton skeleton--text short"></div>`;
  document.getElementById('detailOverlay').hidden = false;

  if (!a.hasFull) {
    try {
      const data = await gmailFetch(`/messages/${id}`, { format: 'full' });
      const { html, text } = extractBody(data.payload);
      a.bodyHtml = html ? DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : null;
      a.bodyText = text;
      a.hasFull = true;
      persistArticles();
    } catch (err) {
      if (err.message !== 'AUTH_EXPIRED') {
        bodyEl.innerHTML = `<p>본문을 불러오지 못했습니다. (${escapeHtml(err.message)})</p>`;
        return;
      }
      document.getElementById('detailOverlay').hidden = true;
      return;
    }
  }
  renderBodyIframe(bodyEl, a.bodyHtml, a.bodyText);
}

function renderBodyIframe(container, html, text) {
  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.className = 'dispatch-iframe';
  iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  const inner = html ? html : `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(text || '내용을 불러올 수 없습니다.')}</pre>`;
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:'Pretendard',-apple-system,sans-serif;color:#2B2F38;line-height:1.7;font-size:15px;margin:4px 2px;word-break:break-word;}
      img{max-width:100%;height:auto;} a{color:#3F6B4F;} table{max-width:100%;}
    </style></head><body>${inner}</body></html>`;
  iframe.addEventListener('load', () => {
    try {
      const doc = iframe.contentDocument;
      iframe.style.height = Math.min(doc.documentElement.scrollHeight + 24, 3000) + 'px';
      doc.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    } catch (e) { /* 접근 불가 시 무시 */ }
  });
  container.appendChild(iframe);
}

/* -------------------------------------------------------------------------
   8. Google 로그인 (Google Identity Services)
   ------------------------------------------------------------------------- */
function initGis() {
  if (!window.google || !state.settings.clientId) return;
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.settings.clientId,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) {
        if (resp.error !== 'immediate_failed' && resp.error !== 'popup_closed') {
          showToast('Google 로그인에 실패했습니다: ' + resp.error, true);
        }
        return;
      }
      state.accessToken = resp.access_token;
      state.tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
      updateAuthUI();
      syncArticles();
    },
  });
  state.gisReady = true;
}

function login(interactive) {
  if (!state.settings.clientId) { openSettings(); showToast('먼저 Client ID를 입력해 주세요.', true); return; }
  if (!state.gisReady) initGis();
  if (!state.tokenClient) return;
  state.tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
}

function updateAuthUI() {
  const btn = document.getElementById('btnAuth');
  btn.textContent = state.accessToken ? 'Gmail 연결됨 · 다시 로그인' : 'Google로 로그인';
}

/* -------------------------------------------------------------------------
   9. 설정 패널
   ------------------------------------------------------------------------- */
function openSettings() {
  document.getElementById('fClientId').value = state.settings.clientId;
  document.getElementById('fKeyword').value = state.settings.keyword;
  document.getElementById('fSender').value = state.settings.sender;
  document.getElementById('fMaxResults').value = String(state.settings.maxResults);
  document.getElementById('settingsOverlay').hidden = false;
}

function closeSettings() { document.getElementById('settingsOverlay').hidden = true; }

function onSettingsSubmit(e) {
  e.preventDefault();
  const prevClientId = state.settings.clientId;
  state.settings.clientId = document.getElementById('fClientId').value.trim();
  state.settings.keyword = document.getElementById('fKeyword').value.trim();
  state.settings.sender = document.getElementById('fSender').value.trim();
  state.settings.maxResults = Number(document.getElementById('fMaxResults').value) || 20;
  saveSettings();
  closeSettings();
  showToast('설정을 저장했습니다.');
  if (state.settings.clientId !== prevClientId) {
    state.tokenClient = null;
    state.gisReady = false;
    state.accessToken = null;
    updateAuthUI();
  }
}

function resetCache() {
  state.articles = {};
  state.order = [];
  state.nextPageToken = null;
  try { localStorage.removeItem(STORAGE_KEYS.articles); } catch (e) {}
  renderAll();
  showToast('캐시를 초기화했습니다.');
}

/* -------------------------------------------------------------------------
   10. 기타 UI 유틸
   ------------------------------------------------------------------------- */
let toastTimer;
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('toast--error', !!isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function setLoading(isLoading) {
  document.getElementById('btnRefresh').disabled = isLoading;
  document.getElementById('btnRefresh').textContent = isLoading ? '…' : '⟳';
}

/* -------------------------------------------------------------------------
   11. 초기화 & 이벤트 바인딩
   ------------------------------------------------------------------------- */
function init() {
  loadSettings();
  loadCachedArticles();
  renderAll();
  updateAuthUI();

  document.getElementById('btnAuth').addEventListener('click', () => login(true));
  document.getElementById('btnRefresh').addEventListener('click', () => state.accessToken ? syncArticles() : login(true));
  document.getElementById('btnSettings').addEventListener('click', openSettings);
  document.getElementById('btnEmptySettings').addEventListener('click', openSettings);
  document.getElementById('btnCloseSettings').addEventListener('click', closeSettings);
  document.getElementById('settingsForm').addEventListener('submit', onSettingsSubmit);
  document.getElementById('btnResetCache').addEventListener('click', resetCache);
  document.getElementById('btnCloseDetail').addEventListener('click', () => { document.getElementById('detailOverlay').hidden = true; });
  document.getElementById('btnLoadMore').addEventListener('click', loadMore);
  document.getElementById('searchInput').addEventListener('input', renderAll);
  document.getElementById('categoryFilter').addEventListener('change', renderAll);

  [document.getElementById('detailOverlay'), document.getElementById('settingsOverlay')].forEach(ov => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('detailOverlay').hidden = true;
      document.getElementById('settingsOverlay').hidden = true;
    }
  });

  if (!state.settings.clientId) {
    openSettings();
  } else {
    // Client ID가 이미 있으면 조용히(팝업 없이) 로그인 시도 → 실패하면 그냥 로그인 버튼 노출
    const waitForGis = setInterval(() => {
      if (window.google) {
        clearInterval(waitForGis);
        initGis();
        login(false);
      }
    }, 150);
    setTimeout(() => clearInterval(waitForGis), 5000);
  }
}

document.addEventListener('DOMContentLoaded', init);
