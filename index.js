console.log("[JanitorAI-Enhanced-Importer] 🚀 로드 완료!");

// ⚠️ 예전에는 이 확장 패널 안에서 URL을 직접 입력해 캐릭터를 가져오는 기능이
// 있었지만, JanitorAI 쪽에서 해당 방식이 더 이상 동작하지 않습니다.
// 이제 캐릭터/로어북 가져오기는 janitor-bridge.user.js (Tampermonkey 스크립트)를
// 통해서만 지원합니다. 이 패널은 설치 안내만 보여줍니다.

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
            <p style="font-size:0.85em; opacity:0.85; margin:0 0 10px;">
                이 확장은 <b>Tampermonkey 브릿지 스크립트</b>와 함께 사용해야 합니다.
                이 패널 자체에는 가져오기 기능이 없습니다.
            </p>
            <div class="jai_notice">
                1. <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener">Tampermonkey</a> 브라우저 확장을 설치하세요.<br>
                2. 이 저장소의 <code>janitor-bridge.user.js</code> 스크립트를 Tampermonkey에 등록하세요.<br>
                3. <a href="https://janitorai.com/" target="_blank" rel="noopener">janitorai.com</a>의 캐릭터 페이지 / Scripts(로어북) 편집 페이지에서
                뜨는 <b>"📤 ST로 보내기"</b> 버튼을 사용하세요.
            </div>
        </div>
    </div>`);
}

export async function onEnable() { initUI(); }
export function onDisable() { document.getElementById('jai_panel_container')?.remove(); }
setTimeout(() => { if (!document.getElementById('jai_panel_container')) initUI(); }, 1500);
