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

    // A. JannyAI API → PNG downloadUrl
    async function tryJannyApi(uuid) {
        const res = await fetch('https://api.jannyai.com/api/v1/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
            body: JSON.stringify({ characterId: uuid })
        });
        if (!res.ok) throw new Error(`JannyAI HTTP ${res.status}`);
        const data = await res.json();
        console.log('[Janitor][DEBUG] JannyAI 원본 응답 전체:', JSON.stringify(data));
        if (data.status !== 'ok' || !data.downloadUrl) throw new Error('downloadUrl 없음');
        return { downloadUrl: data.downloadUrl, raw: data };
    }

    // B. datacat 폴백
    async function tryDatacat(uuid) {
        const res = await fetch(`https://datacat.run/retrieve?uuid=${uuid}`, {
            headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`datacat HTTP ${res.status}`);
        const data = await res.json();
        console.log('[Janitor][DEBUG] datacat 원본 응답 전체:', JSON.stringify(data));
        const dlUrl = data.downloadUrl || data.url || data.download_url;
        if (!dlUrl) throw new Error('datacat URL 없음');
        return { downloadUrl: dlUrl, raw: data };
    }

    // C. 로어북 스크립트 조회
    // 실측 확인된 경로: https://janitorai.com/hampter/script/<scriptUuid>  (단수 'script', 'scripts' 아님)
    async function fetchScriptLorebook(scriptUuid) {
        const endpoints = [
            `https://janitorai.com/hampter/script/${scriptUuid}`,   // 실제 확인된 경로
            `https://janitorai.com/hampter/scripts/${scriptUuid}`,  // 구버전 추정 경로(폴백)
            `https://janitorai.com/api/v1/scripts/${scriptUuid}`,
            `https://janitorai.com/api/scripts/${scriptUuid}`,
        ];
        for (const url of endpoints) {
            try {
                const res = await fetch(url, { headers: BROWSER_HEADERS });
                if (!res.ok) { console.log(`[Janitor] 스크립트 조회 실패 ${url} → HTTP ${res.status}`); continue; }
                const json = await res.json();
                console.log(`[Janitor] ✅ 스크립트 응답 획득 (${url}), 키:`, Object.keys(json).join(', '));
                return json;
            } catch(e) { console.log(`[Janitor] 스크립트 조회 에러 ${url}:`, e.message); }
        }
        return null;
    }

    // D. 임의의 JSON 객체를 재귀로 훑어 스크립트/로어북 UUID를 찾는다.
    // JannyAI/datacat 응답이나 캐릭터 메타데이터 안에 scripts, lorebooks,
    // attachedScripts 등의 키로 UUID 배열이 들어있는 경우를 폭넓게 커버한다.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function findScriptUuidsInObject(obj, uuids = new Set(), seen = new WeakSet()) {
        if (!obj || typeof obj !== 'object') return uuids;
        if (seen.has(obj)) return uuids;
        seen.add(obj);

        const scriptKeyHints = ['script', 'scripts', 'lorebook', 'lorebooks', 'world_info', 'worldinfo', 'attachedscripts'];

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

    // E. 캐릭터 페이지 HTML 파싱 (보조 수단 — Next.js CSR 구조에서는 빈 결과가 흔함)
    async function scrapeScriptUuids(characterPageUrl) {
        try {
            const res = await fetch(characterPageUrl, {
                headers: { ...BROWSER_HEADERS, 'Accept': 'text/html' }
            });
            if (!res.ok) return [];
            const html = await res.text();
            const scriptPattern = /\/scripts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
            const uuids = new Set();
            let m;
            while ((m = scriptPattern.exec(html)) !== null) uuids.add(m[1]);

            const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (nextDataMatch) {
                try {
                    const nextData = JSON.parse(nextDataMatch[1]);
                    for (const u of findScriptUuidsInObject(nextData)) uuids.add(u);
                } catch(e) {}
            }
            if (uuids.size > 0) console.log(`[Janitor] 캐릭터 페이지 HTML에서 스크립트 UUID 발견:`, [...uuids]);
            return [...uuids];
        } catch(e) {
            console.log('[Janitor] 페이지 스크래핑 실패:', e.message);
            return [];
        }
    }

    // E. 메인: PNG + 로어북 조합
    async function buildFinalPng(uuid, characterPageUrl) {
        // 1. PNG URL 획득 (응답 원본도 함께 보관 — 스크립트 UUID가 여기 들어있을 수 있음)
        let downloadUrl, source = 'janny', rawMeta = null;
        try {
            const r = await tryJannyApi(uuid);
            downloadUrl = r.downloadUrl;
            rawMeta = r.raw;
            console.log('[Janitor] ✅ JannyAI PNG URL 획득');
        } catch (e1) {
            console.log(`[Janitor] JannyAI 실패(${e1.message}), datacat 시도...`);
            const r = await tryDatacat(uuid);
            downloadUrl = r.downloadUrl;
            rawMeta = r.raw;
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
        if (card) {
            const rawAg = card.data?.alternate_greetings || card.alternate_greetings || [];
            console.log(`[Janitor][DEBUG] 원본 PNG 임베드 카드의 alternate_greetings 개수: ${rawAg.length}`);
        } else {
            console.log('[Janitor][DEBUG] 원본 PNG에 chara/ccv3 텍스트 청크 자체가 없음');
        }
        card = toV2Card(card);
        if (!card) {
            card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: uuid } };
        }
        console.log(`[Janitor] 카드 변환: spec=${card.spec} v=${card.spec_version}`);

        // 4. 로어북(스크립트) UUID 수집: 여러 소스를 모두 합쳐서 시도
        //    - JannyAI/datacat 메타데이터 응답 (가장 신뢰도 높음 — datacat 자체가 이 방식으로 찾아냄)
        //    - PNG에 임베드된 카드 데이터 자체 (extensions 등에 스크립트 참조가 있을 수 있음)
        //    - 캐릭터 페이지 HTML 스크래핑 (보조 수단)
        const scriptUuidSet = new Set();
        if (rawMeta) {
            for (const u of findScriptUuidsInObject(rawMeta)) scriptUuidSet.add(u);
        }
        if (card?.data) {
            for (const u of findScriptUuidsInObject(card.data)) scriptUuidSet.add(u);
        }
        for (const u of await scrapeScriptUuids(characterPageUrl)) scriptUuidSet.add(u);

        console.log(`[Janitor] 수집된 스크립트 UUID 후보 (${scriptUuidSet.size}개):`, [...scriptUuidSet]);

        let lorebook = null;
        if (scriptUuidSet.size > 0) {
            const allEntries = [];
            for (const sid of scriptUuidSet) {
                const scriptData = await fetchScriptLorebook(sid);
                if (!scriptData) continue;
                // 다양한 응답 구조 처리
                const entries = scriptData.entries    || scriptData.items      ||
                                scriptData.lore_items || scriptData.lorebook?.entries ||
                                scriptData.data?.entries ||
                                (Array.isArray(scriptData) ? scriptData : null);
                if (entries && Array.isArray(entries)) {
                    allEntries.push(...entries);
                    console.log(`[Janitor] 스크립트 ${sid}: 항목 ${entries.length}개`);
                } else {
                    console.log(`[Janitor] 스크립트 ${sid}: entries 필드를 찾지 못함. 응답 키:`, Object.keys(scriptData).join(', '));
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

    // ── F. 안전한 파일명 생성 ────────────────────────────────────
    function sanitizeFileName(name) {
        const cleaned = String(name || 'character')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .trim()
            .slice(0, 100);
        return cleaned || 'character';
    }

    // ── G. 중복 없는 파일 경로 찾기 ──────────────────────────────
    function getUniquePath(dir, baseName) {
        let candidate = path.join(dir, `${baseName}.png`);
        let n = 1;
        while (fs.existsSync(candidate)) {
            candidate = path.join(dir, `${baseName}_${n}.png`);
            n++;
        }
        return candidate;
    }

    // ── 메인 라우트: 추출만 (다운로드 모드에서 사용) ───────────────
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

    // ── 메인 라우트: 추출 + ST characters 폴더에 직접 저장 ─────────
    // ST의 /api/characters/import 를 거치지 않고 파일을 직접 써서
    // "Unsupported format: undefined" 문제를 원천적으로 회피한다.
    router.post('/fetch-and-save', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL이 필요합니다.' });

            const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (!m) return res.status(400).json({ success: false, error: 'URL에서 UUID를 찾을 수 없습니다.' });
            const uuid = m[0];

            const { pngBuf, charName } = await buildFinalPng(uuid, url);

            // ST 1.12+ 멀티유저 구조: req.user.directories.characters 가
            // 현재 로그인한 유저의 캐릭터 폴더 절대경로를 제공한다.
            // (단일 유저 모드에서도 default-user 기준으로 채워짐)
            const charactersDir = req.user?.directories?.characters;
            if (!charactersDir) {
                console.error('[Janitor] req.user.directories.characters 를 찾을 수 없음. ST 버전이 너무 오래되었거나 미들웨어 순서 문제일 수 있음.');
                return res.status(500).json({
                    success: false,
                    error: '캐릭터 폴더 경로를 찾을 수 없습니다 (req.user.directories.characters 없음). ST 버전을 확인하세요.'
                });
            }

            if (!fs.existsSync(charactersDir)) {
                fs.mkdirSync(charactersDir, { recursive: true });
            }

            const safeName  = sanitizeFileName(charName);
            const finalPath = getUniquePath(charactersDir, safeName);

            fs.writeFileSync(finalPath, pngBuf);
            console.log(`[Janitor] ✅ 캐릭터 파일 저장 완료: ${finalPath}`);

            res.json({
                success:  true,
                charName: charName,
                fileName: path.basename(finalPath)
            });

        } catch (err) {
            console.error('[Janitor 플러그인 에러]', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = { init, info };
