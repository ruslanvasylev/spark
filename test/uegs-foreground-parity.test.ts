import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  compareImageRgb,
  computeMaskStats,
  decodePng,
  deriveBlueSkyObjectMask,
  encodePng,
  readImageFile,
} from "../scripts/lib/uegs-foreground-parity.mjs";

function makeImage(
  width: number,
  height: number,
  fill: [number, number, number],
) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3 + 0] = fill[0];
    data[i * 3 + 1] = fill[1];
    data[i * 3 + 2] = fill[2];
  }
  return { width, height, channels: 3, data };
}

function setPixel(
  image: { width: number; channels: number; data: Uint8Array },
  x: number,
  y: number,
  rgb: [number, number, number],
) {
  const offset = (y * image.width + x) * image.channels;
  image.data[offset + 0] = rgb[0];
  image.data[offset + 1] = rgb[1];
  image.data[offset + 2] = rgb[2];
}

test("UE foreground mask removes only border-connected blue sky, not the whole background-gradient field", () => {
  const image = makeImage(8, 4, [96, 142, 191]);

  // Connected blue-sky background with a mild gradient that breaks median-color masking.
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      setPixel(image, x, y, [96 + y * 4, 142 + y * 2, 191 - y]);
    }
  }

  // Non-sky object block in the middle.
  for (let y = 0; y < image.height; y += 1) {
    setPixel(image, 2, y, [118, 118, 118]);
    setPixel(image, 3, y, [32, 28, 24]);
    setPixel(image, 4, y, [118, 118, 118]);
    setPixel(image, 5, y, [32, 28, 24]);
  }

  // A disconnected blue highlight inside the object should stay foreground because it is not
  // border-connected sky/background.
  setPixel(image, 3, 1, [62, 118, 198]);

  const mask = deriveBlueSkyObjectMask(image);
  const stats = computeMaskStats(mask, image.width, image.height);

  assert.deepEqual(stats.bbox, [2, 0, 6, 4]);
  assert.equal(stats.pixels, 16);
  assert.equal(mask[1 * image.width + 3], true);
  assert.equal(mask[0 * image.width + 0], false);
});

test("foreground RGB comparison reports object-mask luma deltas rather than full-frame background deltas", () => {
  const ue = makeImage(4, 2, [96, 142, 191]);
  const spark = makeImage(4, 2, [0, 0, 0]);
  for (const x of [1, 2]) {
    setPixel(ue, x, 0, [120, 120, 120]);
    setPixel(ue, x, 1, [100, 100, 100]);
    setPixel(spark, x, 0, [100, 100, 100]);
    setPixel(spark, x, 1, [80, 80, 80]);
  }

  const mask = [false, true, true, false, false, true, true, false];
  const full = compareImageRgb(ue, spark);
  const masked = compareImageRgb(ue, spark, mask);

  assert.ok(full.meanAbsRgb > masked.meanAbsRgb);
  assert.equal(masked.meanAbsRgb, 20);
  assert.equal(masked.deltaMeanLumaBminusA, -20);
  assert.equal(masked.pixels, 4);
});

test("PNG codec round-trips small RGB images for CLI foreground parity inputs", () => {
  const image = makeImage(2, 2, [0, 0, 0]);
  setPixel(image, 0, 0, [255, 0, 0]);
  setPixel(image, 1, 0, [0, 255, 0]);
  setPixel(image, 0, 1, [0, 0, 255]);
  setPixel(image, 1, 1, [255, 255, 255]);

  const encoded = encodePng(image);
  const decoded = decodePng(encoded);

  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.channels, 3);
  assert.deepEqual(Array.from(decoded.data), Array.from(image.data));
});

test("image reader falls back to Pillow for UEGS reference captures that are not PNG bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uegs-foreground-parity-"));
  try {
    const ppmPath = join(dir, "mislabeled-reference.png");
    writeFileSync(
      ppmPath,
      Buffer.from(
        `P6\n2 1\n255\n${String.fromCharCode(10, 20, 30, 40, 50, 60)}`,
        "binary",
      ),
    );

    const image = await readImageFile(ppmPath);

    assert.equal(image.width, 2);
    assert.equal(image.height, 1);
    assert.equal(image.channels, 3);
    assert.deepEqual(Array.from(image.data), [10, 20, 30, 40, 50, 60]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
