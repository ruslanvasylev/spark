import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_BLUE_SKY_OPTIONS = {
  redBlueMinDelta: 45,
  greenBlueMinDelta: 20,
  greenRedMinDelta: 10,
};

let crcTable = null;

function getCrcTable() {
  if (crcTable != null) {
    return crcTable;
  }
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChannelsForColorType(colorType) {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 6:
      return 4;
    default:
      throw new Error(`Unsupported PNG color type: ${colorType}`);
  }
}

function pngColorTypeForChannels(channels) {
  switch (channels) {
    case 1:
      return 0;
    case 3:
      return 2;
    case 4:
      return 6;
    default:
      throw new Error(`Unsupported PNG channel count: ${channels}`);
  }
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  return pb <= pc ? up : upLeft;
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function ensureImageShape(image) {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height)
  ) {
    throw new Error("Image must provide integer width and height.");
  }
  if (!Number.isInteger(image.channels) || image.channels <= 0) {
    throw new Error("Image must provide a positive integer channel count.");
  }
  if (!(image.data instanceof Uint8Array)) {
    throw new Error("Image data must be a Uint8Array.");
  }
  const expected = image.width * image.height * image.channels;
  if (image.data.length !== expected) {
    throw new Error(
      `Image data length mismatch: expected ${expected}, got ${image.data.length}.`,
    );
  }
}

export function decodePng(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw new Error("Invalid PNG signature.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = readUInt32(buffer, offset);
    offset += 4;
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    const data = buffer.subarray(offset, offset + length);
    offset += length;
    const expectedCrc = readUInt32(buffer, offset);
    offset += 4;
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
    if (actualCrc !== expectedCrc) {
      throw new Error(`PNG CRC mismatch for ${type}.`);
    }

    if (type === "IHDR") {
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      const compressionMethod = data[10];
      const filterMethod = data[11];
      interlaceMethod = data[12];
      if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
      }
      if (
        compressionMethod !== 0 ||
        filterMethod !== 0 ||
        interlaceMethod !== 0
      ) {
        throw new Error(
          "Unsupported PNG compression, filter, or interlace method.",
        );
      }
      pngChannelsForColorType(colorType);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0 || idatChunks.length === 0) {
    throw new Error("PNG is missing IHDR or IDAT data.");
  }

  const channels = pngChannelsForColorType(colorType);
  const bytesPerPixel = channels;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const expectedScanlineBytes = height * (1 + stride);
  if (inflated.length !== expectedScanlineBytes) {
    throw new Error(
      `PNG scanline length mismatch: expected ${expectedScanlineBytes}, got ${inflated.length}.`,
    );
  }

  const data = new Uint8Array(width * height * channels);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const previousRowOffset = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= bytesPerPixel ? data[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? data[previousRowOffset + x] : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel
          ? data[previousRowOffset + x - bytesPerPixel]
          : 0;
      let value = raw;
      switch (filter) {
        case 0:
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4:
          value = raw + paethPredictor(left, up, upLeft);
          break;
        default:
          throw new Error(`Unsupported PNG filter type: ${filter}`);
      }
      data[rowOffset + x] = value & 0xff;
    }
    sourceOffset += stride;
  }

  return { width, height, channels, data };
}

function buildPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, data])),
    8 + data.length,
  );
  return chunk;
}

