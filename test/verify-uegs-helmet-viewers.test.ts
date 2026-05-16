import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyUegsViewerPairArtifacts } from "../scripts/lib/verify-uegs-helmet-viewers.mjs";

const UEGS_GAUSSIAN_PAYLOAD_MAGIC = 0x55454753;
const UEGS_GAUSSIAN_PAYLOAD_VERSION = 6;
const UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES = 56;
const UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES = 172;
const UEGS_DEBUG_CAPTURE_MAGIC = 0x55454744;
const UEGS_DEBUG_CAPTURE_VERSION = 1;
const UEGS_DEBUG_CAPTURE_HEADER_BYTES = 32;
const UEGS_DEBUG_CAPTURE_RECORD_BYTES = 104;
const UEGS_DEBUG_CAPTURE_HAS_SCENE_COLOR = 1 << 0;
const SPZ_MAGIC = 0x5053474e;
const SH_C0 = 0.28209479177387814;

function decodeSpzDcByte(byte: number) {
  const scale = SH_C0 / 0.15;
  return (byte / 255 - 0.5) * scale + 0.5;
}

function writeFloat32(view: DataView, offset: number, value: number) {
  view.setFloat32(offset, value, true);
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writePayload(
  filePath: string,
  baseColorRows: number[][],
  shDcRows: number[][],
  sh1Rows: number[][],
) {
  const recordCount = baseColorRows.length;
  const buffer = Buffer.alloc(
    UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES +
      recordCount * UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES,
  );
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  view.setUint32(0, UEGS_GAUSSIAN_PAYLOAD_MAGIC, true);
  view.setUint32(4, UEGS_GAUSSIAN_PAYLOAD_VERSION, true);
  view.setUint32(8, recordCount, true);
  view.setUint32(12, 1, true);
  view.setUint32(40, recordCount, true);
  view.setUint8(53, 3);
  view.setUint8(54, 1);

  for (let index = 0; index < recordCount; index += 1) {
    const recordOffset =
      UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES +
      index * UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES;
    for (let channel = 0; channel < 3; channel += 1) {
      writeFloat32(
        view,
        recordOffset + 76 + channel * 4,
        baseColorRows[index][channel],
      );
    }
    writeFloat32(view, recordOffset + 100, 1);
    for (let channel = 0; channel < 3; channel += 1) {
      writeFloat32(
        view,
        recordOffset + 104 + channel * 4,
        shDcRows[index][channel],
      );
    }
    writeFloat32(view, recordOffset + 116, 0.5);
    for (let coefficient = 0; coefficient < 9; coefficient += 1) {
      writeFloat32(
        view,
        recordOffset + 120 + coefficient * 4,
        sh1Rows[index][coefficient] ?? 0,
      );
    }
    writeFloat32(view, recordOffset + 156, 0.5);
    writeFloat32(view, recordOffset + 160, 1);
    writeFloat32(view, recordOffset + 164, 1);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

async function writeDebugCapture(filePath: string, sceneColorRows: number[][]) {
  const recordCount = sceneColorRows.length;
  const buffer = Buffer.alloc(
    UEGS_DEBUG_CAPTURE_HEADER_BYTES +
      recordCount * UEGS_DEBUG_CAPTURE_RECORD_BYTES,
  );
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  view.setUint32(0, UEGS_DEBUG_CAPTURE_MAGIC, true);
  view.setUint32(4, UEGS_DEBUG_CAPTURE_VERSION, true);
  view.setUint32(8, recordCount, true);
  view.setUint32(12, UEGS_DEBUG_CAPTURE_HEADER_BYTES, true);
  view.setUint32(16, UEGS_DEBUG_CAPTURE_RECORD_BYTES, true);

  for (let index = 0; index < recordCount; index += 1) {
    const recordOffset =
      UEGS_DEBUG_CAPTURE_HEADER_BYTES + index * UEGS_DEBUG_CAPTURE_RECORD_BYTES;
    for (let channel = 0; channel < 3; channel += 1) {
      writeFloat32(
        view,
        recordOffset + channel * 4,
        sceneColorRows[index][channel],
      );
    }
    writeFloat32(view, recordOffset + 12, 1);
    view.setUint32(recordOffset + 96, UEGS_DEBUG_CAPTURE_HAS_SCENE_COLOR, true);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

async function writeSpz(
  filePath: string,
  rgbByteRows: number[][],
  sh1ByteRows: number[][],
) {
  const recordCount = rgbByteRows.length;
  const buffer = Buffer.alloc(16 + recordCount * (9 + 1 + 3 + 3 + 4 + 9));
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  view.setUint32(0, SPZ_MAGIC, true);
  view.setUint32(4, 3, true);
  view.setUint32(8, recordCount, true);
  view.setUint8(12, 1);
  view.setUint8(13, 12);
  view.setUint16(14, 0, true);

  let offset = 16;
  offset += recordCount * 9; // centers
  offset += recordCount; // alpha
  for (const row of rgbByteRows) {
    for (const byte of row) {
      buffer[offset] = byte;
      offset += 1;
    }
  }
  offset += recordCount * 3; // scales
  offset += recordCount * 4; // rotations
  for (const row of sh1ByteRows) {
    for (let coefficient = 0; coefficient < 9; coefficient += 1) {
      buffer[offset] = row[coefficient] ?? 128;
      offset += 1;
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

async function writeManifests(
  compositeDir: string,
  debugDir: string,
  count: number,
) {
  await writeJson(path.join(compositeDir, "uegs_manifest.json"), {
    gaussian_seed_artifact: { gaussian_count: count },
    gaussian_payload_sidecar: {
      path: "uegs_gaussians_payload.bin",
      gaussian_count: count,
    },
  });
  await writeJson(path.join(debugDir, "uegs_manifest.json"), {
    gaussian_seed_artifact: { gaussian_count: count },
    gaussian_payload_sidecar: {
      path: "uegs_gaussians_payload.bin",
      gaussian_count: count,
    },
    gaussian_debug_capture_sidecar: {
      path: "uegs_captured_debug_passes.bin",
      gaussian_count: count,
      scene_color_count: count,
    },
  });
}

async function withFixture(
  run: (fixture: {
    compositeDir: string;
    debugDir: string;
    dcRows: number[][];
    rgbByteRows: number[][];
  }) => Promise<void>,
) {
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "spark-verify-uegs-viewers-"),
  );
  try {
    const compositeDir = path.join(tmpRoot, "current-composite");
    const debugDir = path.join(tmpRoot, "current-debug");
    const rgbByteRows = [
      [128, 140, 120],
      [96, 196, 64],
    ];
    const baseColorRows = rgbByteRows.map((row) => row.map(decodeSpzDcByte));
    const shDcRows = [
      [-1.25, -0.5, 0.25],
      [0.75, -1.0, 1.5],
    ];
    const sh1Rows = [new Array(9).fill(0), [0.125, 0, 0, 0, 0, 0, 0, 0, 0]];
    const sh1ByteRows = [
      new Array(9).fill(128),
      [144, 128, 128, 128, 128, 128, 128, 128, 128],
    ];

    await writeManifests(compositeDir, debugDir, baseColorRows.length);
    await writePayload(
      path.join(compositeDir, "uegs_gaussians_payload.bin"),
      baseColorRows,
      shDcRows,
      sh1Rows,
    );
    await writeSpz(
      path.join(compositeDir, "uegs_gaussians.spz"),
      rgbByteRows,
      sh1ByteRows,
    );
    await writeDebugCapture(
      path.join(debugDir, "uegs_captured_debug_passes.bin"),
      baseColorRows,
    );

    await run({ compositeDir, debugDir, dcRows: baseColorRows, rgbByteRows });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

test("UEGS viewer pair verifier proves composite payload/SPZ DC and explicit SH counts", async () => {
  await withFixture(async ({ compositeDir, debugDir }) => {
    const report = await verifyUegsViewerPairArtifacts({
      compositeDir,
      debugDir,
      payloadCapturedTolerance: 0.000001,
      spzDcTolerance: 0.000001,
      shNonZeroEpsilon: 0.000001,
    });

    assert.strictEqual(report.counts.gaussianCount, 2);
    assert.strictEqual(report.counts.debugSceneColorCount, 2);
    assert.strictEqual(
      report.dc.payloadVsCapturedSceneColor.overToleranceCount,
      0,
    );
    assert.strictEqual(report.dc.spzVsPayload.overToleranceCount, 0);
    assert.strictEqual(report.dc.spzVsCapturedSceneColor.overToleranceCount, 0);
    assert.ok(report.dc.payloadVsCapturedSceneColor.maxAbsDiff <= 0.000001);
    assert.ok(report.dc.spzVsPayload.maxAbsDiff <= 0.000001);
    assert.strictEqual(report.sh.payload.shDegree, 1);
    assert.strictEqual(report.sh.payload.dc.zeroSplatCount, 0);
    assert.strictEqual(report.sh.payload.dc.nonZeroSplatCount, 2);
    assert.strictEqual(report.sh.payload.firstOrder.zeroSplatCount, 1);
    assert.strictEqual(report.sh.payload.firstOrder.nonZeroSplatCount, 1);
    assert.strictEqual(report.sh.spz.shDegree, 1);
    assert.strictEqual(report.sh.spz.firstOrder.zeroSplatCount, 1);
    assert.strictEqual(report.sh.spz.firstOrder.nonZeroSplatCount, 1);
  });
});

test("UEGS viewer pair verifier falls back to promoted current-dir aliases when manifest sidecar paths are stale", async () => {
  await withFixture(async ({ compositeDir, debugDir }) => {
    await writeJson(path.join(compositeDir, "uegs_manifest.json"), {
      gaussian_seed_artifact: { gaussian_count: 2 },
      gaussian_payload_sidecar: {
        path: "../../../../../../code/ruslanvasylev/missing-artifact/uegs_gaussians_payload.bin",
        gaussian_count: 2,
      },
    });
    await writeJson(path.join(debugDir, "uegs_manifest.json"), {
      gaussian_seed_artifact: { gaussian_count: 2 },
      gaussian_payload_sidecar: {
        path: "../../../../../../code/ruslanvasylev/missing-artifact/uegs_gaussians_payload.bin",
        gaussian_count: 2,
      },
      gaussian_debug_capture_sidecar: {
        path: "../../../../../../code/ruslanvasylev/missing-artifact/uegs_captured_debug_passes.bin",
        gaussian_count: 2,
        scene_color_count: 2,
      },
    });

    const report = await verifyUegsViewerPairArtifacts({
      compositeDir,
      debugDir,
      payloadCapturedTolerance: 0.000001,
      spzDcTolerance: 0.000001,
    });

    assert.strictEqual(
      report.paths.compositePayload,
      path.join(compositeDir, "uegs_gaussians_payload.bin"),
    );
    assert.strictEqual(
      report.paths.debugCapture,
      path.join(debugDir, "uegs_captured_debug_passes.bin"),
    );
    assert.strictEqual(report.counts.gaussianCount, 2);
  });
});

test("UEGS viewer pair verifier fails when composite payload DC drifts from CapturedSceneColor", async () => {
  await withFixture(async ({ compositeDir, debugDir, dcRows }) => {
    await writeDebugCapture(
      path.join(debugDir, "uegs_captured_debug_passes.bin"),
      [[dcRows[0][0] + 0.01, dcRows[0][1], dcRows[0][2]], dcRows[1]],
    );

    await assert.rejects(
      () =>
        verifyUegsViewerPairArtifacts({
          compositeDir,
          debugDir,
          payloadCapturedTolerance: 0.000001,
          spzDcTolerance: 0.000001,
        }),
      /payload DC.*CapturedSceneColor/i,
    );
  });
});

test("UEGS viewer pair verifier fails when composite SPZ DC drifts from payload and CapturedSceneColor", async () => {
  await withFixture(async ({ compositeDir, debugDir, rgbByteRows }) => {
    await writeSpz(
      path.join(compositeDir, "uegs_gaussians.spz"),
      [
        [rgbByteRows[0][0] + 8, rgbByteRows[0][1], rgbByteRows[0][2]],
        rgbByteRows[1],
      ],
      [new Array(9).fill(128), [144, 128, 128, 128, 128, 128, 128, 128, 128]],
    );

    await assert.rejects(
      () =>
        verifyUegsViewerPairArtifacts({
          compositeDir,
          debugDir,
          payloadCapturedTolerance: 0.000001,
          spzDcTolerance: 0.000001,
        }),
      /SPZ DC.*payload/i,
    );
  });
});
