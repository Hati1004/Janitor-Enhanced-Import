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

function getCsrfToken() {
    return window.csrf_token
        || document.querySelector('meta[name="csrf-token"]')?.content
        || document.querySelector('input[name="_csrf"]')?.value
        || '';
}

// ST 1.18.x 캐릭터 목록 새로고침 - 실제 ST 내부 방식 사용
async function refreshCharList() {
    try {
        // 방법 1: ST 1.18의 실제 전역 함수
        if (typeof window.getCharacters === 'function') {
            await window.getCharacters();
            return;
        }
        // 방법 2: jQuery event trigger (ST가 내부적으로 사용하는 방식)
        if (typeof $ !== 'undefined') {
            $(document).trigger('characterListChanged');
            $(document).trigger('updateCharacterList');
        }
        // 방법 3: ST 1.18 이상 - characterSelect 페이지 리로드 트리거
        const charList = document.getElementById('rm_print_characters_block');
        if (charList) {
            charList.dispatchEvent(new CustomEvent('refresh', { bubbles: true }));
        }
    } catch (e) {
        console.warn('[JAI] 새로고침 실패 (무시 가능):', e.message);
    }
}

// 실제 임포트 수행 (재시도 로직 포함)
async function doImport(blob, fileName) {
    const makeFormData = () => {
        const fd = new FormData();
        fd.append('avatar', new File([blob], fileName, { type: 'image/png' }));
        return fd;
    };

    const token = getCsrfToken();

    // 1차 시도
    let res = await fetch('/api/characters/import', {
        method: 'POST',
        headers: token ? { 'X-CSRF-Token': token } : {},
        body: makeFormData()
    });

    // CSRF 실패 시 토큰 갱신 후 재시도
    if (res.status === 403) {
        console.log('[JAI] CSRF 403 → 토큰 갱신 시도');
        try {
            const tr = await fetch('/csrf-token');
            if (tr.ok) {
                const td = await tr.json();
                if (td.token) window.csrf_token = td.token;
            }
        } catch(e) {
            // /csrf-token 없으면 그냥 진행
        }
        res = await fetch('/api/characters/import', {
            method: 'POST',
            headers: window.csrf_token ? { 'X-CSRF-Token': window.csrf_token } : {},
            body: makeFormData()
        });
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`);
    }
    return res;
}

window.runJaiConvert = async function(mode) {
    const url = document.getElementById('jai_url_input')?.value?.trim();
    if (!url) return setStatus('❌ URL을 입력해 주세요.', 'error');
    setStatus('🔄 캐릭터 데이터 추출 중...', 'info');

    // 백엔드 호출
    let data;
    try {
        data = await $.ajax({
            type: 'POST',
            url: '/api/plugins/janitor/fetch',
            data: JSON.stringify({ url }),
            contentType: 'application/json'
        });
    } catch (err) {
        return setStatus(`❌ 백엔드 에러: ${err.responseJSON?.error || err.statusText || '서버 연결 실패'}`, 'error');
    }

    if (!data?.success) return setStatus(`❌ ${data?.error || '추출 실패'}`, 'error');
    setStatus('✅ PNG 생성 완료!', 'info');

    const blob = b64ToBlob(data.pngBase64);
    const safeName = (data.charName || url.split('/').pop()).replace(/[\\/:*?"<>|]/g, '_');
    const fileName = `${safeName}.png`;

    // ── 다운로드 모드 ─────────────────────────────────────────────
    if (mode === 'download') {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl; a.download = fileName; a.click();
        URL.revokeObjectURL(blobUrl);
        return setStatus('✅ PNG 저장 완료!', 'success');
    }

    // ── ST 즉시 임포트 모드 ───────────────────────────────────────
    setStatus('📥 ST에 임포트 중...', 'info');
    try {
        await doImport(blob, fileName);
        setStatus(`✅ "${safeName}" 임포트 완료! 잠시 후 목록에 나타납니다.`, 'success');

        // 새로고침: 여러 방법을 시간차로 모두 시도
        setTimeout(async () => {
            await refreshCharList();
        }, 500);
        setTimeout(async () => {
            await refreshCharList();
        }, 2000);

    } catch (err) {
        setStatus(`❌ 임포트 에러: ${err.message}`, 'error');
    }
};

window.toggleJaiDrawer = function() {
    if (window.event) window.event.stopPropagation();
    const content = document.getElementById('jai_content_wrap');
    const icon    = document.getElementById('jai_toggle_icon');
    if (!content || !icon) return;
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'block' : 'none';
    icon.className = isHidden
        ? 'inline-drawer-icon fa-solid fa-circle-chevron-up up'
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
