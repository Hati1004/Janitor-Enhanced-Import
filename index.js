import { getContext } from '../../../extensions.js';

console.log("[JanitorAI-Enhanced-Importer] 🚀 JannyAI 연동 프론트엔드 로드 완료!");

const MODULE_NAME = 'JanitorAI-Enhanced-Importer';

function setStatus(msg, type = 'info') {
    const el = document.getElementById('jai_status');
    if (!el) return;
    el.textContent = msg;
    el.className = `jai_status jai_status_${type}`;
    el.style.display = msg ? 'block' : 'none';
}

window.runJaiConvert = async function(mode) {
    const url = document.getElementById('jai_url_input')?.value?.trim();
    if (!url) return setStatus('❌ URL을 입력해 주세요.', 'error');
    setStatus('🔄 JannyAI 서버에서 캐릭터 데이터 추출 중...', 'info');

    try {
        // 1. 백엔드에 URL 전송
        const data = await $.ajax({
            type: 'POST',
            url: '/api/plugins/janitor/fetch',
            data: JSON.stringify({ url }),
            contentType: 'application/json'
        });

        if (!data || !data.success) throw new Error(data?.error || '추출 실패');

        setStatus('✅ 데이터 확인 완료! PNG 다운로드 중...', 'info');
        
        // 2. JannyAI가 이미 로어북/인사말을 다 넣어둔 완성된 PNG를 가져옴
        const imgRes = await fetch(data.downloadUrl);
        const finalBlob = await imgRes.blob();
        
        // 캐릭터 이름은 URL 맨 끝에서 임시 추출 (안전한 파일명 생성)
        let safeName = url.split('/').pop().split('_').pop() || 'Janitor_Character';
        safeName = safeName.replace(/[\\/:*?"<>|]/g,'_');

        if (mode === 'download') {
            const blobUrl = URL.createObjectURL(finalBlob);
            const a = document.createElement('a'); a.href = blobUrl; a.download = `${safeName}.png`;
            a.click(); URL.revokeObjectURL(blobUrl);
            setStatus(`✅ 저장 완료!`, 'success');
        } else {
            const fd = new FormData(); fd.append('avatar', finalBlob, `${safeName}.png`);
            
            await $.ajax({
                type: 'POST',
                url: '/api/characters/import',
                headers: { 'X-CSRF-Token': window['csrf_token'] || '' },
                data: fd,
                processData: false,
                contentType: false
            });
            
            setStatus(`✅ SillyTavern 임포트 완료!`, 'success');
            try { if (typeof window.loadCharacters === 'function') window.loadCharacters(); } catch(e){}
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
    
    if (isHidden) {
        icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-up up';
    } else {
        icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    }
};

function initUI() {
    if (document.getElementById('jai_panel_container')) return; 

    const container = document.getElementById('extensions_settings');
    if (!container) {
        setTimeout(initUI, 500);
        return;
    }

    const html = `
    <div class="inline-drawer" id="jai_panel_container">
        <div class="inline-drawer-toggle inline-drawer-header" onclick="window.toggleJaiDrawer();" style="cursor: pointer;">
            <b>🎭 JanitorAI -> ST 자동 추출기 (Janny Bypass)</b>
            <div id="jai_toggle_icon" class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="jai_content_wrap" style="display: none; padding: 10px;">
            <p style="font-size: 0.85em; opacity: 0.8; margin-top: 0; margin-bottom: 10px;">로어북과 대체 인사말이 내장된 캐릭터 이미지를 빠르고 안전하게 추출합니다.</p>
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
    const panel = document.getElementById('jai_panel_container');
    if (panel) panel.remove();
}

setTimeout(() => {
    if (!document.getElementById('jai_panel_container')) initUI();
}, 1500);