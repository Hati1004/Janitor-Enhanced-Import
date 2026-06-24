// 위치: SillyTavern/plugins/janitor.js
const info = { id: 'janitor', name: 'JanitorAI Proxy', description: 'JannyAI 우회 추출 백엔드' };

// ── CRC32 ────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeTEXtChunk(keyword, text) {
    const typeTag = Buffer.from('tEXt');
    const data    = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
    const lenBuf  = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf  = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeTag, data])), 0);
    return Buffer.concat([lenBuf, typeTag, data, crcBuf]);
}
function readAllChunks(pngBuf) {
    const result = [];
    let offset = 8;
    while (offset + 12 <= pngBuf.length) {
        const len  = pngBuf.readUInt32BE(offset);
        const type = pngBuf.slice(offset + 4, offset + 8).toString('ascii');
        const data = pngBuf.slice(offset + 8, offset + 8 + len);
        result.push({ type, len, data, offset });
        if (type === 'IEND') break;
        offset += 12 + len;
    }
    return result;
}
function rebuildPng(pngBuf, textChunks) {
    const chunks = readAllChunks(pngBuf);
    const replaceKeys = new Set(Object.keys(textChunks));
    const parts = [pngBuf.slice(0, 8)];
    for (const chunk of chunks) {
        if (chunk.type === 'IEND') {
            for (const [kw, val] of Object.entries(textChunks)) parts.push(makeTEXtChunk(kw, val));
            parts.push(pngBuf.slice(chunk.offset));
            break;
        }
        if (chunk.type === 'tEXt') {
            const nullIdx = chunk.data.indexOf(0x00);
            if (nullIdx !== -1 && replaceKeys.has(chunk.data.slice(0, nullIdx).toString('latin1'))) continue;
        }
        parts.push(pngBuf.slice(chunk.offset, chunk.offset + 12 + chunk.len));
    }
    return Buffer.concat(parts);
}
function readCharaCard(pngBuf) {
    for (const chunk of readAllChunks(pngBuf)) {
        if (chunk.type !== 'tEXt') continue;
        const nullIdx = chunk.data.indexOf(0x00);
        if (nullIdx === -1) continue;
        if (chunk.data.slice(0, nullIdx).toString('latin1') !== 'chara') continue;
        try {
            return JSON.parse(Buffer.from(chunk.data.slice(nullIdx + 1).toString('latin1'), 'base64').toString('utf8'));
        } catch(e) { return null; }
    }
    return null;
}

// ── V3 → V2 변환 ────────────────────────────────────────────────
function toV2Card(card) {
    if (!card) return null;
    if (card.spec === 'chara_card_v2') return card;
    const d = card.data || {};
    const v2 = {
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name:                      d.name                      || card.name        || '',
            description:               d.description               || card.description || '',
            personality:               d.personality               || card.personality || '',
            scenario:                  d.scenario                  || card.scenario    || '',
            first_mes:                 d.first_mes                 || card.first_mes   || '',
            mes_example:               d.mes_example               || card.mes_example || '',
            creator_notes:             d.creator_notes             || card.creatorcomment || '',
            system_prompt:             d.system_prompt             || '',
            post_history_instructions: d.post_history_instructions || '',
            tags:                      d.tags                      || card.tags        || [],
            creator:                   d.creator                   || card.creator     || '',
            character_version:         d.character_version         || '',
            alternate_greetings:       d.alternate_greetings       || [],
            extensions:                d.extensions                || {},
        }
    };
    return v2;
}

function buildCharacterBook(entries) {
    if (!entries?.length) return null;
    return {
        name: '', description: '', scan_depth: 2, token_budget: 2048,
        recursive_scanning: false, extensions: {},
        entries: entries.map((e, i) => ({
            keys:            Array.isArray(e.keys) ? e.keys : Array.isArray(e.keywords) ? e.keywords : e.key ? [e.key] : [],
            secondary_keys:  [],
            comment:         e.comment || e.name || e.title || '',
            content:         e.content || e.value || e.text || '',
            constant:        Boolean(e.constant),
            selective:       Boolean(e.selective),
            insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : i,
            enabled:         e.enabled !== false,
            position:        e.position || 'after_char',
            extensions:      {}
        }))
    };
}

