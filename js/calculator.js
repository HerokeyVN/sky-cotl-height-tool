const HEIGHT_MOD_MAX_SAMPLE = 2;
const HEIGHT_MOD_MIN_SAMPLE = -2;

// 3D-to-2D conversion coefficients for non-negative height raw values.
// The shared community model uses this fitted set when the QR height value is 0 or above.
const ratioCoefficientsPositive = {
    A: 1.095388425,
    B: 0.004983453,
    C: 0.492141518,
    D: 0.002968009
};

// 3D-to-2D conversion coefficients for negative height raw values.
// Shorter-side samples are fitted with a separate set because the projection curve is different there.
const ratioCoefficientsNegative = {
    A: 1.224206561,
    B: 0.012636310,
    C: 0.495569563,
    D: 0.004517799
};

const SIZE_TYPE_MIN = 1;
const SIZE_TYPE_MAX = 14;
const SHORTEST_HEIGHT_M = 0.8;
const TALLEST_HEIGHT_M = 1.2;
const RATIO_PER_STEP = Math.pow(TALLEST_HEIGHT_M / SHORTEST_HEIGHT_M, 1 / (SIZE_TYPE_MAX - 1));
const SKY_REFERENCE_HEIGHT_M = 1;
const OLD_RAW_MIN = -2;
const OLD_RAW_MAX = 2;
const OLD_SCALE_BUCKETS = 13.5;

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function pickRatioCoefficients(heightValue) {
    return heightValue < 0 ? ratioCoefficientsNegative : ratioCoefficientsPositive;
}

function scaleComponent(scaleValue) {
    return scaleValue >= 0 ? 1 + scaleValue : 1 / (1 - scaleValue);
}

// Fitted projection model that maps QR raw values to the 2D comparison ratio.
// It uses the 3D-to-2D coefficient set selected for the current height side.
function predictRatio(scaleValue, heightValue, coefficients = pickRatioCoefficients(heightValue)) {
    const adjustedHeight = heightValue * 10;
    const s = scaleComponent(scaleValue);
    const { A, B, C, D } = coefficients;
    return A + (B * adjustedHeight) + (C * s) + (D * adjustedHeight * s);
}

function calcFinalFactor(scaleValue, heightValue) {
    const coefficients = pickRatioCoefficients(heightValue);
    const ratio = predictRatio(scaleValue, heightValue, coefficients);
    const baseRatio = predictRatio(0, 0, coefficients);

    if (!Number.isFinite(baseRatio) || baseRatio === 0) {
        return 1;
    }

    return ratio / baseRatio;
}

function sizeTypeFromHeight(heightMeters) {
    const raw = clamp(10 * (heightMeters - SKY_REFERENCE_HEIGHT_M), OLD_RAW_MIN, OLD_RAW_MAX);
    const scalar = (raw + 2) / 4;
    const oldValue = Math.floor((1 - scalar) * OLD_SCALE_BUCKETS);
    return clamp(Math.round(oldValue + 1), SIZE_TYPE_MIN, SIZE_TYPE_MAX) - 1;
}

function baseHeightFromSizeType(sizeTypeValue) {
    const stepsFromShortest = SIZE_TYPE_MAX - sizeTypeValue;
    return SHORTEST_HEIGHT_M * Math.pow(RATIO_PER_STEP, stepsFromShortest);
}

function computeHeightSnapshot(scaleValue, heightValue) {
    const factor = calcFinalFactor(scaleValue, heightValue);
    const referenceHeight = SKY_REFERENCE_HEIGHT_M * factor;
    const derivedSizeType = sizeTypeFromHeight(referenceHeight);
    const baseHeight = baseHeightFromSizeType(derivedSizeType);
    const absoluteHeight = baseHeight * factor;

    return {
        factor,
        sizeType: derivedSizeType,
        baseHeight,
        height: absoluteHeight,
        heightDelta: absoluteHeight - baseHeight
    };
}

