// ==UserScript==
// @name         JanitorAI → SillyTavern Bridge
// @namespace    jai-st-bridge
// @version      1.5.0
// @description  janitorai.com 캐릭터/로어북 페이지에서 데이터를 same-origin으로 가져와 로컬 SillyTavern 플러그인으로 바로 전송합니다.
// @match        https://janitorai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    const ST_ENDPOINT_KEY = 'jai_bridge_st_endpoint';
    const TOKEN_KEY        = 'jai_bridge_token';

    function getUuid() {
        const m = location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return m ? m[0] : null;
    }

    function getStEndpoint() { return GM_getValue(ST_ENDPOINT_KEY, 'http://127.0.0.1:8000'); }
    function getToken()      { return GM_getValue(TOKEN_KEY, ''); }

    // ── ST CSRF 토큰 가져오기 ─────────────────────────────────────
    // ST 서버는 POST 요청에 X-CSRF-Token 헤더를 요구한다(csurf 미들웨어).
    // 이 스크립트는 janitorai.com이라는 별도 오리진에서 실행되므로
    // ST 페이지처럼 자동으로 토큰이 붙지 않는다. 매 요청 전에 직접 받아와야 함.
    function getCsrfToken(endpoint) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${endpoint}/csrf-token`,
                onload: (resp) => {
                    try {
                        const json = JSON.parse(resp.responseText);
                        if (!json.token) throw new Error('토큰 필드 없음');
                        resolve(json.token);
                    } catch (e) {
                        reject(new Error(`CSRF 토큰 응답 파싱 실패: ${e.message}`));
                    }
                },
                onerror: () => reject(new Error('CSRF 토큰 요청 실패 (서버 연결 확인)'))
            });
        });
    }

    function toast(msg, isError) {
        let el = document.getElementById('jai-bridge-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'jai-bridge-toast';
            el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:12px 16px;' +
                                'border-radius:8px;font:14px/1.4 sans-serif;max-width:320px;color:#fff;' +
                                'box-shadow:0 2px 10px rgba(0,0,0,.35);';
            document.body.appendChild(el);
        }
        el.style.background = isError ? '#B23A48' : '#2E7D32';
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
    }

    // ── 로어북(Scripts) 엔트리 캡처 ──────────────────────────────────
    // JanitorAI Scripts의 정확한 API 경로를 알 수 없으므로, 페이지가 실제로
    // 호출하는 모든 fetch/XHR 응답을 가로채서 "로어북 엔트리처럼 생긴 JSON"을
    // 휴리스틱으로 감지한다. 엔드포인트 이름이 바뀌어도 깨지지 않는 방식.
    let capturedEntries  = null;
    let capturedBookName = null;

    // 로어북 엔트리 전용 필드(댓글 등 다른 데이터에는 없는 필드들)가
    // 최소 2개 이상 있어야 진짜 엔트리로 인정한다. 'content'만으로는
    // 댓글 API 응답과 구분이 안 되어 예전 버전에서 오작동이 있었음.
    const LOREBOOK_MARKER_FIELDS = [
        'key', 'keys', 'activationMode', 'constant', 'case_sensitive',
        'groupWeight', 'insertion_order', 'keyMatchPriority', 'inclusionGroupRaw'
    ];

    function looksLikeLorebookEntry(x) {
        if (!x || typeof x !== 'object' || !('content' in x)) return false;
        const markerCount = LOREBOOK_MARKER_FIELDS.filter(f => f in x).length;
        return markerCount >= 2;
    }

    function looksLikeLorebookEntries(arr) {
        return Array.isArray(arr) && arr.length > 0 && arr.every(looksLikeLorebookEntry);
    }

    function tryCaptureLorebook(obj) {
        if (!obj || typeof obj !== 'object') return;

        // 엔트리 배열 자체가 최상위로 온 경우: 이름 정보가 같이 없으므로
        // 기존에 캡처된 이름이 있으면 그대로 두고 엔트리만 갱신한다.
        if (looksLikeLorebookEntries(obj)) {
            capturedEntries = obj;
            console.log('[JAI-Bridge] 로어북 엔트리 감지:', obj.length, '개');
            return;
        }

        // ⚠️ 이름은 반드시 "엔트리를 실제로 찾아낸 그 소스"에서만 같이 가져온다.
        // 페이지의 다른 API 응답(유저 정보, 사이트 메타데이터 등)에 우연히
        // name/title 필드가 있다는 이유만으로 로어북 이름을 덮어쓰던 것이
        // "janitor"로 저장되던 버그의 원인이었다.
        const sources = [
            { entries: obj.entries,               name: obj.name         ?? obj.title },
            { entries: obj.data?.entries,          name: obj.data?.name   ?? obj.data?.title },
            { entries: obj.script?.entries,        name: obj.script?.name ?? obj.script?.title },
            { entries: obj.data?.script?.entries,  name: obj.data?.script?.name ?? obj.data?.script?.title },
            { entries: obj.code,                   name: obj.name         ?? obj.title },
            { entries: obj.data?.code,              name: obj.data?.name   ?? obj.data?.title },
        ];

        for (const src of sources) {
            const parsed = typeof src.entries === 'string' ? safeJsonParse(src.entries) : src.entries;
            if (looksLikeLorebookEntries(parsed)) {
                capturedEntries = parsed;
                if (typeof src.name === 'string' && src.name.trim()) {
                    capturedBookName = src.name.trim();
                }
                console.log('[JAI-Bridge] 로어북 엔트리 감지:', parsed.length, '개', capturedBookName ? `(이름: ${capturedBookName})` : '(이름 없음)');
                break;
            }
        }
    }

    function safeJsonParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

    const _origFetch = window.fetch;
    window.fetch = async function (...args) {
        const res = await _origFetch.apply(this, args);
        try {
            const clone = res.clone();
            clone.json().then(tryCaptureLorebook).catch(() => {});
        } catch (e) { /* 무시 */ }
        return res;
    };

    const _origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) {
        this.addEventListener('load', function () {
            try { tryCaptureLorebook(JSON.parse(this.responseText)); } catch (e) { /* 무시 */ }
        });
        return _origXhrOpen.apply(this, args);
    };

    function isScriptPage() { return /\/scripts\//.test(location.pathname); }

    // ── 백업: 화면에 렌더링된 코드 블록에서 직접 JSON 추출 ──────────
    // 네트워크 요청으로 못 잡을 경우(SSR로 이미 렌더링된 데이터 등)를 대비해,
    // "Lorebook source" 코드 뷰어의 텍스트에서 대괄호 짝을 맞춰 JSON 배열을
    // 직접 파싱한다. 코드 뷰어가 줄번호를 별도 컬럼(가상 요소)으로 그리는
    // 경우가 많아, textContent 자체는 보통 순수 코드 텍스트만 담고 있다.
    function extractJsonArrayFromText(text) {
        const start = text.indexOf('[');
        if (start === -1) return null;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) return safeJsonParse(text.slice(start, i + 1));
            }
        }
        return null;
    }

    function extractEntriesFromDom() {
        const candidates = document.querySelectorAll('pre, code, [class*="code"], [class*="editor"], [class*="Lorebook"], [class*="lorebook"]');
        console.log(`[JAI-Bridge][진단] DOM 스캔 후보 요소 ${candidates.length}개`);
        let best = null;
        let sawContentField = 0;
        for (const el of candidates) {
            const cls = (el.className && el.className.toString()) || '';
            if (/gutter|line-?number/i.test(cls)) continue;
            const text = el.textContent;
            if (!text || text.length < 20 || text.indexOf('"content"') === -1) continue;
            sawContentField++;
            const parsed = extractJsonArrayFromText(text);
            console.log(`[JAI-Bridge][진단] "content" 포함 요소 발견 (길이 ${text.length}), 파싱 ${parsed ? '성공' : '실패'}, 미리보기: ${text.slice(0, 120)}`);
            if (looksLikeLorebookEntries(parsed) && (!best || parsed.length > best.length)) best = parsed;
        }
        if (sawContentField === 0) console.log('[JAI-Bridge][진단] "content" 필드를 포함한 DOM 요소를 하나도 못 찾음 (가상 스크롤 에디터일 가능성)');
        return best;
    }

    // ── 백업 2: Monaco / CodeMirror 에디터 내부 API로 전체 텍스트 직접 획득 ──
    // 코드 뷰어가 가상 스크롤(보이는 줄만 DOM에 렌더링)을 쓰는 경우, DOM
    // 스크래핑으로는 전체 내용을 못 가져온다. 이런 에디터들은 대부분 내부
    // 모델 객체에 전체 텍스트를 담고 있고, getValue() 같은 API로 꺼낼 수 있다.
    function extractEntriesFromEditor() {
        // Monaco
        try {
            if (window.monaco?.editor) {
                const models = window.monaco.editor.getModels();
                console.log(`[JAI-Bridge][진단] Monaco 모델 ${models.length}개 발견`);
                for (const m of models) {
                    const text = m.getValue();
                    if (text && text.indexOf('"content"') !== -1) {
                        const parsed = extractJsonArrayFromText(text);
                        if (looksLikeLorebookEntries(parsed)) return parsed;
                    }
                }
            }
        } catch (e) { console.log('[JAI-Bridge][진단] Monaco 추출 실패:', e.message); }

        // CodeMirror 5/6: 내부 API(getValue / EditorView 인스턴스)가 있으면 우선 사용
        try {
            const cmNodes = document.querySelectorAll('.CodeMirror, .cm-editor');
            console.log(`[JAI-Bridge][진단] CodeMirror 노드 ${cmNodes.length}개 발견`);
            for (const node of cmNodes) {
                let text = null;
                if (node.CodeMirror?.getValue) {
                    text = node.CodeMirror.getValue();
                } else {
                    // CM6는 EditorView 인스턴스를 DOM에 직접 노출하지 않는 경우가 많아,
                    // 내부 프로퍼티 키(보통 "_" 또는 심볼로 시작)를 훑어서 찾아본다.
                    for (const k in node) {
                        if (!k.startsWith('_') && !k.startsWith('cm')) continue;
                        try {
                            const v = node[k];
                            const doc = v?.view?.state?.doc || v?.state?.doc;
                            if (doc?.toString) { text = doc.toString(); break; }
                        } catch (e) { /* 무시 */ }
                    }
                }
                if (text && text.indexOf('"content"') !== -1) {
                    const parsed = extractJsonArrayFromText(text);
                    if (looksLikeLorebookEntries(parsed)) return parsed;
                }
            }
        } catch (e) { console.log('[JAI-Bridge][진단] CodeMirror API 추출 실패:', e.message); }

        // gutter(줄번호) 없이 실제 코드 줄(.cm-line)만 모아서 텍스트 재구성
        try {
            const text = collectCmContentText();
            if (text && text.indexOf('"content"') !== -1) {
                console.log(`[JAI-Bridge][진단] .cm-line 기반 텍스트 추출 (길이 ${text.length})`);
                const parsed = extractJsonArrayFromText(text);
                if (looksLikeLorebookEntries(parsed)) return parsed;
            }
        } catch (e) { console.log('[JAI-Bridge][진단] .cm-line 추출 실패:', e.message); }

        return null;
    }

    // gutter(줄번호) 요소를 제외하고 .cm-content 내부의 .cm-line들만 순서대로 이어붙인다.
    // (지금 화면에 렌더링된 줄까지만 포함되므로, 가상 스크롤 상황에선 아래
    // extractEntriesFromEditorWithScroll()로 전체를 훑어야 한다.)
    function collectCmContentText() {
        const contentNodes = document.querySelectorAll('.cm-content');
        let best = '';
        for (const contentEl of contentNodes) {
            const lines = contentEl.querySelectorAll('.cm-line');
            const text = lines.length
                ? Array.from(lines).map(l => l.textContent).join('\n')
                : contentEl.textContent;
            if (text.length > best.length) best = text;
        }
        return best;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── 백업 3: CodeMirror 내부 스크롤을 자동으로 움직이며 가상 스크롤로
    //    가려진 줄까지 전부 긁어모은다. (가장 느리지만 가장 확실함) ──
    async function extractEntriesFromEditorWithScroll() {
        const scrollers = document.querySelectorAll('.cm-scroller');
        console.log(`[JAI-Bridge][진단] .cm-scroller ${scrollers.length}개 발견`);
        for (const scroller of scrollers) {
            const contentEl = scroller.querySelector('.cm-content');
            if (!contentEl) continue;

            const lineMap = new Map(); // 세로 위치(offsetTop) → 텍스트, 중복 제거 + 순서 정렬용
            const originalScrollTop = scroller.scrollTop;
            scroller.scrollTop = 0;
            await sleep(60);

            let lastScrollTop = -1;
            for (let guard = 0; guard < 500; guard++) {
                contentEl.querySelectorAll('.cm-line').forEach(line => {
                    lineMap.set(line.offsetTop, line.textContent);
                });
                const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
                if (atBottom) break;
                scroller.scrollTop += Math.max(50, scroller.clientHeight * 0.8);
                await sleep(40);
                if (scroller.scrollTop === lastScrollTop) break;
                lastScrollTop = scroller.scrollTop;
            }
            scroller.scrollTop = originalScrollTop;

            const text = [...lineMap.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]).join('\n');
            console.log(`[JAI-Bridge][진단] 스크롤 캡처 텍스트 길이: ${text.length}`);
            if (text.indexOf('"content"') !== -1) {
                const parsed = extractJsonArrayFromText(text);
                if (looksLikeLorebookEntries(parsed)) return parsed;
            }
        }
        return null;
    }

    // 콘솔에서 수동으로 실행해 진단할 수 있는 헬퍼
    window.__jaiDebugLorebook = async function () {
        console.log('[JAI-Bridge] capturedEntries:', capturedEntries);
        console.log('[JAI-Bridge] editor 추출 시도:', extractEntriesFromEditor());
        console.log('[JAI-Bridge] DOM 추출 시도:', extractEntriesFromDom());
        console.log('[JAI-Bridge] 스크롤 캡처 시도:', await extractEntriesFromEditorWithScroll());
    };

    async function sendToSillyTavern() {
        const uuid = getUuid();
        if (!uuid) return toast('❌ 캐릭터 페이지에서만 사용할 수 있습니다.', true);

        let token = getToken();
        if (!token) {
            const entered = prompt('JanitorAI Authorization 토큰을 입력하세요 (Bearer 뒤에 오는 값만):');
            if (!entered) return;
            token = entered.trim();
            GM_setValue(TOKEN_KEY, token);
        }

        toast('🔄 캐릭터 데이터 가져오는 중...');
        let apiData;
        try {
            // same-origin fetch: janitorai.com 페이지 안에서 실행되므로
            // Cloudflare 봇 감지도, CORS도 걸리지 않는다.
            const res = await fetch(`/hampter/characters/${uuid}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    GM_setValue(TOKEN_KEY, ''); // 다음 시도 때 새 토큰을 다시 물어보게 함
                }
                throw new Error(`HTTP ${res.status}`);
            }
            apiData = await res.json();
        } catch (e) {
            return toast(`❌ 캐릭터 데이터 가져오기 실패: ${e.message}`, true);
        }

        const endpoint = getStEndpoint();

        toast('🔑 CSRF 토큰 확인 중...');
        let csrfToken;
        try {
            csrfToken = await getCsrfToken(endpoint);
        } catch (e) {
            return toast(`❌ ${e.message}`, true);
        }

        toast('📤 SillyTavern으로 전송 중...');
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${endpoint}/api/plugins/janitor/fetch-and-save`,
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            data: JSON.stringify({ url: location.href, nativeApiData: apiData }),
            onload: (resp) => {
                try {
                    const json = JSON.parse(resp.responseText);
                    if (json.success) toast(`✅ "${json.charName}" ST에 저장 완료!`);
                    else toast(`❌ ST 저장 실패: ${json.error}`, true);
                } catch (e) {
                    toast('❌ ST 응답을 해석하지 못했습니다.', true);
                }
            },
            onerror: () => toast('❌ ST 서버 연결 실패 (주소/포트를 확인하세요)', true)
        });
    }

    function injectButton() {
        if (document.getElementById('jai-bridge-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'jai-bridge-btn';
        btn.textContent = '📤 ST로 보내기';
        btn.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:2147483647;padding:10px 16px;' +
                             'border:none;border-radius:8px;background:#5865F2;color:#fff;font-weight:bold;' +
                             'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);';
        btn.onclick = sendToSillyTavern;
        document.body.appendChild(btn);
    }

    // ── 로어북 → ST World Info 전송 ──────────────────────────────
    async function sendLorebookToSillyTavern() {
        if (!capturedEntries) {
            capturedEntries = extractEntriesFromEditor();
            if (capturedEntries) console.log('[JAI-Bridge] 에디터 API에서 로어북 엔트리 추출 성공:', capturedEntries.length, '개');
        }
        if (!capturedEntries) {
            capturedEntries = extractEntriesFromDom();
            if (capturedEntries) console.log('[JAI-Bridge] DOM에서 로어북 엔트리 추출 성공:', capturedEntries.length, '개');
        }
        if (!capturedEntries) {
            toast('🔍 전체 내용을 읽기 위해 코드 스크롤 중... 잠시만요');
            capturedEntries = await extractEntriesFromEditorWithScroll();
            if (capturedEntries) console.log('[JAI-Bridge] 스크롤 캡처로 로어북 엔트리 추출 성공:', capturedEntries.length, '개');
        }
        if (!capturedEntries) {
            return toast('❌ 로어북 데이터를 찾지 못했습니다. F12 콘솔에서 __jaiDebugLorebook() 실행 결과를 확인해주세요.', true);
        }
        // capturedBookName은 네트워크 응답에서 엔트리와 "같이" 잡힌 경우에만 채워짐.
        // DOM/스크롤 백업 추출로 엔트리를 얻은 경우엔 이름 정보가 없으므로,
        // document.title(자주 부정확함, JanitorAI SPA가 갱신 안 함)에 기대는 대신
        // 사용자가 직접 확인/수정하도록 프롬프트를 띄운다.
        const guessedName = (capturedBookName && capturedBookName.trim())
            || (() => {
                const t = document.title.replace(/\s*[-·].*$/, '').trim();
                // "janitor" / "janitorai" 같은 사이트 자체 타이틀은 로어북 이름이 아니므로 무시
                return /^janitor\s*ai?$/i.test(t) ? '' : t;
            })();

        const bookName = (window.prompt('저장할 로어북 이름을 확인/수정해 주세요:', guessedName || '') || '').trim()
            || guessedName
            || 'JanitorLorebook';

        toast('🔑 CSRF 토큰 확인 중...');
        const endpoint = getStEndpoint();
        let csrfToken;
        try {
            csrfToken = await getCsrfToken(endpoint);
        } catch (e) {
            return toast(`❌ ${e.message}`, true);
        }

        toast('📤 로어북 전송 중...');
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${endpoint}/api/plugins/janitor/save-worldbook`,
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            data: JSON.stringify({ bookName, entries: capturedEntries }),
            onload: (resp) => {
                try {
                    const json = JSON.parse(resp.responseText);
                    if (json.success) toast(`✅ 로어북 "${json.fileName}" ST에 저장 완료! World Info 목록에서 캐릭터에 연결하세요.`);
                    else toast(`❌ 저장 실패: ${json.error}`, true);
                } catch (e) {
                    toast('❌ ST 응답을 해석하지 못했습니다.', true);
                }
            },
            onerror: () => toast('❌ ST 서버 연결 실패 (주소/포트를 확인하세요)', true)
        });
    }

    function injectLorebookButton() {
        if (!isScriptPage()) return;
        if (document.getElementById('jai-bridge-lore-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'jai-bridge-lore-btn';
        btn.textContent = '📚 로어북 ST로 보내기';
        btn.style.cssText = 'position:fixed;bottom:70px;left:20px;z-index:2147483647;padding:10px 16px;' +
                             'border:none;border-radius:8px;background:#8B5CF6;color:#fff;font-weight:bold;' +
                             'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);';
        btn.onclick = sendLorebookToSillyTavern;
        document.body.appendChild(btn);
    }

    function initWhenReady() {
        if (getUuid()) injectButton();
        if (isScriptPage()) injectLorebookButton();
        if (!getUuid() && !isScriptPage()) setTimeout(initWhenReady, 1000);
    }
    initWhenReady();

    // SPA라 페이지 이동 시 새로고침이 안 되므로, 경로 변경을 감지해 버튼을 다시 붙인다.
    let lastPath = location.pathname;
    setInterval(() => {
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            document.getElementById('jai-bridge-btn')?.remove();
            document.getElementById('jai-bridge-lore-btn')?.remove();
            capturedEntries  = null;
            capturedBookName = null;
            initWhenReady();
        }
    }, 1000);

    GM_registerMenuCommand('⚙️ ST 서버 주소 설정', () => {
        const cur = getStEndpoint();
        const val = prompt('SillyTavern 서버 주소 (예: http://127.0.0.1:8000)', cur);
        if (val) GM_setValue(ST_ENDPOINT_KEY, val.trim());
    });
    GM_registerMenuCommand('🔑 JanitorAI 토큰 재설정', () => {
        const val = prompt('JanitorAI Authorization 토큰 (Bearer 뒤에 오는 값만)');
        if (val) GM_setValue(TOKEN_KEY, val.trim());
    });
})();
