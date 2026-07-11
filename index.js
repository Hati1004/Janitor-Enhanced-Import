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

    // ── 다운로드 모드: 서버에서 PNG만 추출받아 브라우저로 내려받기 ──
    if (mode === 'download') {
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

        const blobUrl = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: blobUrl, download: fileName }).click();
        URL.revokeObjectURL(blobUrl);
        return setStatus('✅ PNG 저장 완료!', 'success');
    }

    // ── ST 즉시 임포트: 서버가 characters 폴더에 직접 파일을 써서
    //    ST의 /api/characters/import (format 검증 문제) 를 완전히 우회 ──
    setStatus('🔄 캐릭터 추출 + ST에 저장 중...', 'info');
    let data;
    try {
        data = await $.ajax({
            type: 'POST', url: '/api/plugins/janitor/fetch-and-save',
            data: JSON.stringify({ url }), contentType: 'application/json'
        });
    } catch (err) {
        return setStatus(`❌ 백엔드 에러: ${err.responseJSON?.error || err.statusText || '서버 연결 실패'}`, 'error');
    }

    if (!data?.success) {
        return setStatus(`❌ ${data?.error || '저장 실패'}`, 'error');
    }

    setStatus(`✅ "${data.charName}" 저장 완료! 목록을 새로고침합니다...`, 'success');
    setTimeout(refreshCharList, 400);
    setTimeout(refreshCharList, 1500);
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
            <p style="font-size:0.85em; opacity:0.8; margin:0 0 10px;">JanitorAI 캐릭터를 추출합니다.</p>

            <p style="font-size:0.78em; opacity:0.7; margin:0 0 10px; padding:8px; background:rgba(255,255,255,0.05); border-radius:6px;">
                💡 datacat/JannyAI 없이 더 안정적으로 받고 싶다면, <b>janitor-bridge.user.js</b> (Tampermonkey 스크립트)를
                설치해서 janitorai.com 캐릭터 페이지의 "📤 ST로 보내기" 버튼을 쓰세요. 아래 URL 입력/버튼은
                그 방법이 안 될 때를 위한 보조 경로입니다.
            </p>

            <input type="text" id="jai_url_input" class="text_pole"
                   placeholder="https://janitorai.com/characters/..."
                   style="width:100%; box-sizing:border-box; margin-bottom:10px;">
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <button class="menu_button menu_button_icon" style="flex:1;" onclick="window.runJaiConvert('download')">⬇️ PNG 다운로드</button>
                <button class="menu_button menu_button_icon" style="flex:1;" onclick="window.runJaiConvert('import')">📥 ST 즉시 임포트</button>
            </div>
            <div id="jai_status" class="jai_status" style="display:none; margin-bottom:10px;"></div>
        </div>
    </div>`);
}

export async function onEnable() { initUI(); }
export function onDisable() { document.getElementById('jai_panel_container')?.remove(); }
setTimeout(() => { if (!document.getElementById('jai_panel_container')) initUI(); }, 1500);
