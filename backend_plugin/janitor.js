// 위치: SillyTavern/plugins/janitor.js
const fs   = require('fs');
const path = require('path');
const info = { id: 'janitor', name: 'Datacat Proxy', description: 'Datacat 기반 완벽 추출 백엔드' };

// ── CRC32 & PNG Chunk 로직 ───────────────────────────────────────
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
            for (const [kw, val] of Object.entries(textChunks)) {
                parts.push(makeTEXtChunk(kw, val));
            }
            parts.push(pngBuf.slice(chunk.offset));
            break;
        }
        if (chunk.type === 'tEXt') {
            const nullIdx = chunk.data.indexOf(0x00);
            if (nullIdx !== -1) {
                const kw = chunk.data.slice(0, nullIdx).toString('latin1');
                if (replaceKeys.has(kw)) continue;
            }
        }
        parts.push(pngBuf.slice(chunk.offset, chunk.offset + 12 + chunk.len));
    }
    return Buffer.concat(parts);
}

function readCharaCard(pngBuf) {
    const chunks = readAllChunks(pngBuf);
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') continue;
        const nullIdx = chunk.data.indexOf(0x00);
        if (nullIdx === -1) continue;
        const kw = chunk.data.slice(0, nullIdx).toString('latin1');
        if (kw !== 'chara') continue;
        try {
            return JSON.parse(Buffer.from(chunk.data.slice(nullIdx + 1).toString('latin1'), 'base64').toString('utf8'));
        } catch(e) { return null; }
    }
    return null;
}

// ── V2 카드 포맷 및 로어북 정규화 ──────────────────────────────
function toV2Card(card) {
    if (!card) return null;
    const d = card.data || {};
    const pick = (...vals) => {
        for (const v of vals) if (v !== undefined && v !== null) return v;
        return undefined;
    };

    let rawAg = pick(d.alternate_greetings, card.alternate_greetings, d.altGreetings, card.altGreetings, d.alternateGreetings, card.alternateGreetings) || [];
    const safeAg = (Array.isArray(rawAg) ? rawAg : []).map(ag => typeof ag === 'string' ? ag : (ag.text || ag.greeting || String(ag))).filter(Boolean);

    const v2 = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name:                       pick(d.name, card.name, d.characterName, card.characterName)               || '',
            description:                pick(d.description, card.description, d.rawDescription, card.rawDescription) || '',
            personality:                pick(d.personality, card.personality)                                       || '',
            scenario:                   pick(d.scenario, card.scenario)                                             || '',
            first_mes:                  pick(d.first_mes, card.first_mes, d.firstMessage, card.firstMessage, d.first_message, card.first_message) || '',
            mes_example:                pick(d.mes_example, card.mes_example, d.exampleDialogs, card.exampleDialogs) || '',
            creator_notes:              pick(d.creator_notes, card.creatorcomment, d.creatorNotes, card.creatorNotes) || '',
            system_prompt:              pick(d.system_prompt, card.systemPrompt)                                     || '',
            post_history_instructions:  pick(d.post_history_instructions, card.postHistoryInstructions)             || '',
            tags:                       pick(d.tags, card.tags, d.customTags, card.customTags)                      || [],
            creator:                    pick(d.creator, card.creator, d.creatorName, card.creatorName)              || '',
            character_version:          pick(d.character_version, card.characterVersion)                            || '',
            alternate_greetings:        safeAg,
            character_book:             pick(d.character_book, card.character_book)                                 || null,
            extensions:                 pick(d.extensions, card.extensions)                                         || {},
        }
    };
    if (!v2.data.character_book) delete v2.data.character_book;
    return v2;
}

