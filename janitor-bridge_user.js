// ==UserScript==
// @name         JanitorAI → SillyTavern Bridge
// @namespace    jai-st-bridge
// @version      1.7.1
// @description  janitorai.com 캐릭터/로어북 페이지에서 데이터를 same-origin으로 가져와 로컬 SillyTavern 플러그인으로 바로 전송합니다. (토큰 자동 감지)
// @match        https://janitorai.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    const ST_ENDPOINT_KEY = 'jai_bridge_st_endpoint';
    const TOKEN_KEY        = 'jai_bridge_token';

    // @grant 를 쓰면 스크립트가 샌드박스에서 돌아서, 페이지 쪽 객체(monaco, 에디터 인스턴스)가
    // 안 보인다. 페이지 원본 window 가 필요할 때는 이걸 쓴다.
    const PAGE = (typeof unsafeWindow !== 'undefined' && (unsafeWindow.wrappedJSObject || unsafeWindow)) || window;

    function getUuid() {
        const m = location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return m ? m[0] : null;
    }

    function getStEndpoint() { return GM_getValue(ST_ENDPOINT_KEY, 'http://127.0.0.1:8000'); }
    function getToken()      { return GM_getValue(TOKEN_KEY, ''); }

    // ── 토큰 자동 감지 ────────────────────────────────────────────
    // 폰에는 개발자도구(F12)가 없으므로, 사이트가 스스로 API를 호출할 때 붙이는
    // "Authorization: Bearer ..." 헤더를 페이지 안에서 엿봐서 저장한다.
    // (JanitorAI에 로그인한 상태로 아무 페이지나 열어두면 자동으로 채워진다)
    function injectTokenSniffer() {
        const code = '(' + function () {
            const post = (auth, url) => {
                try {
                    const m = /^Bearer\s+(.+)$/i.exec(String(auth || '').trim());
                    if (m) window.postMessage({ __jaiEiToken: m[1], __url: String(url || '') }, '*');
                } catch (e) { /* 무시 */ }
            };
            const _fetch = window.fetch;
            window.fetch = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : ((input && input.url) || String(input));
                    const h = (init && init.headers) || (input && typeof input === 'object' && input.headers);
                    let auth = null;
                    if (h) {
                        if (typeof h.get === 'function') auth = h.get('Authorization');
                        else if (Array.isArray(h)) { const p = h.find(x => /^authorization$/i.test(x[0])); auth = p && p[1]; }
                        else { for (const k in h) if (/^authorization$/i.test(k)) auth = h[k]; }
                    }
                    if (auth) post(auth, url);
                } catch (e) { /* 무시 */ }
                return _fetch.apply(this, arguments);
            };
            const _open = XMLHttpRequest.prototype.open;
            const _set  = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.open = function (m, u) { this.__jaiUrl = u; return _open.apply(this, arguments); };
            XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
                if (/^authorization$/i.test(k)) post(v, this.__jaiUrl);
                return _set.apply(this, arguments);
            };
        }.toString() + ')();';
        try {
            const s = document.createElement('script');
            s.textContent = code;
            (document.head || document.documentElement).appendChild(s);
            s.remove();
        } catch (e) {
            console.log('[JAI-Bridge] 토큰 감지기 주입 실패(CSP 가능성):', e.message);
        }
    }
    injectTokenSniffer();

    window.addEventListener('message', (ev) => {
        const d = ev.data;
        if (ev.origin !== location.origin || !d || typeof d.__jaiEiToken !== 'string') return;
        let host = '';
        try { host = new URL(d.__url, location.href).hostname; } catch (e) { /* 무시 */ }
        if (!/(^|\.)janitorai\.com$/i.test(host)) return; // 다른 서비스 토큰은 무시
        const t = d.__jaiEiToken.trim();
        if (t && t !== GM_getValue(TOKEN_KEY, '')) {
            GM_setValue(TOKEN_KEY, t);
            console.log('[JAI-Bridge] 🔑 JanitorAI 토큰 자동 감지/갱신됨');
        }
    });

    // 보조 수단: 사이트가 localStorage/sessionStorage에 JWT를 보관하는 경우 후보로 수집.
    // (실제로 쓸 수 있는 토큰인지는 호출해 보고 판단하므로, 후보가 틀려도 무해함)
    function findTokensInStorage() {
        const found = new Set();
        const JWT = /eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g;
        for (const store of [window.localStorage, window.sessionStorage]) {
            try {
                for (let i = 0; i < store.length; i++) {
                    const v = store.getItem(store.key(i));
                    if (v) (v.match(JWT) || []).forEach(t => found.add(t));
                }
            } catch (e) { /* 무시 */ }
        }
        return [...found];
    }

    // 저장된 토큰 → 자동 감지 토큰 → 스토리지 후보 → 수동 입력 순으로 시도
    async function fetchCharacterData(uuid) {
        const stored = getToken();
        const candidates = [];
        if (stored) candidates.push(stored);
        for (const t of findTokensInStorage()) if (!candidates.includes(t)) candidates.push(t);

        let lastStatus = null;
        for (const t of candidates.slice(0, 8)) {
            const res = await fetch(`/hampter/characters/${uuid}`, {
                headers: { 'Authorization': `Bearer ${t}`, 'Accept': 'application/json' }
            });
            if (res.ok) {
                if (t !== stored) GM_setValue(TOKEN_KEY, t);
                return await res.json();
            }
            lastStatus = res.status;
        }

        if (stored) GM_setValue(TOKEN_KEY, ''); // 저장돼 있던 토큰이 죽었으면 비움
        toast('🔑 토큰을 자동으로 못 찾았어요. 로그인 상태인지 확인하고, 새로고침 후 다시 눌러 보세요.', true);
        const entered = prompt('토큰을 자동으로 못 찾았습니다. 직접 입력하려면 Authorization 토큰(Bearer 뒤의 값만)을 붙여넣으세요:');
        if (!entered) throw new Error(lastStatus ? `HTTP ${lastStatus}` : '토큰 없음');
        const t = entered.trim();
        const res = await fetch(`/hampter/characters/${uuid}`, {
            headers: { 'Authorization': `Bearer ${t}`, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} (입력한 토큰이 올바르지 않을 수 있음)`);
        GM_setValue(TOKEN_KEY, t);
        return await res.json();
    }


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
                                'box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:pre-wrap;';
            document.body.appendChild(el);
        }
        el.style.background = isError ? '#B23A48' : '#2E7D32';
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, isError ? 12000 : 4000);
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
        'groupWeight', 'insertion_order', 'keyMatchPriority', 'inclusionGroupRaw',
        'keysecondary', 'selective', 'selectiveLogic', 'excludeRecursion',
        'preventRecursion', 'vectorized', 'addMemo'
    ];

    function looksLikeLorebookEntry(x) {
        if (!x || typeof x !== 'object' || !('content' in x)) return false;
        return LOREBOOK_MARKER_FIELDS.some(f => f in x);
    }

    // 모든 엔트리에 content 가 있고, 그중 하나라도 로어북 전용 필드가 2개 이상이면 인정.
    // (예전엔 모든 엔트리가 마커 2개를 다 가져야 해서, 필드가 일부 빠진 엔트리가
    //  하나만 섞여 있어도 통째로 탈락했다.)
    function looksLikeLorebookEntries(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        if (!arr.every(x => x && typeof x === 'object' && 'content' in x)) return false;
        return arr.some(x => LOREBOOK_MARKER_FIELDS.filter(f => f in x).length >= 2);
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

    // ── JS 형식 로어북(Scripts 코드) 파서 ────────────────────────────
    // JanitorAI Scripts는 JSON 말고도
    //   const loreEntries = [ { keywords: [...], priority: 30, scenario: "..." }, ... ];
    // 같은 자바스크립트 코드 형태로 로어북을 쓰는 경우가 있다. 주석, 따옴표 없는 키,
    // 작은따옴표/백틱 문자열, 끝 쉼표 때문에 JSON.parse가 안 되므로 직접 파싱한다.
    // eval / new Function 은 사이트 CSP 에 막힐 수 있고 보안상도 좋지 않아 쓰지 않는다.
    let lastParseError = '';
    let lastTextInfo   = '';

    const LORE_HINT_RE = /"content"|keywords|triggers|\bscenario\b|\bkeys?\s*:|buildPrompt|\bconst\s+\w+\s*=\s*[\[`'"]/i;

    function parseJsLiteral(src, start, opts) {
        let i = start;
        const n = src.length;
        const idRe  = /[A-Za-z_$][\w$]*/y;
        const keyRe = /[\w$]+/y;
        const numRe = /[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;

        function fail(msg) { throw new Error(`${msg} (위치 ${i}, 근처: ${JSON.stringify(src.slice(Math.max(0, i - 20), i + 20))})`); }

        function skipWs() {
            for (;;) {
                const c = src[i];
                if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\ufeff' || c === '\u00a0') { i++; continue; }
                if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
                if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
                break;
            }
        }

        function parseString() {
            const q = src[i++];
            let out = '';
            while (i < n) {
                const c = src[i++];
                if (c === q) return out;
                if (c === '\\') {
                    const e = src[i++];
                    switch (e) {
                        case 'n': out += '\n'; break;
                        case 'r': out += '\r'; break;
                        case 't': out += '\t'; break;
                        case 'b': out += '\b'; break;
                        case 'f': out += '\f'; break;
                        case 'v': out += '\v'; break;
                        case '0': out += '\0'; break;
                        case 'x': out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2; break;
                        case 'u':
                            if (src[i] === '{') {
                                const end = src.indexOf('}', i);
                                out += String.fromCodePoint(parseInt(src.slice(i + 1, end), 16));
                                i = end + 1;
                            } else {
                                out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16));
                                i += 4;
                            }
                            break;
                        case '\r': if (src[i] === '\n') i++; break; // 줄 이어쓰기
                        case '\n': break;
                        default: out += e;
                    }
                } else if (q === '`' && c === '$' && src[i] === '{') {
                    if (!(opts && opts.lenientTemplate)) fail('템플릿 문자열의 ${...} 표현식은 지원하지 않습니다');
                    // 느슨한 모드: ${...} 는 계산하지 않고 원문 그대로 남긴다 (중첩 중괄호만 맞춘다)
                    let depth = 0, j = i;
                    for (; j < n; j++) {
                        if (src[j] === '{') depth++;
                        else if (src[j] === '}') { depth--; if (depth === 0) break; }
                    }
                    out += '$' + src.slice(i, j + 1);
                    i = j + 1;
                } else {
                    out += c;
                }
            }
            fail('문자열이 닫히지 않았습니다');
        }

        function parseValue() {
            skipWs();
            const c = src[i];
            if (c === '[') return parseArray();
            if (c === '{') return parseObject();
            if (c === '"' || c === "'" || c === '`') {
                let v = parseString();
                // "abc" + "def" 처럼 문자열을 이어 붙인 경우
                for (;;) {
                    const save = i;
                    skipWs();
                    if (src[i] === '+') {
                        i++; skipWs();
                        if (src[i] === '"' || src[i] === "'" || src[i] === '`') { v += parseString(); continue; }
                    }
                    i = save;
                    break;
                }
                return v;
            }
            if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
                numRe.lastIndex = i;
                const m = numRe.exec(src);
                if (!m) fail('숫자를 해석하지 못했습니다');
                i += m[0].length;
                return Number(m[0]);
            }
            idRe.lastIndex = i;
            const m = idRe.exec(src);
            if (!m) fail(`예상치 못한 문자 '${c}'`);
            i += m[0].length;
            switch (m[0]) {
                case 'true': return true;
                case 'false': return false;
                case 'null': case 'undefined': return null;
                case 'Infinity': return Infinity;
                default: fail(`지원하지 않는 식별자 '${m[0]}' (변수/함수 호출은 읽을 수 없습니다)`);
            }
        }

        function parseArray() {
            i++; // [
            const arr = [];
            for (;;) {
                skipWs();
                if (i >= n) fail('배열이 닫히지 않았습니다');
                if (src[i] === ']') { i++; return arr; }
                if (src[i] === ',') { i++; continue; } // 끝 쉼표 / 빈 칸 허용
                arr.push(parseValue());
                skipWs();
                if (src[i] === ',') i++;
                else if (src[i] !== ']') fail("배열에서 ',' 또는 ']' 가 필요합니다");
            }
        }

        function parseObject() {
            i++; // {
            const obj = {};
            for (;;) {
                skipWs();
                if (i >= n) fail('객체가 닫히지 않았습니다');
                if (src[i] === '}') { i++; return obj; }
                if (src[i] === ',') { i++; continue; }
                let key;
                const c = src[i];
                if (c === '"' || c === "'" || c === '`') key = parseString();
                else {
                    keyRe.lastIndex = i;
                    const m = keyRe.exec(src);
                    if (!m) fail(`객체 키를 읽지 못했습니다 ('${c}')`);
                    i += m[0].length;
                    key = m[0];
                }
                skipWs();
                if (src[i] !== ':') fail("키 뒤에 ':' 가 필요합니다");
                i++;
                obj[key] = parseValue();
                skipWs();
                if (src[i] === ',') i++;
                else if (src[i] !== '}') fail("객체에서 ',' 또는 '}' 가 필요합니다");
            }
        }

        const value = parseValue();
        return { value, end: i };
    }

    // JS 형식 엔트리 → ST World Info 형태(JSON 로어북과 같은 모양)로 변환
    const JS_KEY_FIELDS  = ['keywords', 'keys', 'key', 'triggers', 'trigger'];
    const JS_BODY_FIELDS = ['content', 'scenario', 'personality', 'description', 'text', 'lore', 'info'];

    function normalizeJsLoreEntries(arr) {
        if (!Array.isArray(arr) || !arr.length) return null;
        if (!arr.every(e => e && typeof e === 'object' && !Array.isArray(e))) return null;
        const out = [];
        for (const e of arr) {
            let keys = null;
            for (const f of JS_KEY_FIELDS) { if (e[f] != null) { keys = e[f]; break; } }
            if (typeof keys === 'string') keys = keys.split(',');
            if (!Array.isArray(keys)) continue;
            const body = JS_BODY_FIELDS.map(f => e[f]).filter(v => typeof v === 'string' && v.trim()).join('\n\n');
            if (!body) continue;
            keys = keys.map(k => String(k).trim()).filter(Boolean);

            const prioRaw = [e.priority, e.order, e.insertion_order].find(v => typeof v === 'number');
            const probRaw = [e.probability, e.chance].find(v => typeof v === 'number');
            const probPct = probRaw == null ? 100 : Math.max(0, Math.min(100, Math.round(probRaw <= 1 ? probRaw * 100 : probRaw)));

            out.push({
                uid: out.length,
                key: keys,
                keysecondary: [],
                comment: keys[0] || `Entry ${out.length + 1}`,
                content: body,
                constant: keys.length === 0,
                vectorized: false,
                selective: true,
                selectiveLogic: 0,
                addMemo: true,
                order: prioRaw ?? 100,
                position: 0,
                disable: false,
                ignoreBudget: false,
                excludeRecursion: false,
                preventRecursion: false,
                probability: probPct,
                useProbability: probPct < 100
            });
        }
        return out.length ? out : null;
    }

    function extractEntriesFromJsText(text) {
        const starts = [];
        const declRe = /(?:\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|\bexport\s+default|\bmodule\.exports\s*=)\s*(?=\[)/g;
        let m;
        while ((m = declRe.exec(text)) !== null) starts.push(m.index + m[0].length);
        const first = text.search(/\S/);
        if (first !== -1 && text[first] === '[') starts.push(first);

        const found = [];
        for (const s of starts) {
            try {
                const { value } = parseJsLiteral(text, s);
                const entries = normalizeJsLoreEntries(value);
                if (entries) found.push(entries);
            } catch (e) {
                lastParseError = e.message;
            }
        }
        if (!found.length) return null;
        found.sort((a, b) => b.length - a.length);
        console.log(`[JAI-Bridge] JS 형식 로어북 감지: ${found[0].length}개 엔트리`);
        return found[0];
    }


    // ── 스크립트형 로어북 (function buildPrompt(context) { ... } + 변수들) ──
    //   const janiceKeywords = ["janice", ...];
    //   const janiceEntry = `[Janice Thompson: ...]`;
    // 처럼 NPC마다 "이름Keywords" / "이름Entry" 변수를 따로 두고 함수 안에서 조건부로 붙이는 형태.
    // 코드를 실행하지 않고, 변수 선언만 읽어서 이름(앞부분)이 같은 것끼리 짝지어 엔트리로 만든다.
    function extractEntriesFromScriptText(text) {
        const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?=["'`\[])/g;
        const KEY_NAME_RE   = /^(.*?)(keywords?|keys?|triggers?|words)$/i;
        const ENTRY_NAME_RE = /^(.*?)(entry|entries|lore|info|description|desc|text|content|prompt|scenario|bio|profile)$/i;
        const norm = (x) => x.replace(/_/g, '').toLowerCase();
        const keyVars = [], entryVars = [];
        let m;
        while ((m = declRe.exec(text)) !== null) {
            const km = KEY_NAME_RE.exec(m[1]);
            const em = ENTRY_NAME_RE.exec(m[1]);
            if (!(km && km[1]) && !(em && em[1])) continue;
            let value;
            try { value = parseJsLiteral(text, m.index + m[0].length, { lenientTemplate: true }).value; }
            catch (e) { continue; }
            if (km && km[1] && Array.isArray(value) && value.length && value.every(v => typeof v === 'string')) {
                keyVars.push({ stem: norm(km[1]), keys: value.map(v => v.trim()).filter(Boolean), pos: m.index });
            } else if (em && em[1] && typeof value === 'string' && value.trim().length >= 20) {
                entryVars.push({ stem: norm(em[1]), content: value.trim(), used: false });
            }
        }
        const pairs = [];
        for (const kv of keyVars) {
            const ev = entryVars.find(e => e.stem === kv.stem && !e.used);
            if (!ev) continue;
            ev.used = true;
            pairs.push({ pos: kv.pos, keywords: kv.keys, content: ev.content });
        }
        pairs.sort((a, b) => a.pos - b.pos);
        const entries = normalizeJsLoreEntries(pairs);
        if (!entries) {
            if (keyVars.length || entryVars.length) {
                lastParseError = `스크립트형: 키워드 변수 ${keyVars.length}개, 내용 변수 ${entryVars.length}개를 찾았지만 이름이 같은 짝이 없습니다`;
            }
            return null;
        }
        lastParseError = '';
        console.log(`[JAI-Bridge] 스크립트형 로어북 감지: ${entries.length}개 엔트리 (키워드 변수 ${keyVars.length}, 내용 변수 ${entryVars.length})`);
        return entries;
    }

    // JSON 먼저, 안 되면 JS 형식으로 시도
    function parseLorebookText(text) {
        if (!text) return null;
        const j = extractJsonArrayFromText(text);
        if (looksLikeLorebookEntries(j)) return j;
        return extractEntriesFromJsText(text) || extractEntriesFromScriptText(text);
    }

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

    // ── 백업: 화면에 렌더링된 코드 블록에서 직접 추출 ──────────────
    // 대괄호 짝을 맞춰 JSON 배열 하나를 잘라내 파싱한다.
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
        let sawHint = 0;
        for (const el of candidates) {
            const cls = (el.className && el.className.toString()) || '';
            if (/gutter|line-?number/i.test(cls)) continue;
            const text = el.textContent;
            if (!text || text.length < 20 || !LORE_HINT_RE.test(text)) continue;
            sawHint++;
            const parsed = parseLorebookText(text);
            console.log(`[JAI-Bridge][진단] 로어북처럼 보이는 요소 발견 (길이 ${text.length}), 파싱 ${parsed ? '성공' : '실패'}, 미리보기: ${text.slice(0, 120)}`);
            if (parsed && (!best || parsed.length > best.length)) best = parsed;
        }
        if (sawHint === 0) console.log('[JAI-Bridge][진단] 로어북처럼 보이는 DOM 요소를 하나도 못 찾음 (가상 스크롤 에디터일 가능성)');
        return best;
    }

    // ── 백업 2: Monaco / CodeMirror 에디터 내부 API로 전체 텍스트 직접 획득 ──
    // 코드 뷰어가 가상 스크롤(보이는 줄만 DOM에 렌더링)이면 DOM 스크래핑으로는
    // 전체를 못 가져온다. 에디터 내부 문서 객체에서 통째로 꺼내는 게 가장 정확하다.
    // (예전 버전은 .cm-editor 에서 찾았는데 CM6 의 인스턴스는 .cm-content 에 붙어 있고,
    //  샌드박스에서는 페이지 쪽 프로퍼티가 안 보여서 항상 실패했다.)
    function getCmDocText(contentEl) {
        const dv = contentEl.cmView;
        const view = dv?.view || dv?.editorView;
        const doc = view?.state?.doc;
        return doc && typeof doc.toString === 'function' ? doc.toString() : null;
    }

    function extractEntriesFromEditor() {
        // Monaco
        try {
            const monaco = PAGE.monaco;
            if (monaco?.editor) {
                const models = monaco.editor.getModels();
                console.log(`[JAI-Bridge][진단] Monaco 모델 ${models.length}개 발견`);
                for (const m of models) {
                    const parsed = parseLorebookText(m.getValue());
                    if (parsed) return parsed;
                }
            }
        } catch (e) { console.log('[JAI-Bridge][진단] Monaco 추출 실패:', e.message); }

        // CodeMirror 6: .cm-content.cmView.view.state.doc
        try {
            const pageDoc = PAGE.document || document;
            const nodes = pageDoc.querySelectorAll('.cm-content');
            console.log(`[JAI-Bridge][진단] CodeMirror 6 .cm-content ${nodes.length}개 발견`);
            for (const node of nodes) {
                const text = getCmDocText(node);
                if (!text) continue;
                console.log(`[JAI-Bridge][진단] CM6 문서 전체 텍스트 길이: ${text.length}`);
                lastTextInfo = `에디터 문서 ${text.length}자`;
                const parsed = parseLorebookText(text);
                if (parsed) return parsed;
            }
        } catch (e) { console.log('[JAI-Bridge][진단] CodeMirror 6 API 추출 실패:', e.message); }

        // CodeMirror 5
        try {
            const pageDoc = PAGE.document || document;
            for (const node of pageDoc.querySelectorAll('.CodeMirror')) {
                const text = node.CodeMirror?.getValue?.();
                if (!text) continue;
                const parsed = parseLorebookText(text);
                if (parsed) return parsed;
            }
        } catch (e) { console.log('[JAI-Bridge][진단] CodeMirror 5 API 추출 실패:', e.message); }

        // 지금 화면에 렌더링된 .cm-line (줄번호 제외)
        try {
            const text = collectCmContentText();
            if (text && LORE_HINT_RE.test(text)) {
                console.log(`[JAI-Bridge][진단] .cm-line 기반 텍스트 추출 (길이 ${text.length})`);
                const parsed = parseLorebookText(text);
                if (parsed) return parsed;
            }
        } catch (e) { console.log('[JAI-Bridge][진단] .cm-line 추출 실패:', e.message); }

        return null;
    }

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

    // ── 백업 3: 스크롤을 자동으로 움직이며 가려진 줄까지 전부 긁어모은다 ──
    // CM6 는 아직 렌더링 안 된 줄의 높이를 "추정"하다가 렌더링되면서 실제 값으로 바꾸기 때문에,
    // 예전처럼 offsetTop 으로 줄을 구분하면 같은 줄이 여러 번 들어가거나 순서가 꼬여서
    // 긴 로어북일수록 JSON 이 깨졌다. 줄번호(gutter)와 줄 요소를 1:1 로 짝지어서
    // "줄 번호" 기준으로 모으면 이 문제가 없다.
    async function extractEntriesFromEditorWithScroll() {
        const scrollers = document.querySelectorAll('.cm-scroller');
        console.log(`[JAI-Bridge][진단] .cm-scroller ${scrollers.length}개 발견`);
        for (const scroller of scrollers) {
            const contentEl = scroller.querySelector('.cm-content');
            if (!contentEl) continue;
            const editorEl = scroller.closest('.cm-editor') || scroller.parentElement;

            const byNumber = new Map(); // 줄 번호 → 텍스트
            const byTop    = new Map(); // 줄번호를 못 읽을 때만 쓰는 폴백
            const snapshot = () => {
                const lines = Array.from(contentEl.querySelectorAll('.cm-line'));
                const nums = Array.from(editorEl.querySelectorAll('.cm-lineNumbers .cm-gutterElement'))
                    .filter(el => el.style.visibility !== 'hidden' && /^\d+$/.test(el.textContent.trim()));
                if (lines.length && nums.length === lines.length) {
                    lines.forEach((l, k) => byNumber.set(parseInt(nums[k].textContent, 10), l.textContent));
                } else {
                    lines.forEach(l => byTop.set(l.offsetTop, l.textContent));
                }
            };

            const originalScrollTop = scroller.scrollTop;
            const originalBehavior  = scroller.style.scrollBehavior;
            // 사이트 CSS가 smooth 스크롤이면 위치가 천천히 바뀌어서 "더 안 움직인다"고 오판해 중간에 끊겼다.
            scroller.style.scrollBehavior = 'auto';
            scroller.scrollTop = 0;
            await sleep(200);

            let lastTop = -1, stuck = 0, bottomHits = 0;
            for (let guard = 0; guard < 6000; guard++) {
                snapshot();
                const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
                if (atBottom) {
                    // CM6 는 아직 안 그려진 줄 높이를 추정하다가 그리면서 scrollHeight 가 늘어난다.
                    // 바닥에 닿았다고 바로 끝내지 말고, 잠깐 기다렸다 여러 번 다시 확인한다.
                    if (++bottomHits >= 4) break;
                    await sleep(200);
                    continue;
                }
                bottomHits = 0;
                scroller.scrollTop += Math.max(40, scroller.clientHeight * 0.5);
                await sleep(80);
                if (scroller.scrollTop === lastTop) { if (++stuck >= 8) break; await sleep(150); } else stuck = 0;
                lastTop = scroller.scrollTop;
            }
            await sleep(150);
            snapshot(); // 맨 아래 한 번 더
            scroller.scrollTop = originalScrollTop;
            scroller.style.scrollBehavior = originalBehavior;

            let text, info;
            if (byNumber.size) {
                const nums = [...byNumber.keys()].sort((a, b) => a - b);
                const maxNo = nums[nums.length - 1];
                const parts = [];
                for (let no = 1; no <= maxNo; no++) parts.push(byNumber.get(no) ?? '');
                text = parts.join('\n');
                info = `${byNumber.size}/${maxNo}줄 읽음, ${text.length}자`;
                if (byNumber.size < maxNo) console.warn(`[JAI-Bridge][진단] 빠진 줄이 있습니다: ${maxNo - byNumber.size}줄`);
            } else {
                text = [...byTop.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]).join('\n');
                info = `줄번호 없이 ${byTop.size}줄 읽음, ${text.length}자`;
            }
            lastTextInfo = info;
            console.log(`[JAI-Bridge][진단] 스크롤 캡처: ${info}`);
            if (LORE_HINT_RE.test(text)) {
                const parsed = parseLorebookText(text);
                if (parsed) return parsed;
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
        console.log('[JAI-Bridge] 마지막 읽기 정보:', lastTextInfo, '| 마지막 파싱 오류:', lastParseError);
    };

    async function sendToSillyTavern() {
        const uuid = getUuid();
        if (!uuid) return toast('❌ 캐릭터 페이지에서만 사용할 수 있습니다.', true);

        toast('🔄 캐릭터 데이터 가져오는 중...');
        let apiData;
        try {
            // same-origin fetch: janitorai.com 페이지 안에서 실행되므로
            // Cloudflare 봇 감지도, CORS도 걸리지 않는다.
            apiData = await fetchCharacterData(uuid);
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
        lastParseError = '';
        lastTextInfo = '';
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
            return toast('❌ 로어북 데이터를 찾지 못했습니다.'
                + (lastTextInfo ? `\n읽은 내용: ${lastTextInfo}` : '')
                + (lastParseError ? `\n파싱 오류: ${lastParseError}` : '')
                + '\nF12 콘솔에서 __jaiDebugLorebook() 실행 결과를 확인해주세요.', true);
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

        toast(`📤 로어북 전송 중... (엔트리 ${capturedEntries.length}개)`);
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
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWhenReady);
    else initWhenReady();

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
    // 토큰이 JWT면 종류(role/익명 여부)와 만료 시각만 읽어 보여준다. (개인정보/토큰 본문은 표시하지 않음)
    function describeToken(t) {
        try {
            const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const p = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
            const exp = p.exp ? new Date(p.exp * 1000) : null;
            const expired = exp && exp.getTime() < Date.now();
            return `종류(role): ${p.role || '알 수 없음'}\n익명 여부: ${p.is_anonymous === undefined ? '알 수 없음' : p.is_anonymous}\n만료: ${exp ? exp.toLocaleString() : '알 수 없음'}${expired ? ' (⚠️ 이미 만료됨)' : ''}`;
        } catch (e) {
            return '(JWT 형식이 아니라 종류를 읽을 수 없음)';
        }
    }
    GM_registerMenuCommand('🔍 저장된 토큰 상태 확인', () => {
        const t = getToken();
        alert(t ? `저장된 토큰 있음 (길이 ${t.length})\n${describeToken(t)}\n\n※ role이 anon이거나 익명이면 로그인이 안 된 토큰입니다.` : '저장된 토큰 없음. janitorai.com에 로그인한 상태로 페이지를 새로고침/이동해 보세요.');
    });
    GM_registerMenuCommand('🔑 JanitorAI 토큰 재설정', () => {
        const val = prompt('JanitorAI Authorization 토큰 (Bearer 뒤에 오는 값만)');
        if (val) GM_setValue(TOKEN_KEY, val.trim());
    });
})();
