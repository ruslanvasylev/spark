import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "fflate";

const UEGS_GAUSSIAN_PAYLOAD_MAGIC = 0x55454753;
const UEGS_GAUSSIAN_PAYLOAD_MIN_VERSION = 5;
const UEGS_GAUSSIAN_PAYLOAD_VERSION = 6;
const UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES = 56;
const UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V5 = 168;
const UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V6 = 172;
const UEGS_DEBUG_CAPTURE_MAGIC = 0x55454744;
const UEGS_DEBUG_CAPTURE_VERSION = 1;
const UEGS_DEBUG_CAPTURE_HEADER_BYTES = 32;
const UEGS_DEBUG_CAPTURE_RECORD_BYTES = 104;
const UEGS_DEBUG_CAPTURE_HAS_SCENE_COLOR = 1 << 0;
const SPZ_MAGIC = 0x5053474e;
const SH_C0 = 0.28209479177387814;
const SH_DEGREE_TO_VECS = new Map([
  [0, 0],
  [1, 3],
  [2, 8],
  [3, 15],
]);

const DEFAULT_PAYLOAD_CAPTURED_TOLERANCE = 0.0001;
const DEFAULT_SPZ_DC_TOLERANCE = 0.005;
const DEFAULT_SH_NONZERO_EPSILON = 0.000001;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  throw new Error("Expected ArrayBuffer or Uint8Array input");
}

function asDataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readFloat32(view, offset) {
  return view.getFloat32(offset, true);
}

function maybeGunzip(bytes) {
  if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes);
  }
  return bytes;
}

function decodeSpzDcByte(byte) {
  const scale = SH_C0 / 0.15;
  return (byte / 255 - 0.5) * scale + 0.5;
}

function summarizeTriples(values, recordCount, epsilon) {
  let zeroSplatCount = 0;
  let nonZeroSplatCount = 0;
  let nonZeroComponentCount = 0;
  let maxAbsComponent = 0;
  let firstNonZero = null;

  for (let index = 0; index < recordCount; index += 1) {
    let splatHasNonZero = false;
    for (let component = 0; component < 3; component += 1) {
      const value = values[index * 3 + component] ?? 0;
      const absValue = Math.abs(value);
      if (absValue > maxAbsComponent) {
        maxAbsComponent = absValue;
      }
      if (absValue > epsilon) {
        nonZeroComponentCount += 1;
        splatHasNonZero = true;
        firstNonZero ??= { index, component, value };
      }
    }
    if (splatHasNonZero) {
      nonZeroSplatCount += 1;
    } else {
      zeroSplatCount += 1;
    }
  }

  return {
    zeroSplatCount,
    nonZeroSplatCount,
    nonZeroComponentCount,
    maxAbsComponent,
    epsilon,
    firstNonZero,
  };
}

function summarizeFirstOrderSh(shValues, recordCount, epsilon) {
  let zeroSplatCount = 0;
  let nonZeroSplatCount = 0;
  let nonZeroCoefficientCount = 0;
  let maxAbsCoefficient = 0;
  let firstNonZero = null;

  for (let index = 0; index < recordCount; index += 1) {
    let splatHasNonZero = false;
    for (let coefficient = 0; coefficient < 9; coefficient += 1) {
      const value = shValues[index * 9 + coefficient] ?? 0;
      const absValue = Math.abs(value);
      if (absValue > maxAbsCoefficient) {
        maxAbsCoefficient = absValue;
      }
      if (absValue > epsilon) {
        nonZeroCoefficientCount += 1;
        splatHasNonZero = true;
        firstNonZero ??= { index, coefficient, value };
      }
    }
    if (splatHasNonZero) {
      nonZeroSplatCount += 1;
    } else {
      zeroSplatCount += 1;
    }
  }

  return {
    zeroSplatCount,
    nonZeroSplatCount,
    nonZeroCoefficientCount,
    maxAbsCoefficient,
    epsilon,
    firstNonZero,
  };
}

