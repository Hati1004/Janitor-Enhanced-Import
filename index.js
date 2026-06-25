import { getContext, extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

console.log("[JanitorAI-Enhanced-Importer] 🚀 로드 완료!");

const EXT_ID = 'janitor-enhanced-import';

// ── 설정값 저장/로드 (다른 ST 확장의 'API 키 입력칸'과 동일한 표준 방식) ──
// extension_settings에 저장되며 ST 설정 파일에 영구 보존됨.
// 사용자는 코드를 건드릴 필요 없이 화면의 입력칸에 값만 넣으면 됨.
function ensureSettingsDefaults() {
    if (!extension_settings[EXT_ID]) extension_settings[EXT_ID] = {};
    if (extension_settings[EXT_ID].janitorCookie === undefined) {
        extension_settings[EXT_ID].janitorCookie = '';
    }
    return extension_settings[EXT_ID];
}

function saveJanitorCookie(value) {
    const s = ensureSettingsDefaults();
    s.janitorCookie = value.trim();
    saveSettingsDebounced();
}

function getJanitorCookie() {
    return ensureSettingsDefaults().janitorCookie || '';
}

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
    const janitorCookie = getJanitorCookie();

    // ── 다운로드 모드: 서버에서 PNG만 추출받아 브라우저로 내려받기 ──
    if (mode === 'download') {
        setStatus('🔄 캐릭터 데이터 추출 중...', 'info');
        let data;
        try {
            data = await $.ajax({
                type: 'POST', url: '/api/plugins/janitor/fetch',
                data: JSON.stringify({ url, janitorCookie }), contentType: 'application/json'
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
        return setStatus(`✅ PNG 저장 완료!${data.lorebookEntryCount ? ` (로어북 ${data.lorebookEntryCount}개 포함)` : ''}`, 'success');
    }

    // ── ST 즉시 임포트: 서버가 characters 폴더에 직접 파일을 써서
    //    ST의 /api/characters/import (format 검증 문제) 를 완전히 우회 ──
    setStatus('🔄 캐릭터 추출 + ST에 저장 중...', 'info');
    let data;
    try {
        data = await $.ajax({
            type: 'POST', url: '/api/plugins/janitor/fetch-and-save',
            data: JSON.stringify({ url, janitorCookie }), contentType: 'application/json'
        });
    } catch (err) {
        return setStatus(`❌ 백엔드 에러: ${err.responseJSON?.error || err.statusText || '서버 연결 실패'}`, 'error');
    }

    if (!data?.success) {
        return setStatus(`❌ ${data?.error || '저장 실패'}`, 'error');
    }

    const lbMsg = data.lorebookEntryCount ? ` (로어북 ${data.lorebookEntryCount}개 항목 포함)` : ' (로어북 없음)';
    setStatus(`✅ "${data.charName}" 저장 완료!${lbMsg} 목록을 새로고침합니다...`, 'success');
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

window.toggleJaiCookieVisibility = function() {
    const inp = document.getElementById('jai_cookie_input');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
};

window.saveJaiCookie = function() {
    const val = document.getElementById('jai_cookie_input')?.value || '';
    saveJanitorCookie(val);
    setStatus(val.trim() ? '✅ 쿠키 저장 완료! 이제 로어북도 함께 추출됩니다.' : '쿠키를 지웠습니다. (로어북 자동 추출 비활성화)', 'success');
};

function initUI() {
    if (document.getElementById('jai_panel_container')) return;
    const container = document.getElementById('extensions_settings');
    if (!container) { setTimeout(initUI, 500); return; }

    ensureSettingsDefaults();

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
            <div id="jai_status" class="jai_status" style="display:none; margin-bottom:10px;"></div>

            <hr style="opacity:0.2; margin:12px 0;">

            <details>
                <summary style="cursor:pointer; font-size:0.9em; font-weight:bold;">🔑 로어북 자동 연동 설정 (선택, 처음 1회만)</summary>
                <div style="margin-top:8px;">
                    <p style="font-size:0.8em; opacity:0.8; line-height:1.5;">
                        로어북(전설책)까지 자동으로 같이 받으려면 JanitorAI 로그인 쿠키가 필요합니다.<br>
                        janitorai.com 로그인 상태에서 F12 → Application → Cookies →
                        <code>janitorai.com</code>에서<br>
                        <code>sb-auth-auth-token.0</code> 과 <code>sb-auth-auth-token.1</code> 의
                        Value를 찾아 아래 형식 그대로 입력 후 저장하세요:<br>
                        <code style="font-size:0.85em; word-break:break-all;">sb-auth-auth-token.0=값1; sb-auth-auth-token.1=값2</code><br>
                        ⚠️ 이 값은 비밀번호와 동일하게 취급되며, 본인 ST 설정 파일에만 저장되고 외부로 전송되지 않습니다.
                        세션이 만료되면 다시 입력해야 할 수 있습니다.
                    </p>
                    <div style="display:flex; gap:6px;">
                        <input type="password" id="jai_cookie_input" class="text_pole"
                               placeholder="sb-auth-auth-token 값을 여기에 붙여넣기"
                               style="flex:1; box-sizing:border-box;">
                        <button class="menu_button" title="표시/숨김" onclick="window.toggleJaiCookieVisibility()">👁️</button>
                        <button class="menu_button" onclick="window.saveJaiCookie()">저장</button>
                    </div>
                </div>
            </details>
        </div>
    </div>`);

    const savedCookie = getJanitorCookie();
    const cookieInput = document.getElementById('jai_cookie_input');
    if (cookieInput && savedCookie) cookieInput.value = savedCookie;
}

export async function onEnable() { initUI(); }
export function onDisable() { document.getElementById('jai_panel_container')?.remove(); }
setTimeout(() => { if (!document.getElementById('jai_panel_container')) initUI(); }, 1500);
