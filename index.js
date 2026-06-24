import { getContext } from '../../../extensions.js';

console.log("[JanitorAI-Enhanced-Importer] 🚀 로드 완료!");

function setStatus(msg, type = 'info') {
    const el = document.getElementById('jai_status');
    if (!el) return;
    el.textContent = msg;
    el.className = `jai_status jai_status_${type}`;
    el.style.display = msg ? 'block' : 'none';
}

function b64ToBlob(b64, mime = 'image/png') {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
}

// ── ST 임포트: ST 자체 파일 input을 프로그래매틱으로 트리거 ──────
// CSRF 문제를 완전히 우회. ST가 내부적으로 처리하게 위임.
async function importToST(blob, fileName) {
    return new Promise((resolve, reject) => {
        // ST의 캐릭터 임포트 input 요소 찾기
        // ST 1.18: #character_import_file 또는 input[name="avatar"]
        let fileInput = document.getElementById('character_import_file')
                     || document.querySelector('input[name="avatar"][type="file"]')
                     || document.querySelector('.character_import input[type="file"]');

        if (!fileInput) {
            // 없으면 임시 생성
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.png,.json,.charx';
            fileInput.style.display = 'none';
            document.body.appendChild(fileInput);
        }

        // DataTransfer로 File 주입
        const dt = new DataTransfer();
        dt.items.add(new File([blob], fileName, { type: 'image/png' }));
        fileInput.files = dt.files;

        // change 이벤트 발생 → ST가 내부 임포트 처리
        const changeEvent = new Event('change', { bubbles: true });
        fileInput.dispatchEvent(changeEvent);

        // ST가 비동기로 처리하므로 짧게 대기
        setTimeout(() => resolve(), 1500);
    });
}

