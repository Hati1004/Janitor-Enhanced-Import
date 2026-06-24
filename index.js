import { getContext } from '../../../extensions.js';

const MODULE_NAME = 'JanitorAI-Enhanced-Importer';

function setStatus(msg, type = 'info') {
    const el = document.getElementById('jai_status');
    if (!el) return;
    el.textContent = msg;
    el.className = `jai_status jai_status_${type}`;
    el.style.display = msg ? 'block' : 'none';
}

// base64 → Blob 변환
function base64ToBlob(base64, mimeType = 'image/png') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
}

window.runJaiConvert = async function(mode) {
    const url = document.getElementById('jai_url_input')?.value?.trim();
    if (!url) return setStatus('❌ URL을 입력해 주세요.', 'error');
    setStatus('🔄 캐릭터 데이터 추출 중...', 'info');

    try {
        // 1. 백엔드에 URL 전송 → base64 PNG 수신
        const data = await $.ajax({
            type: 'POST',
            url: '/api/plugins/janitor/fetch',
            data: JSON.stringify({ url }),
            contentType: 'application/json'
        });

        if (!data?.success) throw new Error(data?.error || '추출 실패');

        setStatus('✅ 데이터 확인 완료! 처리 중...', 'info');

        const finalBlob = base64ToBlob(data.pngBase64);
        let safeName = (data.charName || url.split('/').pop()).replace(/[\\/:*?"<>|]/g, '_');

        if (mode === 'download') {
            // ✅ 다운로드
            const blobUrl = URL.createObjectURL(finalBlob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `${safeName}.png`;
            a.click();
            URL.revokeObjectURL(blobUrl);
            setStatus('✅ 저장 완료!', 'success');

        } else {
            // ✅ ST 임포트: getContext().importCharacter 사용 (CSRF 불필요)
            setStatus('📥 ST에 임포트 중...', 'info');

            const file = new File([finalBlob], `${safeName}.png`, { type: 'image/png' });

            // SillyTavern의 파일 임포트 input을 트리거하는 방법
            const fd = new FormData();
            fd.append('avatar', file, `${safeName}.png`);

            // ✅ CSRF 토큰을 직접 meta 태그에서 읽기
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
                           || window.csrf_token
                           || '';

            await $.ajax({
                type: 'POST',
                url: '/api/characters/import',
                headers: { 'X-CSRF-Token': csrfToken },
                data: fd,
                processData: false,
                contentType: false
            });

            setStatus('✅ SillyTavern 임포트 완료!', 'success');

            // 캐릭터 목록 새로고침
            setTimeout(() => {
                try {
                    if (typeof window.getCharacters === 'function') window.getCharacters();
                    else if (typeof window.loadCharacters === 'function') window.loadCharacters();
                    // ST 최신버전 방식
                    const ctx = getContext();
                    if (ctx?.getCharacters) ctx.getCharacters();
                } catch(e) {}
            }, 500);
        }

    } catch (err) {
        const errMsg = err.responseJSON?.error || err.message || '알 수 없는 오류';
        setStatus(`❌ 에러: ${errMsg}`, 'error');
    }
};

window.toggleJaiDrawer = function() {
    if (window.event) window.event.stopPropagation();
    const content = document.getElementById('jai_content_wrap');
    const icon = document.getElementById('jai_toggle_icon');
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

    const html = `
    <div class="inline-drawer" id="jai_panel_container">
        <div class="inline-drawer-toggle inline-drawer-header" onclick="window.toggleJaiDrawer();" style="cursor:pointer;">
            <b>🎭 JanitorAI → ST 자동 추출기</b>
            <div id="jai_toggle_icon" class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="jai_content_wrap" style="display:none; padding:10px;">
            <p style="font-size:0.85em; opacity:0.8; margin:0 0 10px;">로어북과 대체 인사말이 내장된 캐릭터를 추출합니다.</p>
            <input type="text" id="jai_url_input" class="text_pole" placeholder="https://janitorai.com/characters/..." style="width:100%; box-sizing:border-box; margin-bottom:10px;">
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <button class="menu_button menu_button_icon" style="flex:1;" onclick="window.runJaiConvert('download')">⬇️ PNG 다운로드</button>
                <button class="menu_button menu_button_icon" style="flex:1;" onclick="window.runJaiConvert('import')">📥 ST 즉시 임포트</button>
            </div>
            <div id="jai_status" class="jai_status" style="display:none;"></div>
        </div>
    </div>`;

    container.insertAdjacentHTML('afterbegin', html);
}

export async function onEnable() { initUI(); }
export function onDisable() {
    document.getElementById('jai_panel_container')?.remove();
}

setTimeout(() => {
    if (!document.getElementById('jai_panel_container')) initUI();
}, 1500);