function calculateStats(height, scale) {
    const currentSnapshot = computeHeightSnapshot(scale, height);
    const tallestSnapshot = computeHeightSnapshot(scale, HEIGHT_MOD_MAX_SAMPLE);
    const shortestSnapshot = computeHeightSnapshot(scale, HEIGHT_MOD_MIN_SAMPLE);

    if (
        !Number.isFinite(currentSnapshot.height) ||
        !Number.isFinite(tallestSnapshot.height) ||
        !Number.isFinite(shortestSnapshot.height)
    ) {
        return { error: 'status_error_general' };
    }

    return {
        current: currentSnapshot.height,
        tallest: tallestSnapshot.height,
        shortest: shortestSnapshot.height,
        currentSizeType: currentSnapshot.sizeType,
        tallestSizeType: tallestSnapshot.sizeType,
        shortestSizeType: shortestSnapshot.sizeType,
        scale: scale,
        heightRaw: height,
        factor: currentSnapshot.factor,
        sizeType: currentSnapshot.sizeType,
        baseHeight: currentSnapshot.baseHeight,
        heightDelta: currentSnapshot.heightDelta,
        comparisonLampHeight: 1.6,
        timestamp: new Date().getTime(),
        note: "",
        json: {
            scale_raw: scale,
            height_raw: height,
            final_scale_factor: currentSnapshot.factor,
            size_type: currentSnapshot.sizeType,
            base_height_m: currentSnapshot.baseHeight,
            current_height_m: currentSnapshot.height,
            current_height_delta_m: currentSnapshot.heightDelta,
            max_height_m: tallestSnapshot.height,
            min_height_m: shortestSnapshot.height
        }
    };
}

function decodeSkyQrPayload(rawText) {
    const candidates = collectBase64Candidates(rawText);
    if (!candidates.length) {
        throw new Error('QR_NO_BASE64');
    }

    for (const candidate of candidates) {
        try {
            const normalized = normalizeBase64(stripNoiseMarkers(candidate));
            if (!normalized) continue;
            const decodedText = decodeBase64(normalized);
            const preferHeightKeyword = candidate.includes('ImJvZHki');
            const parsed = parseDecodedPayload(decodedText, preferHeightKeyword);
            if (parsed) {
                if (isQrRangeInvalid(parsed)) {
                    throw new Error('QR_OUT_OF_RANGE');
                }
                return parsed;
            }
        } catch (_error) {
            continue;
        }
    }

    throw new Error('QR_NOT_SUPPORT');
}

function collectBase64Candidates(rawText) {
    const trimmed = rawText.trim();
    if (!trimmed) return [];

    const variants = new Set();
    const maybeUrlPayload = extractBase64FromUrl(trimmed);
    if (maybeUrlPayload) {
        variants.add(maybeUrlPayload);
    }

    const marker = 'ImJvZHki';
    const markerIndex = trimmed.indexOf(marker);
    if (markerIndex >= 0) {
        variants.add(trimmed.slice(markerIndex));
    }

    const oIndex = trimmed.indexOf('o=');
    if (oIndex >= 0) {
        variants.add(trimmed.slice(oIndex + 2));
    }

    variants.add(trimmed);
    return Array.from(variants).filter(Boolean);
}

function extractBase64FromUrl(rawText) {
    const possibleUrl = tryParseUrl(rawText);
    if (!possibleUrl) {
        const queryMatch = rawText.match(/(?:payload|data|value|q|v)=([A-Za-z0-9+/=_-]+)/i);
        return queryMatch ? queryMatch[1] : '';
    }

    const params = ['payload', 'data', 'value', 'q', 'v', 'o'];
    for (const key of params) {
        const value = possibleUrl.searchParams.get(key);
        if (value) return value;
    }

    const pathSegment = possibleUrl.pathname.split('/').filter(Boolean).pop();
    return pathSegment || '';
}

