// 위치: SillyTavern/plugins/janitor.js
const fs   = require('fs');
const path = require('path');
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

// ── PNG tEXt 청크 생성 ───────────────────────────────────────────
function makeTEXtChunk(keyword, text) {
    const typeTag = Buffer.from('tEXt');
    const data    = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
    const lenBuf  = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf  = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeTag, data])), 0);
    return Buffer.concat([lenBuf, typeTag, data, crcBuf]);
}

// ── PNG 청크 읽기 ────────────────────────────────────────────────
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

// ── PNG 재조립 ───────────────────────────────────────────────────
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

// ── PNG에서 카드 JSON 읽기 ───────────────────────────────────────
function readCharaCard(pngBuf) {
    const chunks = readAllChunks(pngBuf);
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') continue;
        const nullIdx = chunk.data.indexOf(0x00);
        if (nullIdx === -1) continue;
        const kw = chunk.data.slice(0, nullIdx).toString('latin1');
        if (kw !== 'chara') continue;
        try {
            const val = chunk.data.slice(nullIdx + 1).toString('latin1');
            return JSON.parse(Buffer.from(val, 'base64').toString('utf8'));
        } catch(e) { return null; }
    }
    return null;
}

// ── V2 카드 변환 (카멜케이스/스네이크케이스 혼용 완벽 방어) ───────
function toV2Card(card) {
    if (!card) return null;
    if ((card.spec === 'chara_card_v2' || card.spec_version === '2.0') && card.data && 'first_mes' in card.data) {
        return card;
    }

    const d = card.data || {};
    const pick = (...vals) => {
        for (const v of vals) if (v !== undefined && v !== null) return v;
        return undefined;
    };

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
            alternate_greetings:        pick(d.alternate_greetings, card.alternate_greetings, d.altGreetings, card.altGreetings, d.alternateGreetings, card.alternateGreetings) || [],
            character_book:             pick(d.character_book, card.character_book)                                 || null,
            extensions:                 pick(d.extensions, card.extensions)                                         || {},
        }
    };
    if (!v2.data.character_book) delete v2.data.character_book;
    return v2;
}

// ── 로어북 포맷팅 ────────────────────────────────────────────────
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

// ── 헤더 분리 (제일 중요: Datacat 401 에러 방지) ─────────────────
const BROWSER_HEADERS = {
    'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept':             'application/json, text/plain, */*',
    'Origin':             'https://janitorai.com',
    'Referer':            'https://janitorai.com/',
};