function buildCharacterBook(entries) {
    if (!entries || !Array.isArray(entries) || entries.length === 0) return null;
    return {
        name: '', description: '', scan_depth: 2, token_budget: 2048, recursive_scanning: false, extensions: {},
        entries: entries.map((e, i) => {
            const baseKeys = Array.isArray(e.keys) ? e.keys : Array.isArray(e.keywords) ? e.keywords : e.key ? [e.key] : [];
            const triggerKeys = Array.isArray(e.triggers) ? e.triggers : [];
            const mergedKeys = [...new Set([...baseKeys, ...triggerKeys])];
            return {
                keys: mergedKeys, secondary_keys: [], comment: e.comment || e.name || e.title || '',
                content: e.content || e.value || e.text || '', constant: Boolean(e.constant), selective: Boolean(e.selective),
                insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : i,
                enabled: e.enabled !== false, position: e.position || 'after_char', extensions: {}
            };
        })
    };
}

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/html, */*'
};

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 Datacat 전용 데이터 추출 모듈 로드 완료!");
    console.log("================================================");

    // 1. 데이터캣 캐시 강제 갱신 트리거 (사용자가 말한 Re-run retrieval 자동화)
    async function triggerDatacatSync(uuid, userCookie) {
        if (!userCookie) return;
        try {
            console.log(`[Janitor] 🔄 Datacat 최신 데이터 동기화(Re-run retrieval) 트리거 전송 중...`);
            await fetch(`https://datacat.run/api/characters/${uuid}/retrieve`, {
                method: 'POST',
                headers: { 'Cookie': userCookie, 'User-Agent': BROWSER_HEADERS['User-Agent'] }
            });
            // 갱신될 시간을 벌어줌
            await new Promise(resolve => setTimeout(resolve, 1500)); 
            console.log(`[Janitor] ✅ Datacat 동기화 완료 대기 끝!`);
        } catch(e) {
            console.log(`[Janitor] ℹ️ 동기화 트리거 무시됨: ${e.message}`);
        }
    }

    // 2. 데이터캣 핵심 데이터 추출
    async function fetchFromDatacat(uuid, userCookie) {
        let rawData = null;
        let lorebooks = [];

        const headers = { ...BROWSER_HEADERS };
        if (userCookie) {
            headers['Cookie'] = userCookie;
            console.log(`[Janitor] 🔑 사용자 제공 Datacat 쿠키 적용 완료. 접속 시도...`);
        } else {
            console.log(`[Janitor] ⚠️ Datacat 쿠키가 없습니다. (401 에러 발생 가능성 높음)`);
        }

        const urls = [
            `https://datacat.run/api/characters/${uuid}?view=modal&sourceKind=janitor`,
            `https://datacat.run/api/characters/${uuid}/download?variant=janitor_core`,
            `https://datacat.run/characters/${uuid}`
        ];

        for (const url of urls) {
            try {
                const res = await fetch(url, { headers });
                if (!res.ok) {
                    console.log(`[Janitor] Datacat 요청 실패 (${url}) -> HTTP ${res.status}`);
                    continue;
                }

                const contentType = res.headers.get('content-type') || '';
                
                // API JSON 응답인 경우
                if (contentType.includes('application/json')) {
                    const json = await res.json();
                    if (json.name || (json.data && json.data.name)) {
                        console.log(`[Janitor] ✅ Datacat API (JSON) 데이터 획득 성공!`);
                        rawData = json;
                        break;
                    }
                } 
                // HTML 응답인 경우 (Next.js 내부 데이터 스크래핑)
                else {
                    const html = await res.text();
                    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
                    if (match) {
                        const nextData = JSON.parse(match[1]);
                        
                        // 객체 트리를 뒤져서 캐릭터와 로어북 추출
                        function searchTree(obj) {
                            if (!obj || typeof obj !== 'object') return;
                            if (obj.name && (obj.first_message || obj.firstMessage || obj.description)) {
                                if (obj.id === uuid || obj.characterId === uuid || obj.creator_id || obj.creatorId) {
                                    if (!rawData) rawData = obj;
                                }
                            }
                            if (Array.isArray(obj.entries) && obj.entries.length > 0 && (obj.entries[0].keys || obj.entries[0].content)) {
                                lorebooks.push(...obj.entries);
                            } else if (Array.isArray(obj) && obj.length > 0 && (obj[0].keys || obj[0].content) && !obj[0].name) {
                                if(obj[0].position !== undefined || obj[0].insertion_order !== undefined || obj[0].keys) {
                                    lorebooks.push(...obj);
                                }
                            }
                            for (const key in obj) searchTree(obj[key]);
                        }
                        searchTree(nextData);

                        if (rawData) {
                            if (lorebooks.length > 0) rawData.character_book = { entries: lorebooks };
                            console.log(`[Janitor] ✅ Datacat HTML 파싱 데이터 획득 성공!`);
                            break;
                        }
                    }
                }
            } catch(e) {
                console.log(`[Janitor] Datacat 통신 에러: ${e.message}`);
            }
        }
        return rawData;
    }

    async function buildFinalPng(uuid, userCookie) {
        // 이미지 확보 (인증 없는 JannyAI 활용)
        let avatarPngBuf = null;
        try {
            const jRes = await fetch('https://api.jannyai.com/api/v1/download', {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS }, body: JSON.stringify({ characterId: uuid })
            });
            const jData = await jRes.json();
            if (jData.downloadUrl) {
                const pngRes = await fetch(jData.downloadUrl, { headers: BROWSER_HEADERS });
                if (pngRes.ok) avatarPngBuf = Buffer.from(await pngRes.arrayBuffer());
            }
        } catch(e) {}
        
        if (!avatarPngBuf) throw new Error('캐릭터 이미지를 가져오는데 실패했습니다.');

        // 데이터캣 최신화 후 긁어오기
        await triggerDatacatSync(uuid, userCookie);
        const charData = await fetchFromDatacat(uuid, userCookie);

        // 데이터 병합
        let card = toV2Card(charData);
        if (!card) {
            console.log(`[Janitor] ⚠️ Datacat 털기 실패. 임베드 데이터로 폴백합니다.`);
            card = readCharaCard(avatarPngBuf);
            card = toV2Card(card);
            if (!card) card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: uuid } };
        }

        if (card.data.character_book && card.data.character_book.entries) {
            card.data.character_book = buildCharacterBook(card.data.character_book.entries);
            console.log(`[Janitor] ✅ 로어북 병합 완료`);
        } else {
            console.log('[Janitor] ℹ️ 추출된 로어북 데이터가 없습니다.');
        }

        if (card.data.alternate_greetings && card.data.alternate_greetings.length > 0) {
            console.log(`[Janitor] ✅ 다중 인사말 ${card.data.alternate_greetings.length}개 병합 완료!`);
        } else {
            console.log(`[Janitor] ℹ️ 추출된 다중 인사말이 없습니다.`);
        }

        const newB64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
        const pngBuf = rebuildPng(avatarPngBuf, { chara: newB64, ccv3: newB64 });

        return { pngBuf, charName: card.data.name || uuid };
    }

    function sanitizeFileName(name) { return String(name || 'character').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'character'; }
    function getUniquePath(dir, baseName) {
        let candidate = path.join(dir, `${baseName}.png`), n = 1;
        while (fs.existsSync(candidate)) { candidate = path.join(dir, `${baseName}_${n}.png`); n++; }
        return candidate;
    }

    router.post('/fetch', async (req, res) => {
        try {
            const { url, cookie } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 필요합니다.' });
            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            
            const { pngBuf, charName } = await buildFinalPng(m[0], cookie);
            res.json({ success: true, pngBase64: pngBuf.toString('base64'), charName });
        } catch (err) { res.status(500).json({ success: false, error: err.message }); }
    });

    router.post('/fetch-and-save', async (req, res) => {
        try {
            const { url, cookie } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 필요합니다.' });
            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            
            const { pngBuf, charName } = await buildFinalPng(m[0], cookie);
            const charactersDir = req.user?.directories?.characters;
            
            if (!charactersDir) return res.status(500).json({ success: false, error: '캐릭터 폴더 경로를 찾을 수 없습니다.' });
            if (!fs.existsSync(charactersDir)) fs.mkdirSync(charactersDir, { recursive: true });

            const safeName  = sanitizeFileName(charName);
            const finalPath = getUniquePath(charactersDir, safeName);
            fs.writeFileSync(finalPath, pngBuf);

            res.json({ success: true, charName, fileName: path.basename(finalPath) });
        } catch (err) { res.status(500).json({ success: false, error: err.message }); }
    });
}

module.exports = { init, info };