const BROWSER_HEADERS = {
    'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept':             'application/json, text/plain, */*',
    'Accept-Language':    'en-US,en;q=0.9',
    'Origin':             'https://janitorai.com',
    'Referer':            'https://janitorai.com/',
    'sec-ch-ua':          '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile':   '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest':     'empty',
    'Sec-Fetch-Mode':     'cors',
    'Sec-Fetch-Site':     'same-site',
};

// ── JSON 응답에서 로어북 항목 재귀 탐색 ─────────────────────────
function extractLoreEntries(obj, depth = 0) {
    if (!obj || depth > 5) return null;
    // 직접 entries 배열
    if (Array.isArray(obj.entries) && obj.entries.length > 0) return obj.entries;
    if (Array.isArray(obj.items)   && obj.items.length > 0)   return obj.items;
    if (Array.isArray(obj.lore_items) && obj.lore_items.length > 0) return obj.lore_items;
    // 배열 자체가 항목 목록인 경우
    if (Array.isArray(obj) && obj.length > 0 && (obj[0].content || obj[0].keys || obj[0].key)) return obj;
    // 중첩 구조
    if (obj.lorebook) return extractLoreEntries(obj.lorebook, depth + 1);
    if (obj.world_info) return extractLoreEntries(obj.world_info, depth + 1);
    if (obj.script) return extractLoreEntries(obj.script, depth + 1);
    if (obj.data) return extractLoreEntries(obj.data, depth + 1);
    return null;
}

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 백엔드 서버 완벽 로드 완료!");
    console.log("================================================");

    // A. JannyAI → PNG URL
    async function tryJannyApi(uuid) {
        const res = await fetch('https://api.jannyai.com/api/v1/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
            body: JSON.stringify({ characterId: uuid })
        });
        if (!res.ok) throw new Error(`JannyAI HTTP ${res.status}`);
        const data = await res.json();
        if (data.status !== 'ok' || !data.downloadUrl) throw new Error('downloadUrl 없음');
        return data.downloadUrl;
    }

    // B. datacat 폴백
    async function tryDatacat(uuid) {
        const res = await fetch(`https://datacat.run/retrieve?uuid=${uuid}`, {
            headers: { ...BROWSER_HEADERS }
        });
        if (!res.ok) throw new Error(`datacat HTTP ${res.status}`);
        const data = await res.json();
        return data.downloadUrl || data.url || data.download_url || (() => { throw new Error('URL 없음'); })();
    }

    // C. 로어북 가져오기 - 모든 가능한 방법 시도 + 상세 로깅
    async function fetchLorebook(charUuid, scriptUuids = []) {
        // 방법 1: 캐릭터 API에서 scripts/lorebook 필드 포함 여부 확인
        const charEndpoints = [
            `https://janitorai.com/hampter/characters/${charUuid}`,
            `https://janitorai.com/api/v1/characters/${charUuid}`,
        ];
        for (const url of charEndpoints) {
            try {
                const res = await fetch(url, { headers: BROWSER_HEADERS });
                console.log(`[Janitor] ${url} → HTTP ${res.status}`);
                if (!res.ok) continue;
                const json = await res.json();
                const topKeys = Object.keys(json).join(', ');
                console.log(`[Janitor] 캐릭터 API 응답 키: ${topKeys}`);

                // scripts 배열 있는지 확인
                if (json.scripts) {
                    console.log(`[Janitor] scripts 필드 발견:`, JSON.stringify(json.scripts).slice(0, 300));
                }
                if (json.character?.scripts) {
                    console.log(`[Janitor] character.scripts 발견:`, JSON.stringify(json.character.scripts).slice(0, 300));
                }

                const entries = extractLoreEntries(json);
                if (entries) {
                    console.log(`[Janitor] ✅ 캐릭터 API에서 로어북 ${entries.length}개 발견`);
                    return buildCharacterBook(entries);
                }

                // scripts UUID가 응답에 있으면 수집
                const foundScripts = [];
                function collectScriptIds(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    if (obj.scripts && Array.isArray(obj.scripts)) {
                        obj.scripts.forEach(s => s?.id && foundScripts.push(s.id));
                    }
                    for (const v of Object.values(obj)) {
                        if (typeof v === 'object') collectScriptIds(v);
                    }
                }
                collectScriptIds(json);
                if (foundScripts.length > 0) {
                    console.log(`[Janitor] 스크립트 UUID 발견:`, foundScripts);
                    scriptUuids = [...new Set([...scriptUuids, ...foundScripts])];
                }
            } catch(e) {
                console.log(`[Janitor] ${url} 오류: ${e.message}`);
            }
        }

        // 방법 2: 캐릭터의 scripts 엔드포인트
        const scriptListEndpoints = [
            `https://janitorai.com/hampter/characters/${charUuid}/scripts`,
            `https://janitorai.com/api/v1/characters/${charUuid}/scripts`,
            `https://janitorai.com/hampter/characters/${charUuid}/lorebooks`,
        ];
        for (const url of scriptListEndpoints) {
            try {
                const res = await fetch(url, { headers: BROWSER_HEADERS });
                console.log(`[Janitor] ${url} → HTTP ${res.status}`);
                if (!res.ok) continue;
                const json = await res.json();
                console.log(`[Janitor] 스크립트 목록 응답:`, JSON.stringify(json).slice(0, 300));
                const entries = extractLoreEntries(json);
                if (entries) return buildCharacterBook(entries);
            } catch(e) {}
        }

        // 방법 3: 알려진 스크립트 UUID 직접 조회
        if (scriptUuids.length > 0) {
            console.log(`[Janitor] 스크립트 직접 조회 시도:`, scriptUuids);
            const allEntries = [];
            for (const sid of scriptUuids) {
                const endpoints = [
                    `https://janitorai.com/hampter/scripts/${sid}`,
                    `https://janitorai.com/api/v1/scripts/${sid}`,
                    `https://janitorai.com/api/scripts/${sid}`,
                ];
                for (const url of endpoints) {
                    try {
                        const res = await fetch(url, { headers: BROWSER_HEADERS });
                        console.log(`[Janitor] 스크립트 ${url} → HTTP ${res.status}`);
                        if (!res.ok) continue;
                        const json = await res.json();
                        console.log(`[Janitor] 스크립트 응답 키:`, Object.keys(json).join(', '));
                        console.log(`[Janitor] 스크립트 응답 미리보기:`, JSON.stringify(json).slice(0, 500));
                        const entries = extractLoreEntries(json);
                        if (entries) {
                            allEntries.push(...entries);
                            console.log(`[Janitor] ✅ 스크립트 ${sid}에서 ${entries.length}개 항목`);
                            break;
                        }
                    } catch(e) {}
                }
            }
            if (allEntries.length > 0) return buildCharacterBook(allEntries);
        }

        console.log('[Janitor] ⚠️ 모든 로어북 방법 실패');
        return null;
    }

    // ── 메인 라우트 ───────────────────────────────────────────────
    router.post('/fetch', async (req, res) => {
        try {
            const { url, scriptUuids } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL 필요' });

            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'UUID를 찾을 수 없습니다.' });
            const uuid = m[0];

            // 1. PNG URL 획득
            let downloadUrl, source = 'janny';
            try {
                downloadUrl = await tryJannyApi(uuid);
                console.log('[Janitor] ✅ JannyAI PNG URL 획득');
            } catch (e1) {
                console.log(`[Janitor] JannyAI 실패(${e1.message}), datacat...`);
                downloadUrl = await tryDatacat(uuid);
                source = 'datacat';
            }

            // 2. PNG 다운로드
            const pngRes = await fetch(downloadUrl, { headers: BROWSER_HEADERS });
            if (!pngRes.ok) throw new Error(`PNG 다운로드 실패 HTTP ${pngRes.status}`);
            let pngBuf = Buffer.from(await pngRes.arrayBuffer());
            console.log(`[Janitor] ✅ PNG ${pngBuf.length} bytes`);

            // 3. 카드 V2 변환
            let card = toV2Card(readCharaCard(pngBuf));
            if (!card) card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: uuid } };
            console.log(`[Janitor] 카드: ${card.data.name}, spec=${card.spec}`);

            // 4. 로어북 획득 (프론트에서 전달한 스크립트 UUID 있으면 우선 사용)
            const extraScripts = Array.isArray(scriptUuids) ? scriptUuids : [];
            const lorebook = await fetchLorebook(uuid, extraScripts);
            if (lorebook) {
                card.data.character_book = lorebook;
                console.log(`[Janitor] ✅ 로어북 ${lorebook.entries.length}개 항목 임베드`);
            }

            // 5. PNG 재조립
            const newB64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
            pngBuf = rebuildPng(pngBuf, { chara: newB64 });

            res.json({ success: true, pngBase64: pngBuf.toString('base64'), charName: card.data.name || uuid });

        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = { init, info };