function stripNoiseMarkers(payload) {
    const trimmed = payload.trim();
    const bodyMarker = 'ImJvZHki';
    const markerIndex = trimmed.indexOf(bodyMarker);
    if (markerIndex >= 0) {
        return trimmed.slice(markerIndex);
    }

    const oIndex = trimmed.indexOf('o=');
    if (oIndex >= 0) {
        return trimmed.slice(oIndex + 2);
    }

    return trimmed;
}

function parseDecodedPayload(decodedText, preferHeightKeyword) {
    const sanitized = stripSpecialCharacters(decodedText);
    const printable = sanitized.replace(/[^\x20-\x7E]/g, '');
    const attempts = [];

    if (preferHeightKeyword) {
        attempts.push(() => parseViaHeightKeyword(sanitized));
    }

    attempts.push(() => parseViaAnchor(sanitized));
    attempts.push(() => parseViaKeyHints(sanitized));

    if (!preferHeightKeyword) {
        attempts.push(() => parseViaHeightKeyword(printable));
    }

    attempts.push(() => parseViaAnchor(printable));
    attempts.push(() => parseViaKeyHints(printable));

    for (const tryParse of attempts) {
        const parsed = tryParse();
        if (parsed && Number.isFinite(parsed.height) && Number.isFinite(parsed.scale)) {
            return parsed;
        }
    }

    return null;
}

