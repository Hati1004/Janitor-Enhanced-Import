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
// ST의 /api/characters/import는 spec_version 2.0만 받음
function toV2Card(card) {
    if (!card) return null;
    // 이미 V2면 그대로
    if (card.spec === 'chara_card_v2' || card.spec_version === '2.0') return card;

    const d = card.data || {};
    // V1 flat 구조도 처리
    const v2 = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name:                       d.name                      || card.name                      || '',
            description:                d.description               || card.description               || '',
            personality:                d.personality               || card.personality               || '',
            scenario:                   d.scenario                  || card.scenario                  || '',
            first_mes:                  d.first_mes                 || card.first_mes                 || '',
            mes_example:                d.mes_example               || card.mes_example               || '',
            creator_notes:              d.creator_notes             || card.creatorcomment            || '',
            system_prompt:              d.system_prompt             || '',
            post_history_instructions:  d.post_history_instructions || '',
            tags:                       d.tags                      || card.tags                      || [],
            creator:                    d.creator                   || card.creator                   || '',
            character_version:          d.character_version         || '',
            alternate_greetings:        d.alternate_greetings       || [],
            character_book:             d.character_book            || null,
            extensions:                 d.extensions                || {},
        }
    };
    // null인 character_book은 제거
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
        entries: entries.map((e, i) => ({
            keys:            Array.isArray(e.keys)     ? e.keys     :
                             Array.isArray(e.keywords) ? e.keywords :
                             e.key ? [e.key] : [],
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

    // A. JannyAI API → PNG downloadUrl
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
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`datacat HTTP ${res.status}`);
        const data = await res.json();
        const dlUrl = data.downloadUrl || data.url || data.download_url;
        if (!dlUrl) throw new Error('datacat URL 없음');
        return dlUrl;
    }

    // C. 로어북 스크립트 가져오기 (scripts UUID 목록으로 직접 조회)
    // JanitorAI는 로어북을 /scripts/<uuid> 로 공개하고 캐릭터 페이지에서 참조함
    async function fetchScriptLorebook(scriptUuid) {
        const endpoints = [
            `https://janitorai.com/hampter/scripts/${scriptUuid}`,
            `https://janitorai.com/api/v1/scripts/${scriptUuid}`,
            `https://janitorai.com/api/scripts/${scriptUuid}`,
        ];
        for (const url of endpoints) {
            try {
                const res = await fetch(url, { headers: BROWSER_HEADERS });
                if (!res.ok) continue;
                const json = await res.json();
                console.log(`[Janitor] 스크립트 응답 키 (${url}):`, Object.keys(json).join(', '));
                return json;
            } catch(e) { /* 다음 시도 */ }
        }
        return null;
    }

    // D. 캐릭터 페이지 HTML 파싱으로 스크립트 UUID 목록 추출
    async function scrapeScriptUuids(characterPageUrl) {
        try {
            const res = await fetch(characterPageUrl, {
                headers: { ...BROWSER_HEADERS, 'Accept': 'text/html' }
            });
            if (!res.ok) return [];
            const html = await res.text();
            // janitorai.com/scripts/<uuid> 패턴 추출
            const scriptPattern = /\/scripts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
            const uuids = new Set();
            let m;
            while ((m = scriptPattern.exec(html)) !== null) {
                uuids.add(m[1]);
            }
            // __NEXT_DATA__ JSON에서도 추출
            const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (nextDataMatch) {
                try {
                    const nextData = JSON.parse(nextDataMatch[1]);
                    const str = JSON.stringify(nextData);
                    let m2;
                    const p2 = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
                    // 스크립트 관련 키 탐색
                    function findScripts(obj) {
                        if (!obj || typeof obj !== 'object') return;
                        for (const [k, v] of Object.entries(obj)) {
                            if (k === 'scripts' || k === 'lorebooks' || k === 'world_info') {
                                if (Array.isArray(v)) v.forEach(s => s?.id && uuids.add(s.id));
                            }
                            if (typeof v === 'object') findScripts(v);
                        }
                    }
                    findScripts(nextData);
                } catch(e) {}
            }
            console.log(`[Janitor] 캐릭터 페이지에서 스크립트 UUID 발견:`, [...uuids]);
            return [...uuids];
        } catch(e) {
            console.log('[Janitor] 페이지 스크래핑 실패:', e.message);
            return [];
        }
    }

    // E. 메인: PNG + 로어북 조합
    async function buildFinalPng(uuid, characterPageUrl) {
        // 1. PNG URL 획득
        let downloadUrl, source = 'janny';
        try {
            downloadUrl = await tryJannyApi(uuid);
            console.log('[Janitor] ✅ JannyAI PNG URL 획득');
        } catch (e1) {
            console.log(`[Janitor] JannyAI 실패(${e1.message}), datacat 시도...`);
            downloadUrl = await tryDatacat(uuid);
            source = 'datacat';
            console.log('[Janitor] ✅ datacat PNG URL 획득');
        }

        // 2. PNG 다운로드
        const pngRes = await fetch(downloadUrl, { headers: BROWSER_HEADERS });
        if (!pngRes.ok) throw new Error(`PNG 다운로드 실패 HTTP ${pngRes.status}`);
        let pngBuf = Buffer.from(await pngRes.arrayBuffer());
        console.log(`[Janitor] ✅ PNG ${pngBuf.length} bytes (소스: ${source})`);

        // 3. 기존 카드 읽기 + V2 변환
        let card = readCharaCard(pngBuf);
        card = toV2Card(card);
        if (!card) {
            card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: uuid } };
        }
        console.log(`[Janitor] 카드 변환: spec=${card.spec} v=${card.spec_version}`);

        // 4. 로어북 획득: 캐릭터 페이지 스크래핑 → 스크립트 API 호출
        let lorebook = null;
        const scriptUuids = await scrapeScriptUuids(characterPageUrl);
        if (scriptUuids.length > 0) {
            const allEntries = [];
            for (const sid of scriptUuids) {
                const scriptData = await fetchScriptLorebook(sid);
                if (!scriptData) continue;
                // 다양한 응답 구조 처리
                const entries = scriptData.entries    || scriptData.items      ||
                                scriptData.lore_items || scriptData.lorebook?.entries ||
                                (Array.isArray(scriptData) ? scriptData : null);
                if (entries && Array.isArray(entries)) {
                    allEntries.push(...entries);
                    console.log(`[Janitor] 스크립트 ${sid}: 항목 ${entries.length}개`);
                }
            }
            if (allEntries.length > 0) {
                lorebook = buildCharacterBook(allEntries);
                console.log(`[Janitor] ✅ 로어북 총 ${allEntries.length}개 항목`);
            }
        }

        // 5. 카드에 로어북 주입
        if (lorebook) {
            card.data.character_book = lorebook;
        } else {
            console.log('[Janitor] ℹ️ 로어북 없음 (비공개 or API 변경)');
        }

        // 6. V2 카드를 PNG에 임베드 (chara + ccv3 둘 다 교체하여 충돌 방지)
        const newB64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
        // ccv3 청크도 같은 내용으로 덮어써서 ST가 혼동하지 않게 함
        pngBuf = rebuildPng(pngBuf, { chara: newB64, ccv3: newB64 });

        return { pngBuf, charName: card.data.name || uuid };
    }

    // ── 메인 라우트 ───────────────────────────────────────────────
    router.post('/fetch', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 필요합니다.' });

            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            const uuid = m[0];

            const { pngBuf, charName } = await buildFinalPng(uuid, url);

            res.json({
                success:   true,
                pngBase64: pngBuf.toString('base64'),
                charName:  charName
            });

        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = { init, info };
