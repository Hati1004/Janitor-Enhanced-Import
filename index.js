import { getContext } from '../../../extensions.js';

console.log("[JanitorAI-Enhanced-Importer] 🚀 로드 완료!");

function setStatus(msg, type = 'info') {
    const el = document.getElementById('jai_status');
    if (!el) return;
    el.textContent = msg;
    el.className = `jai_status jai_status_${type}`;
    el.style.display = msg ? 'block' : 'none';
}

function setLoreStatus(msg, type = 'info') {
    const el = document.getElementById('jai_lore_status');
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

// ── World Info(로어북) 목록 새로고침 ─────────────────────────────
async function refreshWorldList() {
    const methods = [
        () => window.updateWorldInfoList?.(),
        () => window.world_names && typeof window.loadWorldInfo === 'function' && window.loadWorldInfo(),
        () => {
            if (typeof $ !== 'undefined') {
                $(document).trigger('worldInfoListChanged');
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
        return setStatus('✅ PNG 저장 완료! (로어북은 아래 "로어북 연동" 섹션에서 별도로 추가하세요)', 'success');
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

    setStatus(`✅ "${data.charName}" 저장 완료! (로어북은 아래 "로어북 연동" 섹션에서 별도로 추가하세요) 목록을 새로고침합니다...`, 'success');
    // 다음 단계(로어북 연동)에서 캐릭터 이름을 바로 쓸 수 있게 입력칸에 채워준다.
    const loreCharInput = document.getElementById('jai_lore_charname_input');
    if (loreCharInput && !loreCharInput.value) loreCharInput.value = data.charName || '';
    setTimeout(refreshCharList, 400);
    setTimeout(refreshCharList, 1500);
};

// ── 로어북(datacat JSON) 붙여넣기 → ST World Info 폴더 저장 + 캐릭터 연결 ──
window.runJaiLorebookAttach = async function() {
    const raw = document.getElementById('jai_lore_json_input')?.value?.trim();
    const charName = document.getElementById('jai_lore_charname_input')?.value?.trim();

    if (!raw) return setLoreStatus('❌ datacat에서 받은 로어북 JSON을 붙여넣어 주세요.', 'error');
    if (!charName) return setLoreStatus('❌ 연결할 캐릭터 이름(ST에 저장된 이름)을 입력해 주세요.', 'error');

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return setLoreStatus('❌ JSON 형식이 올바르지 않습니다. datacat에서 받은 파일 내용을 그대로 붙여넣었는지 확인해 주세요.', 'error');
    }

    setLoreStatus('🔄 로어북 저장 + 캐릭터 연결 중...', 'info');
    let data;
    try {
        data = await $.ajax({
            type: 'POST', url: '/api/plugins/janitor/attach-lorebook',
            data: JSON.stringify({ charName, lorebookJson: parsed }), contentType: 'application/json'
        });
    } catch (err) {
        return setLoreStatus(`❌ 백엔드 에러: ${err.responseJSON?.error || err.statusText || '서버 연결 실패'}`, 'error');
    }

    if (!data?.success) {
        return setLoreStatus(`❌ ${data?.error || '연동 실패'}`, 'error');
    }

    setLoreStatus(`✅ "${data.worldName}" 로어북 저장 완료 (${data.entryCount}개 항목)! "${charName}" 캐릭터에 자동 연결되었습니다.`, 'success');
    setTimeout(refreshWorldList, 400);
    setTimeout(refreshCharList, 600);
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
            <p style="font-size:0.85em; opacity:0.8; margin:0 0 10px;">대체 인사말 포함 캐릭터를 추출합니다.</p>
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
                <summary style="cursor:pointer; font-size:0.9em; font-weight:bold;">📚 로어북 연동 (datacat에서 받은 JSON 붙여넣기)</summary>
                <div style="margin-top:8px;">
                    <p style="font-size:0.8em; opacity:0.8; line-height:1.5;">
                        JanitorAI 로어북은 인증 문제로 자동 추출이 불가능합니다.<br>
                        datacat.run에서 캐릭터 페이지의 "JSON 다운로드(ST)" 버튼으로 로어북을 받으신 뒤,
                        그 파일을 열어 내용 전체를 아래에 붙여넣으면<br>
                        ST World Info 폴더 저장과 캐릭터 연결을 대신 처리해 드립니다.
                    </p>
                    <input type="text" id="jai_lore_charname_input" class="text_pole"
                           placeholder="연결할 캐릭터 이름 (ST에 저장된 이름과 동일해야 함)"
                           style="width:100%; box-sizing:border-box; margin-bottom:8px;">
                    <textarea id="jai_lore_json_input" class="text_pole"
                              placeholder="datacat에서 받은 로어북 JSON 내용을 여기에 통째로 붙여넣기"
                              style="width:100%; min-height:90px; box-sizing:border-box; margin-bottom:8px; font-family:monospace; font-size:0.8em;"></textarea>
                    <button class="menu_button menu_button_icon" style="width:100%;" onclick="window.runJaiLorebookAttach()">🔗 로어북 저장 + 캐릭터 연결</button>
                    <div id="jai_lore_status" class="jai_status" style="display:none; margin-top:8px;"></div>
                </div>
            </details>
        </div>
    </div>`);
}

export async function onEnable() { initUI(); }
export function onDisable() { document.getElementById('jai_panel_container')?.remove(); }
setTimeout(() => { if (!document.getElementById('jai_panel_container')) initUI(); }, 1500);
