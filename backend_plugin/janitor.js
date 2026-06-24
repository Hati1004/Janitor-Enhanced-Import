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

// ── PNG 재조립: 기존 tEXt 청크 교체 + IEND 직전 삽입 ────────────
function rebuildPng(pngBuf, textChunks) {
    const chunks = readAllChunks(pngBuf);
    const replaceKeys = new Set(Object.keys(textChunks));
    const parts = [pngBuf.slice(0, 8)]; // PNG 시그니처

    for (const chunk of chunks) {
        if (chunk.type === 'IEND') {
            // 새 tEXt 청크들을 IEND 직전에 삽입
            for (const [kw, val] of Object.entries(textChunks)) {
                parts.push(makeTEXtChunk(kw, val));
            }
            parts.push(pngBuf.slice(chunk.offset)); // IEND 포함 나머지
            break;
        }
        // 교체 대상 tEXt 청크는 건너뜀
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

// ── PNG에서 chara 카드 JSON 읽기 ─────────────────────────────────
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

// ── V3 카드 → V2 카드 변환 (ST 1.18 호환) ───────────────────────
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
            // firstMessage 관련 모든 카멜케이스 대응
            first_mes:                  pick(d.first_mes, card.first_mes, d.firstMessage, card.firstMessage, d.first_message, card.first_message) || '',
            mes_example:                pick(d.mes_example, card.mes_example, d.exampleDialogs, card.exampleDialogs) || '',
            creator_notes:              pick(d.creator_notes, card.creatorcomment, d.creatorNotes, card.creatorNotes) || '',
            system_prompt:              pick(d.system_prompt, card.systemPrompt)                                     || '',
            post_history_instructions:  pick(d.post_history_instructions, card.postHistoryInstructions)             || '',
            tags:                       pick(d.tags, card.tags, d.customTags, card.customTags)                      || [],
            creator:                    pick(d.creator, card.creator, d.creatorName, card.creatorName)              || '',
            character_version:          pick(d.character_version, card.characterVersion)                            || '',
            // alternateGreetings 관련 모든 카멜케이스 대응 (멀티그리팅 누락 방지)
            alternate_greetings:        pick(d.alternate_greetings, card.alternate_greetings, d.altGreetings, card.altGreetings, d.alternateGreetings, card.alternateGreetings) || [],
            character_book:             pick(d.character_book, card.character_book)                                 || null,
            extensions:                 pick(d.extensions, card.extensions)                                         || {},
        }
    };
    if (!v2.data.character_book) delete v2.data.character_book;
    return v2;
}

// ── 로어북 항목 → V2 character_book 변환 ────────────────────────
function buildCharacterBook(entries) {
    if (!entries || !Array.isArray(entries) || entries.length === 0) return null;
    return {
        name: '',
        description: '',
        scan_depth: 2,
        token_budget: 2048,
        recursive_scanning: false,
        extensions: {},
        entries: entries.map((e, i) => {
            const baseKeys = Array.isArray(e.keys)     ? e.keys     :
                             Array.isArray(e.keywords) ? e.keywords :
                             e.key ? [e.key] : [];
            const triggerKeys = Array.isArray(e.triggers) ? e.triggers : [];
            const mergedKeys = [...new Set([...baseKeys, ...triggerKeys])];
            return {
                keys:            mergedKeys,
                secondary_keys:  [],
                comment:         e.comment || e.name || e.title || '',
                content:         e.content || e.value || e.text || '',
                constant:        Boolean(e.constant),
                selective:       Boolean(e.selective),
                insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : i,
                enabled:         e.enabled !== false,
                position:        e.position || 'after_char',
                extensions:      {}
            };
        })
    };
}

// ── 공통 브라우저 헤더 ───────────────────────────────────────────
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

