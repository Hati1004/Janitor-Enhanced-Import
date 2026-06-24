import { getContext } from '../../../extensions.js';

console.log("[JanitorAI-Enhanced-Importer] 🚀 로드 완료!");

function setStatus(msg, type = 'info') {
    const el = document.getElementById('jai_status');
    if (!el) return;
    el.textContent = msg;
    el.className = `jai_status jai_status_${type}`;
    el.style.display = msg ? 'block' : 'none';
}

// base64 → Blob
function b64ToBlob(b64, mime = 'image/png') {
    const bin  = atob(b64);
    const buf  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
}

// CSRF 토큰 획득 (ST가 토큰을 저장하는 모든 위치 순서대로 탐색)
function getCsrfToken() {
    return window.csrf_token
        || document.querySelector('meta[name="csrf-token"]')?.content
        || document.querySelector('input[name="_csrf"]')?.value
        || '';
}

// ST 캐릭터 목록 새로고침
async function refreshCharList() {
    try {
        // ST 최신 버전 방식
        const ctx = getContext();
        if (typeof ctx?.getCharacters === 'function') { await ctx.getCharacters(); return; }
        // 구버전 전역 함수
        if (typeof window.getCharacters === 'function') { await window.getCharacters(); return; }
        if (typeof window.loadCharacters === 'function') { await window.loadCharacters(); return; }
    } catch (e) {
        console.warn('[JAI] 캐릭터 목록 새로고침 실패:', e);
    }
}

window.runJaiConvert = async function(mode) {
    const url = document.getElementById('jai_url_input')?.value?.trim();
    if (!url) return setStatus('❌ URL을 입력해 주세요.', 'error');
    setStatus('🔄 캐릭터 데이터 추출 중...', 'info');

    let data;
    try {
        data = await $.ajax({
            type:        'POST',
            url:         '/api/plugins/janitor/fetch',
            data:        JSON.stringify({ url }),
            contentType: 'application/json'
        });
    } catch (err) {
        const msg = err.responseJSON?.error || err.statusText || '서버 연결 실패';
        return setStatus(`❌ 백엔드 에러: ${msg}`, 'error');
    }

    if (!data?.success) return setStatus(`❌ ${data?.error || '추출 실패'}`, 'error');

    setStatus('✅ 데이터 확인 완료! 처리 중...', 'info');

    const blob     = b64ToBlob(data.pngBase64);
    const safeName = (data.charName || url.split('/').pop()).replace(/[\\/:*?"<>|]/g, '_');
    const fileName = `${safeName}.png`;

    if (mode === 'download') {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl; a.download = fileName; a.click();
        URL.revokeObjectURL(blobUrl);
        return setStatus('✅ PNG 저장 완료!', 'success');
    }

    // ── ST 즉시 임포트 ────────────────────────────────────────────
    setStatus('📥 ST에 임포트 중...', 'info');
    try {
        const fd = new FormData();
        fd.append('avatar', new File([blob], fileName, { type: 'image/png' }));

        // ✅ CSRF 토큰: 헤더 + 쿼리 파라미터 동시에 전달 (ST 버전별 차이 대응)
        const token = getCsrfToken();

        const importRes = await fetch(`/api/characters/import`, {
            method:  'POST',
            headers: token ? { 'X-CSRF-Token': token } : {},
            body:    fd
        });

        if (!importRes.ok) {
            // CSRF 에러 시 토큰 갱신 후 재시도
            if (importRes.status === 403) {
                // ST의 CSRF 토큰 갱신 엔드포인트 호출
                try {
                    const tokenRes = await fetch('/csrf-token');
                    if (tokenRes.ok) {
                        const tokenData = await tokenRes.json();
                        if (tokenData.token) window.csrf_token = tokenData.token;
                    }
                } catch(e) {}

                // 재시도
                const fd2 = new FormData();
                fd2.append('avatar', new File([blob], fileName, { type: 'image/png' }));
                const retry = await fetch(`/api/characters/import`, {
                    method:  'POST',
                    headers: window.csrf_token ? { 'X-CSRF-Token': window.csrf_token } : {},
                    body:    fd2
                });
                if (!retry.ok) {
                    const errText = await retry.text();
                    throw new Error(`임포트 실패 (${retry.status}): ${errText.slice(0, 100)}`);
                }
            } else {
                const errText = await importRes.text();
                throw new Error(`임포트 실패 (${importRes.status}): ${errText.slice(0, 100)}`);
            }
        }

        setStatus(`✅ "${safeName}" 임포트 완료! 목록 새로고침 중...`, 'success');

        // 캐릭터 목록 새로고침 (약간의 딜레이 후)
        setTimeout(async () => {
            await refreshCharList();
            setStatus(`✅ "${safeName}" 임포트 완료!`, 'success');
        }, 800);

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
            <p style="font-size:0.85em; opacity:0.8; margin:0 0 10px;">로어북·대체 인사말 포함 캐릭터 추출 (JannyAI + datacat 이중 소스)</p>
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