function compareRgbTriples(left, right, recordCount, tolerance, mask = null) {
  let comparedSplatCount = 0;
  let overToleranceCount = 0;
  let maxAbsDiff = 0;
  let meanMaxAbsDiff = 0;
  let meanAbsDiff = 0;
  let worst = null;

  for (let index = 0; index < recordCount; index += 1) {
    if (mask && !mask[index]) {
      continue;
    }
    comparedSplatCount += 1;
    let splatMaxAbsDiff = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const leftValue = left[index * 3 + channel];
      const rightValue = right[index * 3 + channel];
      const diff = Math.abs(leftValue - rightValue);
      meanAbsDiff += diff;
      if (diff > splatMaxAbsDiff) {
        splatMaxAbsDiff = diff;
      }
      if (diff > maxAbsDiff) {
        maxAbsDiff = diff;
        worst = {
          index,
          channel,
          left: leftValue,
          right: rightValue,
          absDiff: diff,
        };
      }
    }
    meanMaxAbsDiff += splatMaxAbsDiff;
    if (splatMaxAbsDiff > tolerance) {
      overToleranceCount += 1;
    }
  }

  if (comparedSplatCount > 0) {
    meanMaxAbsDiff /= comparedSplatCount;
    meanAbsDiff /= comparedSplatCount * 3;
  }

  return {
    comparedSplatCount,
    tolerance,
    overToleranceCount,
    maxAbsDiff,
    meanMaxAbsDiff,
    meanAbsDiff,
    worst,
  };
}

