import * as assert from "node:assert";
import {
  fitReferenceViewportIntoContainers,
  getUegsReferenceViewport,
  referenceViewportsMatch,
  resolveSharedUegsReferenceViewport,
} from "../examples/editor/uegs-reference-viewport.js";

const referenceManifest = {
  comparison_viewpoint: {
    viewport_width_px: 1014,
    viewport_height_px: 425,
  },
};

const referenceViewport = getUegsReferenceViewport(referenceManifest);
assert.deepStrictEqual(referenceViewport, {
  width: 1014,
  height: 425,
  aspect: 1014 / 425,
});

assert.strictEqual(getUegsReferenceViewport({}), null);
assert.strictEqual(
  getUegsReferenceViewport({
    comparison_viewpoint: {
      viewport_width_px: 1014,
      viewport_height_px: 0,
    },
  }),
  null,
);

const matchingResolution = resolveSharedUegsReferenceViewport([
  referenceViewport,
  { width: 1014, height: 425, aspect: 1014 / 425 },
]);
assert.strictEqual(matchingResolution.viewport, referenceViewport);
assert.strictEqual(matchingResolution.mismatch, false);
assert.strictEqual(matchingResolution.viewports.length, 2);

const mismatchResolution = resolveSharedUegsReferenceViewport([
  referenceViewport,
  { width: 1920, height: 1080, aspect: 1920 / 1080 },
]);
assert.strictEqual(mismatchResolution.viewport, referenceViewport);
assert.strictEqual(mismatchResolution.mismatch, true);

assert.strictEqual(
  referenceViewportsMatch(
    { width: 1014, height: 425, aspect: 1014 / 425 },
    { width: 1014, height: 425, aspect: 1014 / 425 },
  ),
  true,
);
assert.strictEqual(
  referenceViewportsMatch(
    { width: 1014, height: 425, aspect: 1014 / 425 },
    { width: 1014, height: 426, aspect: 1014 / 426 },
  ),
  false,
);

const tallSideBySideFit = fitReferenceViewportIntoContainers(
  referenceViewport,
  [
    { width: 1279, height: 1265 },
    { width: 1280, height: 1265 },
  ],
);
assert.ok(tallSideBySideFit != null);
assert.ok(Math.abs(tallSideBySideFit.width - 1279) < 1e-9);
assert.ok(Math.abs(tallSideBySideFit.height - (1279 * 425) / 1014) < 1e-9);
assert.ok(Math.abs(tallSideBySideFit.aspect - 1014 / 425) < 1e-12);
assert.ok(tallSideBySideFit.height < 1265);

const wideFit = fitReferenceViewportIntoContainers(referenceViewport, [
  { width: 4000, height: 500 },
]);
assert.ok(wideFit != null);
assert.ok(Math.abs(wideFit.height - 500) < 1e-9);
assert.ok(Math.abs(wideFit.width - (1014 * 500) / 425) < 1e-9);
assert.ok(wideFit.width < 4000);