export function encodePng(image) {
  ensureImageShape(image);
  const colorType = pngColorTypeForChannels(image.channels);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = image.width * image.channels;
  const scanlines = Buffer.alloc(image.height * (stride + 1));
  let sourceOffset = 0;
  let targetOffset = 0;
  for (let y = 0; y < image.height; y += 1) {
    scanlines[targetOffset] = 0;
    targetOffset += 1;
    Buffer.from(
      image.data.buffer,
      image.data.byteOffset + sourceOffset,
      stride,
    ).copy(scanlines, targetOffset);
    sourceOffset += stride;
    targetOffset += stride;
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    buildPngChunk("IHDR", ihdr),
    buildPngChunk("IDAT", deflateSync(scanlines)),
    buildPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function readPngFile(filePath) {
  return decodePng(await readFile(filePath));
}

function decodeImageWithPillow(filePath) {
  const pythonCode = String.raw`
import base64
import json
import sys
from PIL import Image

image = Image.open(sys.argv[1]).convert("RGB")
sys.stdout.write(json.dumps({
    "width": image.width,
    "height": image.height,
    "channels": 3,
    "data": base64.b64encode(image.tobytes()).decode("ascii"),
}))
`;

  const attempts = ["python", "python3"];
  const errors = [];
  for (const command of attempts) {
    const result = spawnSync(command, ["-c", pythonCode, filePath], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    if (result.error) {
      errors.push(`${command}: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      errors.push(
        `${command}: ${result.stderr.trim() || `exit ${result.status}`}`,
      );
      continue;
    }
    const parsed = JSON.parse(result.stdout);
    return {
      width: parsed.width,
      height: parsed.height,
      channels: parsed.channels,
      data: Uint8Array.from(Buffer.from(parsed.data, "base64")),
    };
  }

  throw new Error(
    `Unable to decode non-PNG image with Pillow fallback: ${errors.join("; ")}`,
  );
}

export async function readImageFile(filePath) {
  const buffer = await readFile(filePath);
  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    return decodePng(buffer);
  }
  return decodeImageWithPillow(filePath);
}

export async function writePngFile(filePath, image) {
  await writeFile(filePath, encodePng(image));
}

function getRgbAt(image, pixelIndex) {
  const offset = pixelIndex * image.channels;
  if (image.channels === 1) {
    const value = image.data[offset];
    return [value, value, value];
  }
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function skyCandidateForRgb([r, g, b], options = DEFAULT_BLUE_SKY_OPTIONS) {
  return (
    b > r + options.redBlueMinDelta &&
    b > g + options.greenBlueMinDelta &&
    g > r + options.greenRedMinDelta
  );
}

export function deriveBlueSkyObjectMask(image, options = {}) {
  ensureImageShape(image);
  const resolvedOptions = { ...DEFAULT_BLUE_SKY_OPTIONS, ...options };
  const { width, height } = image;
  const pixelCount = width * height;
  const skyCandidate = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    skyCandidate[index] = skyCandidateForRgb(
      getRgbAt(image, index),
      resolvedOptions,
    )
      ? 1
      : 0;
  }

  const background = new Uint8Array(pixelCount);
  const queue = [];
  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return;
    }
    const index = y * width + x;
    if (background[index] || !skyCandidate[index]) {
      return;
    }
    background[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % width;
    const y = Math.floor(index / width);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }

  const mask = new Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    mask[index] = background[index] === 0;
  }
  return mask;
}

export function deriveLumaMask(image, threshold = 5) {
  ensureImageShape(image);
  const mask = new Array(image.width * image.height);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = luminance(getRgbAt(image, index)) > threshold;
  }
  return mask;
}

export function computeMaskStats(mask, width, height) {
  if (mask.length !== width * height) {
    throw new Error("Mask length does not match image dimensions.");
  }
  let pixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) {
      continue;
    }
    pixels += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 1);
    maxY = Math.max(maxY, y + 1);
  }
  return {
    pixels,
    coverage: mask.length === 0 ? 0 : pixels / mask.length,
    bbox: pixels === 0 ? null : [minX, minY, maxX, maxY],
  };
}

export function compareImageRgb(imageA, imageB, mask = null) {
  ensureImageShape(imageA);
  ensureImageShape(imageB);
  if (imageA.width !== imageB.width || imageA.height !== imageB.height) {
    throw new Error(
      `Image dimensions differ: ${imageA.width}x${imageA.height} vs ${imageB.width}x${imageB.height}.`,
    );
  }
  const pixelCount = imageA.width * imageA.height;
  if (mask != null && mask.length !== pixelCount) {
    throw new Error("Mask length does not match image dimensions.");
  }

  let pixels = 0;
  let sumAbsRgb = 0;
  let maxAbsRgb = 0;
  let sumAbsLuma = 0;
  let sumLumaA = 0;
  let sumLumaB = 0;
  let over1 = 0;
  let over5 = 0;
  let over10 = 0;
  const lumaDiffs = [];

  for (let index = 0; index < pixelCount; index += 1) {
    if (mask != null && !mask[index]) {
      continue;
    }
    const rgbA = getRgbAt(imageA, index);
    const rgbB = getRgbAt(imageB, index);
    const dr = Math.abs(rgbA[0] - rgbB[0]);
    const dg = Math.abs(rgbA[1] - rgbB[1]);
    const db = Math.abs(rgbA[2] - rgbB[2]);
    const maxChannelDiff = Math.max(dr, dg, db);
    const lumaA = luminance(rgbA);
    const lumaB = luminance(rgbB);
    const lumaDiff = Math.abs(lumaA - lumaB);

    pixels += 1;
    sumAbsRgb += dr + dg + db;
    maxAbsRgb = Math.max(maxAbsRgb, maxChannelDiff);
    sumAbsLuma += lumaDiff;
    sumLumaA += lumaA;
    sumLumaB += lumaB;
    over1 += maxChannelDiff > 1 ? 1 : 0;
    over5 += maxChannelDiff > 5 ? 1 : 0;
    over10 += maxChannelDiff > 10 ? 1 : 0;
    lumaDiffs.push(lumaDiff);
  }

  if (pixels === 0) {
    return {
      pixels: 0,
      coverage: 0,
      meanAbsRgb: 0,
      maxAbsRgb: 0,
      meanAbsLuma: 0,
      meanLumaA: 0,
      meanLumaB: 0,
      deltaMeanLumaBminusA: 0,
      over1Ratio: 0,
      over5Ratio: 0,
      over10Ratio: 0,
      p50AbsLuma: 0,
      p95AbsLuma: 0,
      p99AbsLuma: 0,
    };
  }

  return {
    pixels,
    coverage: pixels / pixelCount,
    meanAbsRgb: sumAbsRgb / (pixels * 3),
    maxAbsRgb,
    meanAbsLuma: sumAbsLuma / pixels,
    meanLumaA: sumLumaA / pixels,
    meanLumaB: sumLumaB / pixels,
    deltaMeanLumaBminusA: sumLumaB / pixels - sumLumaA / pixels,
    over1Ratio: over1 / pixels,
    over5Ratio: over5 / pixels,
    over10Ratio: over10 / pixels,
    p50AbsLuma: percentile(lumaDiffs, 0.5),
    p95AbsLuma: percentile(lumaDiffs, 0.95),
    p99AbsLuma: percentile(lumaDiffs, 0.99),
  };
}

export function maskOverlapStats(maskA, maskB) {
  if (maskA.length !== maskB.length) {
    throw new Error("Mask lengths differ.");
  }
  let aPixels = 0;
  let bPixels = 0;
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < maskA.length; index += 1) {
    const a = Boolean(maskA[index]);
    const b = Boolean(maskB[index]);
    aPixels += a ? 1 : 0;
    bPixels += b ? 1 : 0;
    intersection += a && b ? 1 : 0;
    union += a || b ? 1 : 0;
  }
  return {
    aPixels,
    bPixels,
    intersectionPixels: intersection,
    unionPixels: union,
    intersectionRatioOfA: aPixels === 0 ? 0 : intersection / aPixels,
    intersectionRatioOfB: bPixels === 0 ? 0 : intersection / bPixels,
    aOnlyPixels: aPixels - intersection,
    bOnlyPixels: bPixels - intersection,
  };
}

export function createMaskImage(mask, width, height) {
  if (mask.length !== width * height) {
    throw new Error("Mask length does not match image dimensions.");
  }
  const data = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    data[index] = mask[index] ? 255 : 0;
  }
  return { width, height, channels: 1, data };
}

export function computeForegroundParityReport({
  ueReference,
  sparkComposite,
  sparkDebug = null,
  ueSplatPreview = null,
  skyMaskOptions = {},
  sparkForegroundLumaThreshold = 5,
}) {
  const objectMask = deriveBlueSkyObjectMask(ueReference, skyMaskOptions);
  const sparkMask = deriveLumaMask(
    sparkComposite,
    sparkForegroundLumaThreshold,
  );
  const intersectionMask = objectMask.map(
    (value, index) => value && sparkMask[index],
  );
  const report = {
    imageSize: { width: ueReference.width, height: ueReference.height },
    mask: {
      name: "border_connected_blue_sky_removal",
      options: { ...DEFAULT_BLUE_SKY_OPTIONS, ...skyMaskOptions },
      ueObject: computeMaskStats(
        objectMask,
        ueReference.width,
        ueReference.height,
      ),
      sparkCompositeForeground: computeMaskStats(
        sparkMask,
        ueReference.width,
        ueReference.height,
      ),
      overlap: maskOverlapStats(objectMask, sparkMask),
    },
    comparisons: {
      ueGeometryVsSparkCompositeObject: compareImageRgb(
        ueReference,
        sparkComposite,
        objectMask,
      ),
      ueGeometryVsSparkCompositeIntersection: compareImageRgb(
        ueReference,
        sparkComposite,
        intersectionMask,
      ),
    },
  };

  if (sparkDebug != null) {
    report.comparisons.ueGeometryVsSparkDebugObject = compareImageRgb(
      ueReference,
      sparkDebug,
      objectMask,
    );
    report.comparisons.sparkDebugVsCompositeObject = compareImageRgb(
      sparkDebug,
      sparkComposite,
      objectMask,
    );
  }

  if (ueSplatPreview != null) {
    report.comparisons.ueGeometryVsUeSplatPreviewObject = compareImageRgb(
      ueReference,
      ueSplatPreview,
      objectMask,
    );
  }

  return { report, objectMask, sparkMask, intersectionMask };
}