// 데이터캣 전용: 오리진을 datacat.run으로 위장하여 CORS 및 봇 차단 우회
const DATACAT_HEADERS = {
    'User-Agent':         BROWSER_HEADERS['User-Agent'],
    'Accept':             'application/json, text/plain, */*',
    'Origin':             'https://datacat.run',
    'Referer':            'https://datacat.run/',
    'Sec-Fetch-Site':     'same-origin',
    'Sec-Fetch-Mode':     'cors',
    'Sec-Fetch-Dest':     'empty'
};

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 401 우회 & HTML 스크래퍼 로드 완료!");
    console.log("================================================");

    async function tryJannyApi(uuid) {
        const res = await fetch('https://api.jannyai.com/api/v1/download', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS }, body: JSON.stringify({ characterId: uuid })
        });
        if (!res.ok) throw new Error(`JannyAI HTTP ${res.status}`);
        const data = await res.json();
        if (!data.downloadUrl) throw new Error('downloadUrl 없음');
        return { downloadUrl: data.downloadUrl, raw: data };
    }

    async function tryDatacatCore(uuid) {
        const url = `https://datacat.run/api/characters/${uuid}?view=modal&sourceKind=janitor`;
        const res = await fetch(url, { headers: DATACAT_HEADERS }); // 위장 헤더 사용
        if (!res.ok) throw new Error(`datacat modal HTTP ${res.status}`);
        const data = await res.json();
        return { cardJson: data, raw: data };
    }

    // [강력 우회기] Next.js HTML 페이지 통째로 뜯어서 JSON 추출
    async function scrapeNextDataFromHtml(url, headers) {
        try {
            const res = await fetch(url, { headers: { ...headers, 'Accept': 'text/html' } });
            if (!res.ok) return null;
            const html = await res.text();
            
            // HTML 내부에 숨겨진 Next.js 원본 상태 객체 파싱
            const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (!match) return null;
            const nextData = JSON.parse(match[1]);

            let charData = null;
            let lorebooks = [];

            // JSON 트리를 재귀적으로 뒤져서 캐릭터 데이터와 로어북 뭉치를 발굴
            function searchNode(obj) {
                if (!obj || typeof obj !== 'object') return;
                // 캐릭터 객체 판별
                if (obj.name && (obj.first_message || obj.firstMessage || obj.description) && !charData) {
                    if (obj.creator_id || obj.creatorId || obj.avatar) charData = obj;
                }
                // 로어북 객체 판별
                if (obj.entries && Array.isArray(obj.entries) && obj.entries.length > 0 && (obj.entries[0].keys || obj.entries[0].content)) {
                    lorebooks.push(...obj.entries);
                }
                for (const k in obj) searchNode(obj[k]);
            }
            searchNode(nextData);

            if (charData) {
                if (lorebooks.length > 0) charData.character_book = { entries: lorebooks };
                return charData;
            }
        } catch(e) {}
        return null;
    }

    // 보조 스크립트 탐색용
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function findScriptUuidsInObject(obj, uuids = new Set(), seen = new WeakSet()) {
        if (!obj || typeof obj !== 'object') return uuids;
        if (seen.has(obj)) return uuids;
        seen.add(obj);
        const scriptKeyHints = ['script', 'scripts', 'lorebook', 'lorebooks', 'world_info'];
        if (Array.isArray(obj)) {
            for (const item of obj) findScriptUuidsInObject(item, uuids, seen);
            return uuids;
        }
        for (const [k, v] of Object.entries(obj)) {
            const keyLooksScripty = scriptKeyHints.some(h => k.toLowerCase().includes(h));
            if (typeof v === 'string' && UUID_RE.test(v) && keyLooksScripty) uuids.add(v);
            else if (Array.isArray(v) && keyLooksScripty) {
                for (const item of v) {
                    if (typeof item === 'string' && UUID_RE.test(item)) uuids.add(item);
                    else if (item && typeof item === 'object') {
                        const idVal = item.id || item.uuid || item.script_id;
                        if (typeof idVal === 'string' && UUID_RE.test(idVal)) uuids.add(idVal);
                        findScriptUuidsInObject(item, uuids, seen);
                    }
                }
            } else if (v && typeof v === 'object') findScriptUuidsInObject(v, uuids, seen);
        }
        return uuids;
    }

    async function fetchScriptLorebook(scriptUuid) {
        const endpoints = [`https://janitorai.com/hampter/script/${scriptUuid}`, `https://janitorai.com/hampter/scripts/${scriptUuid}`];
        for (const url of endpoints) {
            try {
                const res = await fetch(url, { headers: BROWSER_HEADERS });
                if (res.ok) return await res.json();
            } catch(e) {}
        }
        return null;
    }

    async function buildFinalPng(uuid, characterPageUrl) {
        let card = null;
        let rawMeta = null;
        let avatarPngBuf = null;

        // 1. 최우선 시도: 헤더 위장된 Datacat API
        try {
            const r = await tryDatacatCore(uuid);
            rawMeta = r.raw;
            card = r.cardJson?.data ? r.cardJson : { spec: 'chara_card_v2', spec_version: '2.0', data: r.cardJson };
            console.log(`[Janitor] ✅ 데이터캣 API 획득 성공!`);
        } catch (e0) {
            console.log(`[Janitor] 데이터캣 API 실패(${e0.message}), HTML 직접 스크래핑 우회 시도...`);
            
            // 2. 우회 시도: 웹페이지 HTML 파싱 (API 차단을 근본적으로 회피)
            const htmlData = await scrapeNextDataFromHtml(`https://datacat.run/characters/${uuid}`, DATACAT_HEADERS) 
                          || await scrapeNextDataFromHtml(characterPageUrl, BROWSER_HEADERS);
            
            if (htmlData) {
                rawMeta = htmlData;
                card = { spec: 'chara_card_v2', spec_version: '2.0', data: htmlData };
                console.log(`[Janitor] ✅ HTML 스크래핑 우회 성공! (다중 인사말/로어북 포함)`);
            } else {
                console.log(`[Janitor] HTML 스크래핑도 실패, 부득이하게 JannyAI로 폴백...`);
            }
        }

        // 아바타 PNG 확보 (JannyAI 이용)
        let downloadUrl = null;
        try {
            const r = await tryJannyApi(uuid);
            downloadUrl = r.downloadUrl;
            if (!rawMeta) rawMeta = r.raw;
        } catch (e1) {
            // 구버전 데이터캣 이미지 폴백
            try {
                const res = await fetch(`https://datacat.run/retrieve?uuid=${uuid}`, { headers: DATACAT_HEADERS });
                const json = await res.json();
                downloadUrl = json.downloadUrl || json.url;
            } catch (e2) {}
        }

        if (downloadUrl) {
            const pngRes = await fetch(downloadUrl, { headers: BROWSER_HEADERS });
            if (pngRes.ok) avatarPngBuf = Buffer.from(await pngRes.arrayBuffer());
        }

        if (!avatarPngBuf) throw new Error('캐릭터의 원본 PNG 이미지를 가져오지 못했습니다.');

        // 데이터 병합 및 정규화
        if (!card) card = readCharaCard(avatarPngBuf);
        card = toV2Card(card);
        if (!card) card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: uuid } };

        // 로어북/스크립트 추출
        let allEntries = [];
        const scriptUuidSet = new Set();

        if (rawMeta) {
            // HTML이나 객체 내부에 통째로 박혀있는 로어북 즉시 추출
            const embeds = [rawMeta.lorebook, rawMeta.lorebooks, rawMeta.character_book, rawMeta.characterBook, card?.data?.character_book];
            for (const pb of embeds) {
                if (pb && Array.isArray(pb.entries)) allEntries.push(...pb.entries);
                else if (Array.isArray(pb) && pb.length > 0 && (pb[0].keys || pb[0].content)) allEntries.push(...pb);
            }
            if (allEntries.length === 0) for (const u of findScriptUuidsInObject(rawMeta)) scriptUuidSet.add(u);
        }

        if (card?.data) for (const u of findScriptUuidsInObject(card.data)) scriptUuidSet.add(u);

        // 로어북이 내부 데이터에 없으면 UUID로 통신 시도
        if (allEntries.length === 0 && scriptUuidSet.size > 0) {
            for (const sid of scriptUuidSet) {
                const scriptData = await fetchScriptLorebook(sid);
                if (!scriptData) continue;
                const entries = scriptData.entries || scriptData.items || scriptData.lorebook?.entries || scriptData.data?.entries || (Array.isArray(scriptData) ? scriptData : null);
                if (entries && Array.isArray(entries)) allEntries.push(...entries);
            }
        }

        if (allEntries.length > 0) {
            card.data.character_book = buildCharacterBook(allEntries);
            console.log(`[Janitor] ✅ 로어북 병합 완료 (총 항목 수: ${allEntries.length}개)`);
        } else {
            console.log('[Janitor] ℹ️ 이 캐릭터는 로어북이 없거나 비공개 설정되어 있습니다.');
        }

        const rawAg = card.data.alternate_greetings || [];
        if (rawAg.length > 0) console.log(`[Janitor] ✅ 다중 인사말 ${rawAg.length}개 병합 완료!`);

        // V2 카드를 PNG 청크에 덮어쓰기
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
            const { url } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 필요합니다.' });
            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            
            const { pngBuf, charName } = await buildFinalPng(m[0], url);
            res.json({ success: true, pngBase64: pngBuf.toString('base64'), charName });
        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/fetch-and-save', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 필요합니다.' });
            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            
            const { pngBuf, charName } = await buildFinalPng(m[0], url);
            const charactersDir = req.user?.directories?.characters;
            
            if (!charactersDir) return res.status(500).json({ success: false, error: '캐릭터 폴더 경로를 찾을 수 없습니다.' });
            if (!fs.existsSync(charactersDir)) fs.mkdirSync(charactersDir, { recursive: true });

            const safeName  = sanitizeFileName(charName);
            const finalPath = getUniquePath(charactersDir, safeName);
            fs.writeFileSync(finalPath, pngBuf);

            res.json({ success: true, charName, fileName: path.basename(finalPath) });
        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = { init, info };