function stripSpecialCharacters(input) {
    return input.replace(/[^A-Za-z0-9":,\.\-]/g, '');
}

function parseViaHeightKeyword(text) {
    const heightKeyMatch = /eigh/i.exec(text);
    if (!heightKeyMatch || typeof heightKeyMatch.index !== 'number') {
        return null;
    }

    const heightMatch = text.slice(heightKeyMatch.index).match(/(-?\d*\.\d+|-?\d+\.?\d*)/);
    const heightRaw = heightMatch && heightMatch[1];
    if (!heightRaw) {
        return null;
    }

    const height = Number.parseFloat(heightRaw);
    if (!Number.isFinite(height)) {
        return null;
    }

    const scaleKeyMatch = /scale/i.exec(text);
    if (!scaleKeyMatch || typeof scaleKeyMatch.index !== 'number') {
        return null;
    }

    const scaleSub = text.slice(scaleKeyMatch.index + scaleKeyMatch[0].length);
    const numPattern = /(-?\d+\.?\d*(?:[eE][-+]?\d+)?)/g;
    let match;
    let scale = null;

    while ((match = numPattern.exec(scaleSub)) !== null) {
        const raw = match[1];
        if (!raw) continue;
        const val = Number.parseFloat(raw);
        if (!Number.isFinite(val)) continue;
        if (raw.includes('.') || /[eE]/.test(raw)) {
            scale = val;
            break;
        }
        if (Math.abs(val) >= 1000) {
            scale = val / 1000000000;
            break;
        }
    }

    return scale === null ? null : { scale, height };
}

function parseViaAnchor(text) {
    const anchorMatch = /["']s/i.exec(text);
    if (!anchorMatch || typeof anchorMatch.index !== 'number') {
        return null;
    }

    const anchorIndex = anchorMatch.index;
    const afterS = text.slice(anchorIndex + anchorMatch[0].length);
    const scaleCandidates = afterS.match(/(-?\d+\.?\d*(?:[eE][-+]?\d+)?)/g) || [];
    let scale = null;

    for (const cand of scaleCandidates) {
        const value = Number.parseFloat(cand);
        if (!Number.isFinite(value)) continue;
        if (cand.includes('.') || /[eE]/.test(cand)) {
            scale = value;
            break;
        }
        if (Math.abs(value) >= 1000) {
            scale = value / 1000000000;
            break;
        }
    }

    const beforeS = text.slice(0, anchorIndex);
    const height = pickSingleDigitFloat(beforeS);
    if (scale === null || height === null) {
        return null;
    }

    return { scale, height };
}

function parseViaKeyHints(text) {
    const scale = findScaleValue(text);
    const height = findHeightValue(text);
    if (scale === null || height === null) {
        return null;
    }
    return { scale, height };
}

function findScaleValue(text) {
    const namedMatch = /["']?s["']?\s*:\s*(-?\d+\.?\d*(?:[eE][-+]?\d+)?)/i.exec(text);
    if (namedMatch && namedMatch[1]) {
        const normalized = normalizeNumeric(namedMatch[1]);
        if (normalized !== null) return normalized;
    }

    const scaleKeyMatch = /scale/i.exec(text);
    if (scaleKeyMatch && typeof scaleKeyMatch.index === 'number') {
        return pickFirstNumeric(text.slice(scaleKeyMatch.index + scaleKeyMatch[0].length));
    }

    return null;
}

function findHeightValue(text) {
    const patterns = [/height/i, /body/i, /hto/i, /["']?h["']?\s*:/i];
    for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match && typeof match.index === 'number') {
            const candidate = pickFirstNumeric(text.slice(match.index + match[0].length));
            if (candidate !== null) {
                return candidate;
            }
        }
    }

    const startMatch = /^(-?\d+\.?\d*(?:[eE][-+]?\d+)?)/.exec(text);
    if (startMatch && startMatch[1]) {
        return normalizeNumeric(startMatch[1]);
    }

    return null;
}

function pickFirstNumeric(source) {
    const numPattern = /(-?\d+\.?\d*(?:[eE][-+]?\d+)?)/g;
    let match;
    while ((match = numPattern.exec(source)) !== null) {
        const raw = match[1];
        if (typeof raw !== 'string') continue;
        const normalized = normalizeNumeric(raw);
        if (normalized !== null) {
            return normalized;
        }
    }
    return null;
}

function pickSingleDigitFloat(source) {
    const pattern = /-?\d\.\d+(?:[eE][-+]?\d+)?/g;
    let match;
    let lastRaw = null;
    while ((match = pattern.exec(source)) !== null) {
        if (typeof match[0] === 'string') {
            lastRaw = match[0];
        }
    }

    if (!lastRaw) return null;

    const value = Number.parseFloat(lastRaw);
    return Number.isFinite(value) ? value : null;
}

function normalizeNumeric(raw) {
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) {
        return null;
    }

    const hasDecimal = raw.includes('.') || /[eE]/.test(raw);
    if (!hasDecimal && Math.abs(value) >= 1000) {
        return value / 1000000000;
    }

    return value;
}

function decodeBase64(payload) {
    if (typeof window !== 'undefined' && typeof window.atob === 'function') {
        return window.atob(payload);
    }

    if (typeof globalThis !== 'undefined' && typeof globalThis.atob === 'function') {
        return globalThis.atob(payload);
    }

    throw new Error('QR_BASE64_UNSUPPORTED');
}

function normalizeBase64(payload) {
    const stripped = payload.replace(/[\n\r\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const remainder = stripped.length % 4;
    return remainder === 0 ? stripped : stripped + '='.repeat(4 - remainder);
}

function tryParseUrl(candidate) {
    try {
        return new URL(candidate);
    } catch (_error) {
        return null;
    }
}

function isQrRangeInvalid(payload) {
    return payload.scale > 2 || payload.scale < -2 || payload.height > 2 || payload.height < -2;
}

function decodeAndCalculate(rawData) {
    try {
        const parsed = decodeSkyQrPayload(rawData);
        if (isQrRangeInvalid(parsed)) {
            return { error: 'status_error_out_of_bounds' };
        }
        return calculateStats(parsed.height, parsed.scale);
    } catch (error) {
        if (error && error.message === 'QR_OUT_OF_RANGE') {
            return { error: 'status_error_out_of_bounds' };
        }
        return { error: 'status_error_general' };
    }
}
