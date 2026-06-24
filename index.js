import { getContext } from '../../../extensions.js';

console.log("[JanitorAI-Enhanced-Importer] 🚀 확장 프로그램(index.js) 파일 읽기 성공!");

const scriptUrl = new URL(import.meta.url);
const pathSegments = scriptUrl.pathname.split('/');
const EXTENSION_DIR = pathSegments[pathSegments.length - 2]; 
const MODULE_NAME = 'JanitorAI-Enhanced-Importer';

function setStatus(msg, type = 'info') {
    const el = document.getElementById('jai_status');
    if (!el) return;
    el.textContent = msg;
    el.className = `jai_status jai_status_${type}`;
    el.style.display = msg ? 'block' : 'none';
}

const CRC32_TABLE = (() => {
    let t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();
function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
function u32be(arr, off, val) {
    arr[off] = (val >>> 24) & 0xFF; arr[off+1] = (val >>> 16) & 0xFF; arr[off+2] = (val >>> 8) & 0xFF; arr[off+3] = val & 0xFF;
}
function makePngTextChunk(keyword, value) {
    const enc = new TextEncoder();
    const kw = enc.encode(keyword), val = enc.encode(value);
    const data = new Uint8Array(kw.length + 1 + val.length);
    data.set(kw, 0); data[kw.length] = 0; data.set(val, kw.length + 1);
    const type = new Uint8Array([0x74, 0x45, 0x58, 0x74]); 
    const crcBuf = new Uint8Array(4 + data.length);
    crcBuf.set(type, 0); crcBuf.set(data, 4);
    const chunk = new Uint8Array(12 + data.length);
    u32be(chunk, 0, data.length); chunk.set(type, 4); chunk.set(data, 8);
    u32be(chunk, 8 + data.length, crc32(crcBuf));
    return chunk;
}
function insertChunkBeforeIEND(pngBytes, newChunk) {
    let iendPos = pngBytes.length - 12;
    for (let i = pngBytes.length - 12; i >= 8; i--) {
        if (pngBytes[i+4] === 0x49 && pngBytes[i+5] === 0x45 && pngBytes[i+6] === 0x4E && pngBytes[i+7] === 0x44) {
            iendPos = i; break;
        }
    }
    const result = new Uint8Array(pngBytes.length + newChunk.length);
    result.set(pngBytes.slice(0, iendPos)); result.set(newChunk, iendPos); result.set(pngBytes.slice(iendPos), iendPos + newChunk.length);
    return result;
}

async function makePlaceholderPngBytes(name) {
    const c = document.createElement('canvas'); c.width = 400; c.height = 600;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1e1e2e'; ctx.fillRect(0, 0, 400, 600);
    ctx.fillStyle = '#cdd6f4'; ctx.font = 'bold 30px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText((name || 'Character').substring(0, 20), 200, 300);
    return new Promise(res => c.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
}

function buildCharaCardV2(c) {
    const name = (c.name || 'Unknown').trim();
    const description = [c.personality, c.definitions].filter(Boolean).join('\n\n').trim();
    const scenario = (c.scenario || '').trim();
    const first_mes = (c.first_message || '').trim();
    const mes_example = (c.example_dialogs || '').trim();
    const creator_notes = (c.description || '').trim();
    const tags = Array.isArray(c.tags) ? c.tags.map(t => typeof t === 'object' ? t.name : t) : [];
    
    let character_book;
    const loreItems = c.lorebook_items || c.lorebook || [];
    if (loreItems.length > 0) {
        character_book = {
            name: name, description: '', scan_depth: 50, token_budget: 500, recursive_scanning: false, extensions: {},
            entries: loreItems.map((item, idx) => ({
                keys: Array.isArray(item.keys) ? item.keys : [item.key].filter(Boolean),
                secondary_keys: [], content: item.content || item.value || '', enabled: true, insertion_order: idx,
                case_sensitive: false, name: item.name || `Entry ${idx}`, priority: 10, id: idx, position: 'before_char', extensions: {}
            }))
        };
    }
    const alternate_greetings = Array.isArray(c.first_messages) ? c.first_messages.filter(m => m && m !== first_mes) : [];

    return {
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name, description, personality: '', scenario, first_mes, mes_example, creator_notes, system_prompt: '', post_history_instructions: '',
            alternate_greetings, character_book, tags, creator: c.creator_name || '', character_version: '1.0', extensions: {}
        }
    };
}

// 🔥 변경점: 실리태번 공식 서버 플러그인 주소로 통신 (/api/plugins/janitor/fetch)
window.runJaiConvert = async function(mode) {
    const url = document.getElementById('jai_url_input')?.value?.trim();
    if (!url) return setStatus('❌ URL을 입력해 주세요.', 'error');
    setStatus('🔄 서버에서 데이터를 추출하는 중...', 'info');

    try {
        const data = await $.ajax({
            type: 'POST',
            url: '/api/plugins/janitor/fetch',
            data: JSON.stringify({ url }),
            contentType: 'application/json'
        });

        if (!data || !data.success) throw new Error(data?.error || '추출 실패');

        setStatus('✅ 데이터 추출 완료! PNG 생성 중...', 'info');
        const cardV2 = buildCharaCardV2(data.character);
        const jsonStr = JSON.stringify(cardV2);
        const base64Card = btoa(unescape(encodeURIComponent(jsonStr)));
        const textChunk = makePngTextChunk('chara', base64Card);

        let pngBytes;
        const avatarUrl = data.character.avatar || data.character.avatar_url;
        try {
            const imgRes = await fetch(avatarUrl);
            pngBytes = new Uint8Array(await (await imgRes.blob()).arrayBuffer());
        } catch(e) { 
            pngBytes = await makePlaceholderPngBytes(cardV2.data.name); 
        }

        const finalBytes = insertChunkBeforeIEND(pngBytes, textChunk);
        const finalBlob = new Blob([finalBytes], { type: 'image/png' });
        const safeName = cardV2.data.name.replace(/[\\/:*?"<>|]/g,'_') || 'character';

        if (mode === 'download') {
            const blobUrl = URL.createObjectURL(finalBlob);
            const a = document.createElement('a'); a.href = blobUrl; a.download = `${safeName}.png`;
            a.click(); URL.revokeObjectURL(blobUrl);
            setStatus(`✅ ${cardV2.data.name} 저장 완료!`, 'success');
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
            
            setStatus(`✅ ${cardV2.data.name} SillyTavern 임포트 완료!`, 'success');
            try { 
                if (typeof window.loadCharacters === 'function') window.loadCharacters();
            } catch(e){}
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
            <b>🎭 JanitorAI -> ST 자동 추출기</b>
            <div id="jai_toggle_icon" class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="jai_content_wrap" style="display: none; padding: 10px;">
            <p style="font-size: 0.85em; opacity: 0.8; margin-top: 0; margin-bottom: 10px;">로어북(Lorebook)과 대체 인사말(Alternate Greetings)을 모두 지원합니다.</p>
            <input type="text" id="jai_url_input" class="text_pole" placeholder="https://janitorai.com/characters/..." style="width:100%; box-sizing:border-box; margin-bottom:10px;">
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <button class="menu_button menu_button_icon" style="flex:1;" onclick="window.runJaiConvert('download')">⬇️ PNG 다운로드</button>
                <button class="menu_button menu_button_icon" style="flex:1;" onclick="window.runJaiConvert('import')">📥 ST 즉시 임포트</button>
            </div>
            <div id="jai_status" class="jai_status" style="display:none;"></div>
        </div>
    </div>`;
    
    container.insertAdjacentHTML('afterbegin', html);
    console.log(`[${MODULE_NAME}] ✅ 화면에 UI 띄우기 성공!`);
}

export async function onEnable() { 
    console.log(`[${MODULE_NAME}] 스위치 ON - 활성화 완료`); 
    initUI();
}

export function onDisable() { 
    console.log(`[${MODULE_NAME}] 스위치 OFF - 비활성화 완료`); 
    const panel = document.getElementById('jai_panel_container');
    if (panel) panel.remove();
}

setTimeout(() => {
    if (!document.getElementById('jai_panel_container')) {
        console.log(`[${MODULE_NAME}] 🚨 강제 UI 띄우기 시작!`);
        initUI();
    }
}, 1500);