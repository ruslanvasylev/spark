import fs from "node:fs/promises";
import path from "node:path";
const { SpzReader, SpzWriter, parseUegsManifest } = (await import(
  "../dist/spark.module.js"
)) as {
  SpzReader: typeof import("../dist/spark.module.js").SpzReader;
  SpzWriter: typeof import("../dist/spark.module.js").SpzWriter;
  parseUegsManifest: typeof import("../dist/spark.module.js").parseUegsManifest;
};

const UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES = 56;
const UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V5 = 168;
const UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V6 = 172;

type Options = {
  inputDir: string;
  outputDir: string;
  targetCount: number;
  seed: number;
};

function parseArgs(argv: string[]): Options {
  let inputDir = "";
  let outputDir = "";
  let targetCount = 0;
  let seed = 0x5eed1234;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--input-dir":
        inputDir = next;
        i += 1;
        break;
      case "--output-dir":
        outputDir = next;
        i += 1;
        break;
      case "--target-count":
        targetCount = Number(next);
        i += 1;
        break;
      case "--seed":
        seed = Number(next);
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!inputDir) {
    throw new Error("--input-dir is required");
  }
  if (!outputDir) {
    throw new Error("--output-dir is required");
  }
  if (!Number.isFinite(targetCount) || targetCount <= 0) {
    throw new Error("--target-count must be a positive integer");
  }

  return {
    inputDir: path.resolve(inputDir),
    outputDir: path.resolve(outputDir),
    targetCount: Math.max(1, Math.trunc(targetCount)),
    seed: Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0x5eed1234,
  };
}

function createMulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSelectedIndices(
  recordCount: number,
  targetCount: number,
  seed: number,
) {
  const count = Math.min(recordCount, targetCount);
  if (count <= 0) {
    return [];
  }
  if (count === recordCount) {
    return Array.from({ length: recordCount }, (_, index) => index);
  }

  const nextRandom = createMulberry32(seed);
  const result = Array.from({ length: count }, (_, index) => index);
  for (let index = count; index < recordCount; index += 1) {
    const replaceIndex = Math.floor(nextRandom() * (index + 1));
    if (replaceIndex < count) {
      result[replaceIndex] = index;
    }
  }
  result.sort((left, right) => left - right);
  return result;
}

function buildSelectionMap(recordCount: number, selectedIndices: number[]) {
  const selectionMap = new Int32Array(recordCount);
  selectionMap.fill(-1);
  for (let index = 0; index < selectedIndices.length; index += 1) {
    selectionMap[selectedIndices[index]] = index;
  }
  return selectionMap;
}

function scaleClassCount(
  originalCount: number,
  originalRecordCount: number,
  nextRecordCount: number,
) {
  if (originalRecordCount <= 0 || originalCount <= 0 || nextRecordCount <= 0) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      nextRecordCount,
      Math.round((originalCount / originalRecordCount) * nextRecordCount),
    ),
  );
}

function rebalanceCounts(
  counts: [number, number, number],
  total: number,
): [number, number, number] {
  const next = [...counts] as [number, number, number];
  let sum = next[0] + next[1] + next[2];
  while (sum < total) {
    let maxIndex = 0;
    if (next[1] >= next[maxIndex]) {
      maxIndex = 1;
    }
    if (next[2] >= next[maxIndex]) {
      maxIndex = 2;
    }
    next[maxIndex] += 1;
    sum += 1;
  }
  while (sum > total) {
    let maxIndex = 0;
    if (next[1] > next[maxIndex]) {
      maxIndex = 1;
    }
    if (next[2] > next[maxIndex]) {
      maxIndex = 2;
    }
    if (next[maxIndex] <= 0) {
      break;
    }
    next[maxIndex] -= 1;
    sum -= 1;
  }
  return next;
}

function downsamplePayload(
  payloadBytes: Uint8Array,
  selectedIndices: number[],
): Uint8Array {
  const payload =
    payloadBytes instanceof Uint8Array
      ? payloadBytes
      : new Uint8Array(payloadBytes);
  const sourceView = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const version = sourceView.getUint32(4, true);
  const recordCount = sourceView.getUint32(8, true);
  const recordBytes =
    version === 6
      ? UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V6
      : version === 5
        ? UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V5
        : 0;
  if (!recordBytes) {
    throw new Error(`Unsupported UEGS payload version: ${version}`);
  }

  const nextRecordCount = selectedIndices.length;
  const nextPayload = new Uint8Array(
    UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES + nextRecordCount * recordBytes,
  );
  nextPayload.set(payload.subarray(0, UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES), 0);

  const nextView = new DataView(nextPayload.buffer);
  nextView.setUint32(8, nextRecordCount, true);

  const opaqueCount = sourceView.getUint32(40, true);
  const maskedCount = sourceView.getUint32(44, true);
  const translucentCount = sourceView.getUint32(48, true);
  const nextCounts =
    opaqueCount === recordCount && maskedCount === 0 && translucentCount === 0
      ? ([nextRecordCount, 0, 0] as [number, number, number])
      : rebalanceCounts(
          [
            scaleClassCount(opaqueCount, recordCount, nextRecordCount),
            scaleClassCount(maskedCount, recordCount, nextRecordCount),
            scaleClassCount(translucentCount, recordCount, nextRecordCount),
          ],
          nextRecordCount,
        );
  nextView.setUint32(40, nextCounts[0], true);
  nextView.setUint32(44, nextCounts[1], true);
  nextView.setUint32(48, nextCounts[2], true);

  for (let index = 0; index < nextRecordCount; index += 1) {
    const sourceIndex = selectedIndices[index];
    const sourceOffset =
      UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES + sourceIndex * recordBytes;
    const nextOffset = UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES + index * recordBytes;
    nextPayload.set(
      payload.subarray(sourceOffset, sourceOffset + recordBytes),
      nextOffset,
    );
  }

  return nextPayload;
}