function init(router) {
    console.log("================================================");
    console.log("[Janitor 플러그인] 🟢 백엔드 서버 완벽 로드 완료!");
    console.log("================================================");

    async function tryJannyApi(uuid) {
        const res = await fetch('https://api.jannyai.com/api/v1/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
            body: JSON.stringify({ characterId: uuid })
        });
        if (!res.ok) throw new Error(`JannyAI HTTP ${res.status}`);
        const data = await res.json();
        if (data.status !== 'ok' || !data.downloadUrl) throw new Error('downloadUrl 없음');
        return { downloadUrl: data.downloadUrl, raw: data };
    }

    // B. datacat 추출 로직 수정 (인증이 필요 없는 modal 엔드포인트 사용)
    async function tryDatacatCore(uuid) {
        const url = `https://datacat.run/api/characters/${uuid}?view=modal&sourceKind=janitor`;
        const res = await fetch(url, { headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' } });
        if (!res.ok) throw new Error(`datacat modal HTTP ${res.status}`);
        const data = await res.json();
        console.log('[Janitor][DEBUG] datacat modal 응답 성공, 키 목록:', Object.keys(data).join(', '));
        return { cardJson: data, raw: data };
    }

    async function tryDatacat(uuid) {
        const res = await fetch(`https://datacat.run/retrieve?uuid=${uuid}`, {
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`datacat HTTP ${res.status}`);
        const data = await res.json();
        const dlUrl = data.downloadUrl || data.url || data.download_url;
        if (!dlUrl) throw new Error('datacat URL 없음');
        return { downloadUrl: dlUrl, raw: data };
    }

    async function fetchScriptLorebook(scriptUuid) {
        const endpoints = [
            `https://janitorai.com/hampter/script/${scriptUuid}`,
            `https://janitorai.com/hampter/scripts/${scriptUuid}`,
            `https://janitorai.com/api/v1/scripts/${scriptUuid}`,
            `https://janitorai.com/api/scripts/${scriptUuid}`,
        ];
        for (const url of endpoints) {
            try {
                const res = await fetch(url, { headers: BROWSER_HEADERS });
                if (!res.ok) continue;
                const json = await res.json();
                console.log(`[Janitor] ✅ 외부 스크립트 응답 획득 (${url})`);
                return json;
            } catch(e) {}
        }
        return null;
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function findScriptUuidsInObject(obj, uuids = new Set(), seen = new WeakSet()) {
        if (!obj || typeof obj !== 'object') return uuids;
        if (seen.has(obj)) return uuids;
        seen.add(obj);

        const scriptKeyHints = ['script', 'scripts', 'lorebook', 'lorebooks', 'world_info', 'worldinfo', 'attachedscripts', 'extensions'];

        if (Array.isArray(obj)) {
            for (const item of obj) findScriptUuidsInObject(item, uuids, seen);
            return uuids;
        }

        for (const [k, v] of Object.entries(obj)) {
            const keyLower = k.toLowerCase();
            const keyLooksScripty = scriptKeyHints.some(h => keyLower.includes(h));

            if (typeof v === 'string' && UUID_RE.test(v) && keyLooksScripty) {
                uuids.add(v);
            } else if (Array.isArray(v) && keyLooksScripty) {
                for (const item of v) {
                    if (typeof item === 'string' && UUID_RE.test(item)) uuids.add(item);
                    else if (item && typeof item === 'object') {
                        const idVal = item.id || item.uuid || item.script_id || item.scriptId;
                        if (typeof idVal === 'string' && UUID_RE.test(idVal)) uuids.add(idVal);
                        findScriptUuidsInObject(item, uuids, seen);
                    }
                }
            } else if (v && typeof v === 'object') {
                findScriptUuidsInObject(v, uuids, seen);
            }
        }
        return uuids;
    }

    async function scrapeScriptUuids(characterPageUrl) {
        try {
            const res = await fetch(characterPageUrl, { headers: { ...BROWSER_HEADERS, 'Accept': 'text/html' } });
            if (!res.ok) return [];
            const html = await res.text();
            const scriptPattern = /\/scripts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
            const uuids = new Set();
            let m;
            while ((m = scriptPattern.exec(html)) !== null) uuids.add(m[1]);
            return [...uuids];
        } catch(e) {
            return [];
        }
    }

    async function buildFinalPng(uuid, characterPageUrl) {
        let card = null;
        let rawMeta = null;
        let avatarPngBuf = null;
        let source = 'unknown';

        // 1. datacat 인증 없는 엔드포인트 사용 (멀티그리팅 확보 목적)
        try {
            const r = await tryDatacatCore(uuid);
            rawMeta = r.raw;
            source = 'datacat_modal';
            card = r.cardJson?.data ? r.cardJson : { spec: 'chara_card_v2', spec_version: '2.0', data: r.cardJson };
            const rawAg = card.data?.alternate_greetings || card.data?.alternateGreetings || [];
            console.log(`[Janitor] ✅ datacat 카드 획득. 대체 인사말 개수: ${rawAg.length}`);
        } catch (e0) {
            console.log(`[Janitor] datacat 모달 실패(${e0.message}), JannyAI로 폴백...`);
        }

        // 2. 아바타 PNG 다운로드
        let downloadUrl = null;
        try {
            const r = await tryJannyApi(uuid);
            downloadUrl = r.downloadUrl;
            if (!rawMeta) rawMeta = r.raw;
            if (source === 'unknown') source = 'janny';
        } catch (e1) {
            try {
                const r = await tryDatacat(uuid);
                downloadUrl = r.downloadUrl;
                if (!rawMeta) rawMeta = r.raw;
                if (source === 'unknown') source = 'datacat_legacy';
            } catch (e2) {}
        }

        if (downloadUrl) {
            const pngRes = await fetch(downloadUrl, { headers: BROWSER_HEADERS });
            if (pngRes.ok) avatarPngBuf = Buffer.from(await pngRes.arrayBuffer());
        }

        if (!avatarPngBuf) throw new Error('PNG 베이스 이미지를 가져오지 못했습니다.');

        // 3. 카드 데이터 정규화
        if (!card) card = readCharaCard(avatarPngBuf);
        card = toV2Card(card);
        if (!card) card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: uuid } };

        // 4. 로어북 추출 로직 강화 (Datacat 자체 응답에 묶여 있는 데이터 우선 추출)
        let allEntries = [];
        const scriptUuidSet = new Set();

        if (rawMeta) {
            // 외부 요청 없이 JSON 객체 내부에 바로 들어있는 로어북 항목 스캔
            const possibleEmbeds = [rawMeta.lorebook, rawMeta.lorebooks, rawMeta.character_book, rawMeta.characterBook, card?.data?.character_book];
            for (const pb of possibleEmbeds) {
                if (pb && Array.isArray(pb.entries)) allEntries.push(...pb.entries);
                else if (Array.isArray(pb) && pb.length > 0 && (pb[0].keys || pb[0].content)) allEntries.push(...pb);
            }
            // 임베드된 것이 없다면 UUID 수집
            if (allEntries.length === 0) {
                for (const u of findScriptUuidsInObject(rawMeta)) scriptUuidSet.add(u);
            }
        }

        // 추가 UUID 스크래핑
        if (card?.data) for (const u of findScriptUuidsInObject(card.data)) scriptUuidSet.add(u);
        for (const u of await scrapeScriptUuids(characterPageUrl)) scriptUuidSet.add(u);

        // 직접 찾은 항목이 없고 UUID만 있다면 쿠키 없이 통신 가능한 API로 찔러보기 시도
        if (allEntries.length === 0 && scriptUuidSet.size > 0) {
            console.log(`[Janitor] 외부 스크립트 UUID ${scriptUuidSet.size}개 확인, 추출 시도 중...`);
            for (const sid of scriptUuidSet) {
                const scriptData = await fetchScriptLorebook(sid);
                if (!scriptData) continue;
                const entries = scriptData.entries || scriptData.items || scriptData.lore_items || scriptData.lorebook?.entries || scriptData.data?.entries || (Array.isArray(scriptData) ? scriptData : null);
                if (entries && Array.isArray(entries)) allEntries.push(...entries);
            }
        }

        // 5. 로어북을 카드에 주입
        let lorebook = null;
        if (allEntries.length > 0) {
            lorebook = buildCharacterBook(allEntries);
            card.data.character_book = lorebook;
            console.log(`[Janitor] ✅ 로어북 성공적으로 추출 및 병합! (항목 수: ${allEntries.length})`);
        } else {
            console.log('[Janitor] ℹ️ 로어북을 찾지 못했거나 보안 설정에 막혔습니다.');
        }

        // 6. 완성된 V2 카드를 PNG 청크에 덮어쓰기
        const newB64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
        const pngBuf = rebuildPng(avatarPngBuf, { chara: newB64, ccv3: newB64 });

        return { pngBuf, charName: card.data.name || uuid };
    }

    function sanitizeFileName(name) {
        return String(name || 'character').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'character';
    }

    function getUniquePath(dir, baseName) {
        let candidate = path.join(dir, `${baseName}.png`);
        let n = 1;
        while (fs.existsSync(candidate)) {
            candidate = path.join(dir, `${baseName}_${n}.png`);
            n++;
        }
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
            
            if (!charactersDir) {
                return res.status(500).json({ success: false, error: '캐릭터 폴더 경로를 찾을 수 없습니다.' });
            }

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