function relativeManifestPath(manifest, key, defaultName) {
  const candidate = manifest?.[key]?.path;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : defaultName;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSidecarPath(rootDir, manifest, key, defaultName) {
  const aliasPath = path.join(rootDir, defaultName);
  const manifestPath = relativeManifestPath(manifest, key, "");
  if (!manifestPath) {
    return aliasPath;
  }

  const resolvedManifestPath = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.resolve(rootDir, manifestPath);
  if (await fileExists(resolvedManifestPath)) {
    return resolvedManifestPath;
  }
  if (resolvedManifestPath !== aliasPath && (await fileExists(aliasPath))) {
    return aliasPath;
  }
  return resolvedManifestPath;
}

function assertCount(label, actual, expected) {
  assert(
    actual === expected,
    `${label} count drifted: expected ${expected}, got ${actual}`,
  );
}

function countFromManifest(manifest, key) {
  const value = manifest?.[key]?.gaussian_count;
  return Number.isInteger(value) ? value : null;
}

export function parseUegsPayloadForVerifier(input) {
  const bytes = toUint8Array(input);
  assert(
    bytes.byteLength >= UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES,
    "UEGS payload is too small to contain the header",
  );

  const view = asDataView(bytes);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  assert(
    magic === UEGS_GAUSSIAN_PAYLOAD_MAGIC,
    `Unsupported UEGS payload magic: expected 0x${UEGS_GAUSSIAN_PAYLOAD_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
  );
  assert(
    version >= UEGS_GAUSSIAN_PAYLOAD_MIN_VERSION &&
      version <= UEGS_GAUSSIAN_PAYLOAD_VERSION,
    `Unsupported UEGS payload version: expected ${UEGS_GAUSSIAN_PAYLOAD_MIN_VERSION}-${UEGS_GAUSSIAN_PAYLOAD_VERSION}, got ${version}`,
  );

  const recordBytes =
    version >= 6
      ? UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V6
      : UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V5;
  const recordCount = view.getUint32(8, true);
  const shDegree = view.getUint32(12, true);
  const expectedBytes =
    UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES + recordCount * recordBytes;
  assert(
    bytes.byteLength >= expectedBytes,
    `UEGS payload is truncated: expected at least ${expectedBytes} bytes, got ${bytes.byteLength}`,
  );

  const baseColor = new Float32Array(recordCount * 3);
  const shDc = new Float32Array(recordCount * 3);
  const shFirstOrder = new Float32Array(recordCount * 9);

  for (let index = 0; index < recordCount; index += 1) {
    const recordOffset =
      UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES + index * recordBytes;
    for (let channel = 0; channel < 3; channel += 1) {
      baseColor[index * 3 + channel] = readFloat32(
        view,
        recordOffset + 76 + channel * 4,
      );
      shDc[index * 3 + channel] = readFloat32(
        view,
        recordOffset + 104 + channel * 4,
      );
    }
    for (let coefficient = 0; coefficient < 9; coefficient += 1) {
      shFirstOrder[index * 9 + coefficient] = readFloat32(
        view,
        recordOffset + 120 + coefficient * 4,
      );
    }
  }

  return {
    version,
    recordCount,
    shDegree,
    baseColor,
    shDc,
    shFirstOrder,
  };
}

export function parseUegsDebugCaptureForVerifier(input) {
  const bytes = toUint8Array(input);
  assert(
    bytes.byteLength >= UEGS_DEBUG_CAPTURE_HEADER_BYTES,
    "UEGS debug capture sidecar is too small",
  );

  const view = asDataView(bytes);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  assert(
    magic === UEGS_DEBUG_CAPTURE_MAGIC,
    `Unsupported UEGS debug capture magic: expected 0x${UEGS_DEBUG_CAPTURE_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
  );
  assert(
    version === UEGS_DEBUG_CAPTURE_VERSION,
    `Unsupported UEGS debug capture version: expected ${UEGS_DEBUG_CAPTURE_VERSION}, got ${version}`,
  );

  const recordCount = view.getUint32(8, true);
  const headerBytes = view.getUint32(12, true);
  const recordBytes = view.getUint32(16, true);
  assert(
    headerBytes === UEGS_DEBUG_CAPTURE_HEADER_BYTES,
    `Unsupported UEGS debug capture header size: expected ${UEGS_DEBUG_CAPTURE_HEADER_BYTES}, got ${headerBytes}`,
  );
  assert(
    recordBytes === UEGS_DEBUG_CAPTURE_RECORD_BYTES,
    `Unsupported UEGS debug capture record size: expected ${UEGS_DEBUG_CAPTURE_RECORD_BYTES}, got ${recordBytes}`,
  );
  const expectedBytes = headerBytes + recordCount * recordBytes;
  assert(
    bytes.byteLength >= expectedBytes,
    `UEGS debug capture sidecar is truncated: expected at least ${expectedBytes} bytes, got ${bytes.byteLength}`,
  );

  const sceneColor = new Float32Array(recordCount * 3);
  const sceneColorMask = new Uint8Array(recordCount);
  let sceneColorCount = 0;

  for (let index = 0; index < recordCount; index += 1) {
    const recordOffset = headerBytes + index * recordBytes;
    const flags = view.getUint32(recordOffset + 96, true);
    const hasSceneColor = (flags & UEGS_DEBUG_CAPTURE_HAS_SCENE_COLOR) !== 0;
    if (!hasSceneColor) {
      continue;
    }
    sceneColorMask[index] = 1;
    sceneColorCount += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      sceneColor[index * 3 + channel] = readFloat32(
        view,
        recordOffset + channel * 4,
      );
    }
  }

  return {
    version,
    recordCount,
    sceneColor,
    sceneColorMask,
    sceneColorCount,
  };
}

export function parseSpzForVerifier(input) {
  const compressedBytes = toUint8Array(input);
  const bytes = maybeGunzip(compressedBytes);
  assert(bytes.byteLength >= 16, "SPZ is too small to contain the header");

  const view = asDataView(bytes);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  assert(
    magic === SPZ_MAGIC,
    `Unsupported SPZ magic: expected 0x${SPZ_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
  );
  assert(version >= 1 && version <= 3, `Unsupported SPZ version: ${version}`);

  const recordCount = view.getUint32(8, true);
  const shDegree = view.getUint8(12);
  const shVecCount = SH_DEGREE_TO_VECS.get(shDegree);
  assert(
    shVecCount !== undefined,
    `Unsupported SPZ SH degree: expected 0-3, got ${shDegree}`,
  );

  let offset = 16;
  offset += recordCount * (version === 1 ? 6 : 9); // centers
  offset += recordCount; // alpha
  const rgbOffset = offset;
  offset += recordCount * 3; // RGB/DC
  offset += recordCount * 3; // scales
  offset += recordCount * (version === 3 ? 4 : 3); // rotations
  const shOffset = offset;
  offset += recordCount * shVecCount * 3;
  assert(
    bytes.byteLength >= offset,
    `SPZ is truncated: expected at least ${offset} bytes, got ${bytes.byteLength}`,
  );

  const dc = new Float32Array(recordCount * 3);
  for (let index = 0; index < recordCount; index += 1) {
    const rowOffset = rgbOffset + index * 3;
    dc[index * 3 + 0] = decodeSpzDcByte(bytes[rowOffset + 0]);
    dc[index * 3 + 1] = decodeSpzDcByte(bytes[rowOffset + 1]);
    dc[index * 3 + 2] = decodeSpzDcByte(bytes[rowOffset + 2]);
  }

  const shFirstOrder = new Float32Array(recordCount * 9);
  if (shDegree >= 1) {
    const perSplatShBytes = shVecCount * 3;
    for (let index = 0; index < recordCount; index += 1) {
      const rowOffset = shOffset + index * perSplatShBytes;
      for (let coefficient = 0; coefficient < 9; coefficient += 1) {
        shFirstOrder[index * 9 + coefficient] =
          (bytes[rowOffset + coefficient] - 128) / 128;
      }
    }
  }

  return {
    version,
    recordCount,
    shDegree,
    dc,
    shFirstOrder,
  };
}

export async function verifyUegsViewerPairArtifacts(options) {
  const compositeDir = options.compositeDir;
  const debugDir = options.debugDir;
  assert(compositeDir, "Missing compositeDir");
  assert(debugDir, "Missing debugDir");

  const payloadCapturedTolerance =
    options.payloadCapturedTolerance ?? DEFAULT_PAYLOAD_CAPTURED_TOLERANCE;
  const spzDcTolerance = options.spzDcTolerance ?? DEFAULT_SPZ_DC_TOLERANCE;
  const shNonZeroEpsilon =
    options.shNonZeroEpsilon ?? DEFAULT_SH_NONZERO_EPSILON;

  const compositeManifestPath =
    options.compositeManifestPath ??
    path.join(compositeDir, "uegs_manifest.json");
  const debugManifestPath =
    options.debugManifestPath ?? path.join(debugDir, "uegs_manifest.json");
  const compositeManifest = await readJsonFile(compositeManifestPath);
  const debugManifest = await readJsonFile(debugManifestPath);
  const compositePayloadPath =
    options.compositePayloadPath ??
    (await resolveSidecarPath(
      compositeDir,
      compositeManifest,
      "gaussian_payload_sidecar",
      "uegs_gaussians_payload.bin",
    ));
  const compositeSpzPath =
    options.compositeSpzPath ?? path.join(compositeDir, "uegs_gaussians.spz");
  const debugCapturePath =
    options.debugCapturePath ??
    (await resolveSidecarPath(
      debugDir,
      debugManifest,
      "gaussian_debug_capture_sidecar",
      "uegs_captured_debug_passes.bin",
    ));

  const [payloadBytes, spzBytes, debugCaptureBytes] = await Promise.all([
    fs.readFile(compositePayloadPath),
    fs.readFile(compositeSpzPath),
    fs.readFile(debugCapturePath),
  ]);
  const payload = parseUegsPayloadForVerifier(payloadBytes);
  const spz = parseSpzForVerifier(spzBytes);
  const debugCapture = parseUegsDebugCaptureForVerifier(debugCaptureBytes);

  const manifestGaussianCount =
    countFromManifest(compositeManifest, "gaussian_seed_artifact") ??
    countFromManifest(compositeManifest, "gaussian_payload_sidecar") ??
    payload.recordCount;
  assertCount(
    "composite manifest/payload",
    payload.recordCount,
    manifestGaussianCount,
  );
  assertCount("composite SPZ", spz.recordCount, manifestGaussianCount);
  assertCount("debug capture", debugCapture.recordCount, manifestGaussianCount);

  const debugManifestCount =
    countFromManifest(debugManifest, "gaussian_seed_artifact") ??
    countFromManifest(debugManifest, "gaussian_debug_capture_sidecar") ??
    debugCapture.recordCount;
  assertCount("debug manifest", debugManifestCount, manifestGaussianCount);
  assert(
    debugCapture.sceneColorCount === manifestGaussianCount,
    `debug CapturedSceneColor count drifted: expected ${manifestGaussianCount}, got ${debugCapture.sceneColorCount}`,
  );

  const payloadVsCapturedSceneColor = compareRgbTriples(
    payload.baseColor,
    debugCapture.sceneColor,
    manifestGaussianCount,
    payloadCapturedTolerance,
    debugCapture.sceneColorMask,
  );
  const spzVsPayload = compareRgbTriples(
    spz.dc,
    payload.baseColor,
    manifestGaussianCount,
    spzDcTolerance,
  );
  const spzVsCapturedSceneColor = compareRgbTriples(
    spz.dc,
    debugCapture.sceneColor,
    manifestGaussianCount,
    spzDcTolerance,
    debugCapture.sceneColorMask,
  );

  assert(
    payloadVsCapturedSceneColor.overToleranceCount === 0,
    `composite payload DC/BaseColor vs debug CapturedSceneColor drifted: maxAbsDiff=${payloadVsCapturedSceneColor.maxAbsDiff} tolerance=${payloadCapturedTolerance} overToleranceCount=${payloadVsCapturedSceneColor.overToleranceCount} worst=${JSON.stringify(payloadVsCapturedSceneColor.worst)}`,
  );
  assert(
    spzVsPayload.overToleranceCount === 0,
    `composite SPZ DC vs payload drifted: maxAbsDiff=${spzVsPayload.maxAbsDiff} tolerance=${spzDcTolerance} overToleranceCount=${spzVsPayload.overToleranceCount} worst=${JSON.stringify(spzVsPayload.worst)}`,
  );
  assert(
    spzVsCapturedSceneColor.overToleranceCount === 0,
    `composite SPZ DC vs debug CapturedSceneColor drifted: maxAbsDiff=${spzVsCapturedSceneColor.maxAbsDiff} tolerance=${spzDcTolerance} overToleranceCount=${spzVsCapturedSceneColor.overToleranceCount} worst=${JSON.stringify(spzVsCapturedSceneColor.worst)}`,
  );

  return {
    paths: {
      compositeManifest: compositeManifestPath,
      compositePayload: compositePayloadPath,
      compositeSpz: compositeSpzPath,
      debugManifest: debugManifestPath,
      debugCapture: debugCapturePath,
    },
    counts: {
      gaussianCount: manifestGaussianCount,
      compositePayloadCount: payload.recordCount,
      compositeSpzCount: spz.recordCount,
      debugCaptureCount: debugCapture.recordCount,
      debugSceneColorCount: debugCapture.sceneColorCount,
    },
    dc: {
      payloadVsCapturedSceneColor,
      spzVsPayload,
      spzVsCapturedSceneColor,
    },
    sh: {
      payload: {
        shDegree: payload.shDegree,
        dc: summarizeTriples(
          payload.shDc,
          payload.recordCount,
          shNonZeroEpsilon,
        ),
        firstOrder: summarizeFirstOrderSh(
          payload.shFirstOrder,
          payload.recordCount,
          shNonZeroEpsilon,
        ),
      },
      spz: {
        shDegree: spz.shDegree,
        firstOrder: summarizeFirstOrderSh(
          spz.shFirstOrder,
          spz.recordCount,
          shNonZeroEpsilon,
        ),
      },
    },
  };
}