async function downsampleSpz(
  spzBytes: Uint8Array,
  selectedIndices: number[],
): Promise<Uint8Array> {
  const reader = new SpzReader({ fileBytes: spzBytes });
  await reader.parseHeader();

  const selectionMap = buildSelectionMap(reader.numSplats, selectedIndices);
  const writer = new SpzWriter({
    numSplats: selectedIndices.length,
    shDegree: reader.shDegree,
    fractionalBits: reader.fractionalBits,
    flagAntiAlias: reader.flagAntiAlias,
  });

  await reader.parseSplats(
    (index, x, y, z) => {
      const selectedIndex = selectionMap[index];
      if (selectedIndex >= 0) {
        writer.setCenter(selectedIndex, x, y, z);
      }
    },
    (index, alpha) => {
      const selectedIndex = selectionMap[index];
      if (selectedIndex >= 0) {
        writer.setAlpha(selectedIndex, alpha);
      }
    },
    (index, r, g, b) => {
      const selectedIndex = selectionMap[index];
      if (selectedIndex >= 0) {
        writer.setRgb(selectedIndex, r, g, b);
      }
    },
    (index, scaleX, scaleY, scaleZ) => {
      const selectedIndex = selectionMap[index];
      if (selectedIndex >= 0) {
        writer.setScale(selectedIndex, scaleX, scaleY, scaleZ);
      }
    },
    (index, quatX, quatY, quatZ, quatW) => {
      const selectedIndex = selectionMap[index];
      if (selectedIndex >= 0) {
        writer.setQuat(selectedIndex, quatX, quatY, quatZ, quatW);
      }
    },
    (index, sh1, sh2, sh3) => {
      const selectedIndex = selectionMap[index];
      if (selectedIndex >= 0) {
        writer.setSh(selectedIndex, sh1, sh2, sh3);
      }
    },
  );

  return await writer.finalize();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(options.inputDir, "uegs_manifest.json");
  const payloadPath = path.join(options.inputDir, "uegs_gaussians_payload.bin");
  const sceneLightingPath = path.join(
    options.inputDir,
    "uegs_scene_lighting.json",
  );
  const spzPath = path.join(options.inputDir, "uegs_gaussians.spz");

  const [manifestText, payloadBytes, sceneLightingBytes, spzBytes] =
    await Promise.all([
      fs.readFile(manifestPath, "utf8"),
      fs.readFile(payloadPath),
      fs.readFile(sceneLightingPath),
      fs.readFile(spzPath),
    ]);

  const manifest = parseUegsManifest(manifestText);
  const payloadView = new DataView(
    payloadBytes.buffer,
    payloadBytes.byteOffset,
    payloadBytes.byteLength,
  );
  const recordCount = payloadView.getUint32(8, true);
  const selectedIndices = buildSelectedIndices(
    recordCount,
    options.targetCount,
    options.seed,
  );

  await fs.mkdir(options.outputDir, { recursive: true });

  const nextPayload = downsamplePayload(payloadBytes, selectedIndices);
  const nextSpz = await downsampleSpz(spzBytes, selectedIndices);
  const nextManifest = structuredClone(manifest) as Record<string, unknown>;
  if (
    nextManifest.gaussian_payload_sidecar &&
    typeof nextManifest.gaussian_payload_sidecar === "object"
  ) {
    (
      nextManifest.gaussian_payload_sidecar as Record<string, unknown>
    ).gaussian_count = selectedIndices.length;
  }
  if (
    nextManifest.gaussian_seed_artifact &&
    typeof nextManifest.gaussian_seed_artifact === "object"
  ) {
    (
      nextManifest.gaussian_seed_artifact as Record<string, unknown>
    ).gaussian_count = selectedIndices.length;
  }

  await Promise.all([
    fs.writeFile(
      path.join(options.outputDir, "uegs_manifest.json"),
      JSON.stringify(nextManifest, null, 2),
      "utf8",
    ),
    fs.writeFile(
      path.join(options.outputDir, "uegs_gaussians_payload.bin"),
      nextPayload,
    ),
    fs.writeFile(
      path.join(options.outputDir, "uegs_scene_lighting.json"),
      sceneLightingBytes,
    ),
    fs.writeFile(path.join(options.outputDir, "uegs_gaussians.spz"), nextSpz),
    fs.writeFile(
      path.join(options.outputDir, "downsample_metadata.json"),
      JSON.stringify(
        {
          sourceBundleDir: options.inputDir,
          sourceRecordCount: recordCount,
          targetRecordCount: selectedIndices.length,
          strideApproximation:
            selectedIndices.length > 0
              ? recordCount / selectedIndices.length
              : null,
        },
        null,
        2,
      ),
      "utf8",
    ),
  ]);

  console.log(
    JSON.stringify(
      {
        inputDir: options.inputDir,
        outputDir: options.outputDir,
        sourceRecordCount: recordCount,
        targetRecordCount: selectedIndices.length,
      },
      null,
      2,
    ),
  );
}

void main();
