import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const editorIndexHtml = readFileSync("examples/editor/index.html", "utf8");

test("UEGS manifest preview contract still loads when an explicit camera is requested", () => {
  const manifestLoadBlock = editorIndexHtml.match(
    /const comparisonManifest =\s*([\s\S]*?)\s*const comparisonViewpoint =/,
  )?.[1];

  assert.ok(
    manifestLoadBlock,
    "expected comparisonManifest block in editor index",
  );
  assert.match(
    manifestLoadBlock,
    /typeof firstUrl === "string"[\s\S]*loadUegsManifestForSpzUrl\(firstUrl, manifestOverrideUrl\)/,
    "editor should load the UEGS manifest whenever a URL-backed splat is loaded",
  );
  assert.doesNotMatch(
    manifestLoadBlock,
    /!explicitCameraRequested/,
    "explicit camera params must not suppress manifest loading because the manifest owns UEGS preview/presentation contracts",
  );

  const viewpointLoadBlock = editorIndexHtml.match(
    /const comparisonViewpoint =\s*([\s\S]*?)\s*currentComparisonViewpoint =/,
  )?.[1];

  assert.ok(
    viewpointLoadBlock,
    "expected comparisonViewpoint block in editor index",
  );
  assert.match(
    viewpointLoadBlock,
    /!explicitCameraRequested[\s\S]*parseUegsComparisonViewpoint\(comparisonManifest\)/,
    "explicit camera params should only suppress applying the manifest camera viewpoint",
  );
});

test("explicit camera requests survive URL-backed UEGS loads", () => {
  const postLoadCameraBlock = editorIndexHtml.match(
    /\/\/ Hide progress bar when done[\s\S]*?\/\/ Restore focus to canvas for keyboard controls/,
  )?.[0];

  assert.ok(
    postLoadCameraBlock,
    "expected post-load camera application block in editor index",
  );
  assert.match(
    postLoadCameraBlock,
    /else if \(\s*!explicitCameraRequested\s*\)[\s\S]*placeStaticCamera\(\)/,
    "post-load static camera fallback must not overwrite an explicitly requested camera pose",
  );
  assert.match(
    postLoadCameraBlock,
    /applyCameraControlMode\(\{ focusCanvas: false \}\);[\s\S]*if \(initialExplicitCameraPose\)[\s\S]*setEditorCameraPose\(initialExplicitCameraPose\)/,
    "explicit camera pose must be re-applied after control-mode setup refreshes OrbitControls",
  );
});

test("manifest camera application preserves exact pose through OrbitControls bookkeeping", () => {
  const applyManifestCameraBlock = editorIndexHtml.match(
    /function applyComparisonViewpointToCamera\(comparisonViewpoint\) \{[\s\S]*?return true;\s*\}/,
  )?.[0];

  assert.ok(
    applyManifestCameraBlock,
    "expected applyComparisonViewpointToCamera block in editor index",
  );
  assert.match(
    applyManifestCameraBlock,
    /preserveCameraPoseOrbitTarget = true;[\s\S]*alignOrbitTargetToCameraDirection\(bounds\);[\s\S]*orbitControls\.update\(\)/,
    "manifest camera application should align the orbit target along the authored camera ray before OrbitControls updates",
  );
  assert.doesNotMatch(
    applyManifestCameraBlock,
    /orbitControls\.target\.copy\(loadedBoundsCenter\)/,
    "manifest camera application must not retarget OrbitControls to scene center because that rewrites the authored quaternion",
  );

  const controlModeBlock = editorIndexHtml.match(
    /function applyCameraControlMode\(\{ focusCanvas = true \} = \{\}\) \{[\s\S]*?\n {4}\}/,
  )?.[0];
  assert.ok(controlModeBlock, "expected applyCameraControlMode block");
  assert.match(
    controlModeBlock,
    /refreshLoadedBoundsCameraRig\(\{[\s\S]*preserveOrbitTarget: preserveCameraPoseOrbitTarget/,
    "control-mode refresh should not undo a just-applied manifest or explicit camera pose",
  );
});