// ── 폴백: fetch API로 직접 임포트 ────────────────────────────────
async function importViaFetch(blob, fileName) {
    // CSRF 토큰 획득
    let token = window.csrf_token
             || document.querySelector('meta[name="csrf-token"]')?.content
             || '';

    // 토큰 없으면 갱신 시도
    if (!token) {
        try {
            const r = await fetch('/csrf-token');
            if (r.ok) { const d = await r.json(); token = d.token || d.csrf_token || ''; }
        } catch(e) {}
    }

    const makeReq = (t) => {
        const fd = new FormData();
        fd.append('avatar', new File([blob], fileName, { type: 'image/png' }));
        return fetch('/api/characters/import', {
            method: 'POST',
            headers: t ? { 'X-CSRF-Token': t } : {},
            body: fd
        });
    };

    let res = await makeReq(token);

    if (res.status === 403) {
        // 토큰 재취득 후 재시도
        try {
            const r = await fetch('/csrf-token');
            if (r.ok) { const d = await r.json(); window.csrf_token = d.token || d.csrf_token || token; }
        } catch(e) {}
        res = await makeReq(window.csrf_token);
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 150)}`);
    }
    return res;
}

// ── 캐릭터 목록 새로고침 ─────────────────────────────────────────
async function refreshCharList() {
    // ST 1.18 실제 작동하는 방식들
    const methods = [
        () => window.getCharacters?.(),
        () => window.loadCharacters?.(),
        () => {
            const ctx = getContext();
            return ctx?.getCharacters?.();
        },
        () => {
            // ST가 내부적으로 사용하는 jQuery 이벤트
            if (typeof $ !== 'undefined') {
                $(document).trigger('characterListChanged');
            }
        }
    ];
    for (const fn of methods) {
        try { await fn(); } catch(e) { /* 무시 */ }
    }
}

window.runJaiConvert = async function(mode) {
    const url = document.getElementById('jai_url_input')?.value?.trim();
    if (!url) return setStatus('❌ URL을 입력해 주세요.', 'error');
    setStatus('🔄 캐릭터 데이터 추출 중...', 'info');

    let data;
    try {
        data = await $.ajax({
            type: 'POST', url: '/api/plugins/janitor/fetch',
            data: JSON.stringify({ url }), contentType: 'application/json'
        });
    } catch (err) {
        return setStatus(`❌ 백엔드 에러: ${err.responseJSON?.error || err.statusText || '서버 연결 실패'}`, 'error');
    }

    if (!data?.success) return setStatus(`❌ ${data?.error || '추출 실패'}`, 'error');

    const blob     = b64ToBlob(data.pngBase64);
    const safeName = (data.charName || url.split('/').pop()).replace(/[\\/:*?"<>|]/g, '_');
    const fileName = `${safeName}.png`;

    // ── 다운로드 ──────────────────────────────────────────────────
    if (mode === 'download') {
        const blobUrl = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: blobUrl, download: fileName }).click();
        URL.revokeObjectURL(blobUrl);
        return setStatus('✅ PNG 저장 완료!', 'success');
    }

    // ── ST 즉시 임포트 ────────────────────────────────────────────
    setStatus('📥 ST에 임포트 중...', 'info');
    try {
        // 1차: fetch API 직접 임포트 (더 안정적)
        try {
            await importViaFetch(blob, fileName);
            setStatus(`✅ "${safeName}" 임포트 완료!`, 'success');
        } catch (fetchErr) {
            console.warn('[JAI] fetch 임포트 실패, 파일 input 방식 시도:', fetchErr.message);
            // 2차: ST 파일 input 트리거
            await importToST(blob, fileName);
            setStatus(`✅ "${safeName}" 임포트 완료!`, 'success');
        }

        // 새로고침: 여러 번 시도
        setTimeout(refreshCharList, 600);
        setTimeout(refreshCharList, 2500);

    } catch (err) {
        setStatus(`❌ 임포트 에러: ${err.message}`, 'error');
        // 최후 수단: 다운로드로 폴백
        setStatus(`⚠️ 자동 임포트 실패. PNG 다운로드 후 수동으로 드래그하여 추가하세요.`, 'error');
        const blobUrl = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: blobUrl, download: fileName }).click();
        URL.revokeObjectURL(blobUrl);
    }
};

window.toggleJaiDrawer = function() {
    if (window.event) window.event.stopPropagation();
    const c = document.getElementById('jai_content_wrap');
    const i = document.getElementById('jai_toggle_icon');
    if (!c || !i) return;
    const h = c.style.display === 'none';
    c.style.display = h ? 'block' : 'none';
    i.className = h ? 'inline-drawer-icon fa-solid fa-circle-chevron-up up'
                    : 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
};

function initUI() {
    if (document.getElementById('jai_panel_container')) return;
    const container = document.getElementById('extensions_settings');
    if (!container) { setTimeout(initUI, 500); return; }

    container.insertAdjacentHTML('afterbegin', `
    <div class="inline-drawer" id="jai_panel_container">
        <div class="inline-drawer-toggle inline-drawer-header" onclick="window.toggleJaiDrawer();" style="cursor:pointer;">
            <b>🎭 JanitorAI → ST 자동 추출기</b>
            <div id="jai_toggle_icon" class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="jai_content_wrap" style="display:none; padding:10px;">
            <p style="font-size:0.85em; opacity:0.8; margin:0 0 10px;">로어북·대체 인사말 포함 캐릭터를 추출합니다.</p>
            <input type="text" id="jai_url_input" class="text_pole"
                   placeholder="https://janitorai.com/characters/..."
                   style="width:100%; box-sizing:border-box; margin-bottom:10px;">
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <button class="menu_button menu_button_icon" style="flex:1;" onclick="window.runJaiConvert('download')">⬇️ PNG 다운로드</button>
                <button class="menu_button menu_button_icon" style="flex:1;" onclick="window.runJaiConvert('import')">📥 ST 즉시 임포트</button>
            </div>
            <div id="jai_status" class="jai_status" style="display:none;"></div>
        </div>
    </div>`);
}

export async function onEnable() { initUI(); }
export function onDisable() { document.getElementById('jai_panel_container')?.remove(); }
setTimeout(() => { if (!document.getElementById('jai_panel_container')) initUI(); }, 1500);
