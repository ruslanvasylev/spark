import assert from "node:assert";
import * as THREE from "three";
import type { SplatMesh } from "../src/SplatMesh.js";
import {
  type UegsBundle,
  UegsDebugViewMode,
  UegsPayloadAppearanceEncoding,
  UegsPayloadColorSemantic,
  UegsPayloadMaterialTruthSource,
  alignUegsNormalToShellHemisphere,
  applyUegsSparkViewContract,
  configureUegsBundleForMesh,
  getUegsSparkRenderContract,
  getUegsSparkViewContract,
  inspectUegsRuntimeTelemetry,
  loadOptionalUegsBundleFromUrl,
  parseUegsDebugCaptureSidecar,
  parseUegsGaussianPayload,
  parseUegsManifest,
  parseUegsSceneLightingContract,
  setUegsAmbientOcclusionEnabled,
  setUegsBakedShadowEnabled,
  setUegsDebugViewMode,
  setUegsDirectLightingEnabled,
  setUegsSkyLightingEnabled,
} from "../src/uegs.js";

function buildPayloadFixture(
  version: 5 | 6,
  overrides?: {
    normal?: readonly [number, number, number];
    rotation?: readonly [number, number, number, number];
    logScale?: readonly [number, number, number];
  },
) {
  const recordBytes = version === 6 ? 172 : 168;
  const bytes = new ArrayBuffer(56 + recordBytes);
  const view = new DataView(bytes);
  let offset = 0;

  view.setUint32(offset, 0x55454753, true);
  offset += 4;
  view.setUint32(offset, version, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;

  const writeFloat = (value: number) => {
    view.setFloat32(offset, value, true);
    offset += 4;
  };
  const writeVec3 = (x: number, y: number, z: number) => {
    writeFloat(x);
    writeFloat(y);
    writeFloat(z);
  };
  const writeVec4 = (x: number, y: number, z: number, w: number) => {
    writeFloat(x);
    writeFloat(y);
    writeFloat(z);
    writeFloat(w);
  };

  writeVec3(1, 2, 3); // bounds origin
  writeVec3(4, 5, 6); // bounds extent
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint8(offset, UegsPayloadMaterialTruthSource.HeuristicBindings);
  offset += 1;
  view.setUint8(offset, UegsPayloadColorSemantic.SurfaceBaseColorLinear);
  offset += 1;
  view.setUint8(
    offset,
    version === 6
      ? UegsPayloadAppearanceEncoding.ExplorableSceneRelightBakedShadows
      : UegsPayloadAppearanceEncoding.ExplorableSceneRelight,
  );
  offset += 1;
  view.setUint8(offset, 0);
  offset += 1;

  const normal = overrides?.normal ?? [0, 0, 1];
  const rotation = overrides?.rotation ?? [0, 0, 0, 1];
  const logScale = overrides?.logScale ?? [0.1, 0.2, 0.3];

  writeVec3(10, 20, 30); // position
  writeVec3(normal[0], normal[1], normal[2]); // normal
  writeVec4(rotation[0], rotation[1], rotation[2], rotation[3]); // rotation
  writeVec3(logScale[0], logScale[1], logScale[2]); // log scale
  writeVec3(1, 1, 1); // cov diag
  writeVec3(0, 0, 0); // cov off diag
  writeVec3(0.2, 0.3, 0.4); // base
  writeVec3(0.01, 0.02, 0.03); // emissive
  writeFloat(0.9); // opacity
  writeVec3(0, 0, 0); // sh dc
  writeFloat(0.7); // metallic
  writeVec3(0, 0, 0);
  writeVec3(0, 0, 0);
  writeVec3(0, 0, 0);
  writeFloat(0.35); // roughness
  writeFloat(0.8); // ao
  if (version === 6) {
    writeFloat(0.6); // baked shadow
  }
  view.setUint8(offset, 0);
  offset += 1;
  view.setUint8(offset, UegsPayloadMaterialTruthSource.HeuristicBindings);
  offset += 1;
  view.setUint16(offset, 0, true);

  return new Uint8Array(bytes);
}

function buildSceneLightingFixture(
  bakedGeometryShadowTransferExported: boolean,
) {
  return parseUegsSceneLightingContract(
    JSON.stringify({
      contract: "uegs_explorable_scene_lighting_v1",
      linear_scene_color: true,
      tone_mapping_applied: false,
      lens_effects_applied: false,
      material_ambient_occlusion_exported: true,
      geometry_contact_shadow_approximation_expected: false,
      baked_geometry_shadow_transfer_exported:
        bakedGeometryShadowTransferExported,
      intensity_units: "ue_raw_light_component_intensity",
      directional_lights: [
        {
          direction_x: 0,
          direction_y: 0,
          direction_z: 1,
          color_r: 1,
          color_g: 0.5,
          color_b: 0.25,
          intensity: 2,
          casts_shadows: true,
        },
      ],
      local_lights: [
        {
          type: "spot",
          position_x: 10,
          position_y: 20,
          position_z: 30,
          direction_x: 1,
          direction_y: 0,
          direction_z: 0,
          color_r: 0.25,
          color_g: 0.5,
          color_b: 1,
          intensity: 4,
          attenuation_radius_cm: 500,
          inner_cone_cos: 0.9,
          outer_cone_cos: 0.8,
          casts_shadows: true,
        },
      ],
      sky_lights: [
        {
          color_r: 1,
          color_g: 1,
          color_b: 1,
          intensity: 0.5,
          real_time_capture: true,
        },
      ],
    }),
  );
}

function buildDebugCaptureFixture() {
  const bytes = new ArrayBuffer(32 + 104);
  const view = new DataView(bytes);
  let offset = 0;

  const writeFloat = (value: number) => {
    view.setFloat32(offset, value, true);
    offset += 4;
  };
  const writeVec4 = (x: number, y: number, z: number, w: number) => {
    writeFloat(x);
    writeFloat(y);
    writeFloat(z);
    writeFloat(w);
  };

  view.setUint32(offset, 0x55454744, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 32, true);
  offset += 4;
  view.setUint32(offset, 104, true);
  offset += 4;
  view.setUint32(offset, 0x3f, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;

  writeVec4(0.8, 0.7, 0.6, 1.0); // scene color
  writeVec4(0.4, 0.5, 0.6, 1.0); // target base color
  writeVec4(0.2, 0.4, 0.6, 1.0); // target normal
  writeVec4(0.1, 0.3, 0.5, 1.0); // scene normal
  writeVec4(0.25, 0.35, 0.45, 1.0); // direct shadowed
  writeVec4(0.65, 0.75, 0.85, 1.0); // direct unshadowed
  view.setUint32(offset, 0x3f, true);
  offset += 4;
  view.setUint8(offset, 1);
  offset += 1;
  view.setUint8(offset, 1);
  offset += 1;
  view.setUint16(offset, 0, true);

  return new Uint8Array(bytes);
}

function buildBundleFixture(version: 5 | 6) {
  return {
    manifest: parseUegsManifest(
      JSON.stringify({
        tool: "UEGS",
        status: "gaussian_payload_export",
        settings: { export_format: "Spz" },
        payload_contract: {
          appearance_encoding:
            version === 6
              ? "explorable_scene_relight_baked_shadows"
              : "explorable_scene_relight",
        },
        gaussian_debug_capture_sidecar: {
          path: "uegs_captured_debug_passes.bin",
          schema: "uegs_captured_debug_passes_v1",
          scene_color_count: 1,
        },
      }),
    ),
    payload: parseUegsGaussianPayload(buildPayloadFixture(version)),
    sceneLighting: buildSceneLightingFixture(version === 6),
    debugCapture: parseUegsDebugCaptureSidecar(buildDebugCaptureFixture()),
  };
}

function buildSpzExactGeometryFixture(
  scale: readonly [number, number, number] = [9, 8, 7],
  quaternion: readonly [number, number, number, number] = [0.5, 0.5, 0.5, 0.5],
) {
  return {
    scales: new Float32Array([scale[0], scale[1], scale[2], 0]),
    quaternions: new Float32Array([
      quaternion[0],
      quaternion[1],
      quaternion[2],
      quaternion[3],
    ]),
  };
}

function buildFakeMesh(
  bundle: ReturnType<typeof buildBundleFixture>,
  spzExactGeometry = buildSpzExactGeometryFixture(),
) {
  let updateVersionCalls = 0;
  const mesh = {
    packedSplats: {
      numSplats: bundle.payload.header.recordCount,
      extra: { uegsBundle: bundle, spzExactGeometry },
    },
    enableViewToWorld: false,
    maxSh: 3,
    uegsModifier: undefined,
    context: {
      viewToWorld: { translate: new THREE.Vector3() },
      transform: { rotate: new THREE.Vector4(0, 0, 0, 1) },
    },
    updateVersion() {
      updateVersionCalls += 1;
    },
    get updateVersionCalls() {
      return updateVersionCalls;
    },
  };
  return mesh;
}

function asSplatMesh(mesh: ReturnType<typeof buildFakeMesh>): SplatMesh {
  return mesh as unknown as SplatMesh;
}

function asUegsBundle(
  bundle: ReturnType<typeof buildBundleFixture>,
): UegsBundle {
  return bundle as unknown as UegsBundle;
}

const payload = parseUegsGaussianPayload(buildPayloadFixture(6));
const approx = (actual: number, expected: number) => {
  assert.ok(Math.abs(actual - expected) < 1.0e-6, `${actual} != ${expected}`);
};
assert.strictEqual(payload.header.recordCount, 1);
assert.strictEqual(
  payload.header.appearanceEncoding,
  UegsPayloadAppearanceEncoding.ExplorableSceneRelightBakedShadows,
);
approx(payload.header.boundsOrigin.x, 2);
approx(payload.header.boundsOrigin.y, 3);
approx(payload.header.boundsOrigin.z, -1);
approx(payload.header.boundsExtent.x, 5);
approx(payload.header.boundsExtent.y, 6);
approx(payload.header.boundsExtent.z, 4);
approx(payload.normalRoughness[0], 0);
approx(payload.normalRoughness[1], 1);
approx(payload.normalRoughness[2], 0);
approx(payload.exactGeometry.centers[0], 20);
approx(payload.exactGeometry.centers[1], 30);
approx(payload.exactGeometry.centers[2], -10);
approx(payload.exactGeometry.scales[0], Math.exp(0.2));
approx(payload.exactGeometry.scales[1], Math.exp(0.3));
approx(payload.exactGeometry.scales[2], Math.exp(0.1));
approx(payload.exactGeometry.quaternions[0], 0);
approx(payload.exactGeometry.quaternions[1], 0);
approx(payload.exactGeometry.quaternions[2], 0);
approx(payload.exactGeometry.quaternions[3], 1);
assert.strictEqual(payload.exactGeometry.source, "payload");
approx(payload.baseMetallic[0], 0.2);
approx(payload.baseMetallic[1], 0.3);
approx(payload.baseMetallic[2], 0.4);
approx(payload.baseMetallic[3], 0.7);
approx(payload.normalRoughness[3], 0.35);
approx(payload.emissiveAmbientOcclusion[3], 0.8);
approx(payload.bakedShadowOpacity[0], 0.6);
approx(payload.bakedShadowOpacity[1], 0.9);

const shellPayload = parseUegsGaussianPayload(
  buildPayloadFixture(6, {
    normal: [0, 0, 1],
    rotation: [0, 0, 0, 1],
    logScale: [Math.log(10), Math.log(20), Math.log(0.001)],
  }),
);
const shellQuat = new THREE.Quaternion(
  shellPayload.exactGeometry.quaternions[0],
  shellPayload.exactGeometry.quaternions[1],
  shellPayload.exactGeometry.quaternions[2],
  shellPayload.exactGeometry.quaternions[3],
).normalize();
const shellThinAxis = new THREE.Vector3(0, 1, 0)
  .applyQuaternion(shellQuat)
  .normalize();
const shellPayloadNormal = new THREE.Vector3(
  shellPayload.normalRoughness[0],
  shellPayload.normalRoughness[1],
  shellPayload.normalRoughness[2],
).normalize();
assert.ok(shellThinAxis.dot(shellPayloadNormal) > 0.999999);
approx(shellPayload.exactGeometry.scales[0], 20);
approx(shellPayload.exactGeometry.scales[1], 0.001);
approx(shellPayload.exactGeometry.scales[2], 10);

const legacyPayload = parseUegsGaussianPayload(buildPayloadFixture(5));
assert.strictEqual(
  legacyPayload.header.appearanceEncoding,
  UegsPayloadAppearanceEncoding.ExplorableSceneRelight,
);
approx(legacyPayload.bakedShadowOpacity[0], 1.0);
approx(legacyPayload.bakedShadowOpacity[1], 0.9);

const manifest = parseUegsManifest(
  JSON.stringify({
    tool: "UEGS",
    status: "gaussian_payload_export",
    settings: { export_format: "Spz" },
    payload_contract: {
      appearance_encoding: "explorable_scene_relight_baked_shadows",
    },
  }),
);
assert.strictEqual(manifest.tool, "UEGS");
assert.strictEqual(manifest.settings?.export_format, "Spz");

const sceneLighting = parseUegsSceneLightingContract(
  JSON.stringify({
    contract: "uegs_explorable_scene_lighting_v1",
    linear_scene_color: true,
    tone_mapping_applied: false,
    lens_effects_applied: false,
    material_ambient_occlusion_exported: true,
    geometry_contact_shadow_approximation_expected: false,
    baked_geometry_shadow_transfer_exported: true,
    intensity_units: "ue_raw_light_component_intensity",
    directional_lights: [
      {
        direction_x: 0,
        direction_y: 0,
        direction_z: 1,
        color_r: 1,
        color_g: 0.5,
        color_b: 0.25,
        intensity: 2,
        casts_shadows: true,
      },
    ],
    local_lights: [
      {
        type: "spot",
        position_x: 10,
        position_y: 20,
        position_z: 30,
        direction_x: 1,
        direction_y: 0,
        direction_z: 0,
        color_r: 0.25,
        color_g: 0.5,
        color_b: 1,
        intensity: 4,
        attenuation_radius_cm: 500,
        inner_cone_cos: 0.9,
        outer_cone_cos: 0.8,
        casts_shadows: true,
      },
    ],
    sky_lights: [
      {
        color_r: 1,
        color_g: 1,
        color_b: 1,
        intensity: 0.5,
        real_time_capture: true,
      },
    ],
  }),
);
assert.strictEqual(sceneLighting.directionalLights.length, 1);
assert.strictEqual(sceneLighting.localLights.length, 1);
assert.strictEqual(sceneLighting.skyLights.length, 1);
assert.strictEqual(sceneLighting.bakedGeometryShadowTransferExported, true);
approx(sceneLighting.directionalLights[0].direction.x, 0);
approx(sceneLighting.directionalLights[0].direction.y, 1);
approx(sceneLighting.directionalLights[0].direction.z, 0);
approx(sceneLighting.localLights[0].position.x, 20);
approx(sceneLighting.localLights[0].position.y, 30);
approx(sceneLighting.localLights[0].position.z, -10);
approx(sceneLighting.localLights[0].direction.x, 0);
approx(sceneLighting.localLights[0].direction.y, 0);
approx(sceneLighting.localLights[0].direction.z, -1);

const debugCapture = parseUegsDebugCaptureSidecar(buildDebugCaptureFixture());
assert.strictEqual(debugCapture.recordCount, 1);
approx(debugCapture.sceneColor[0], 0.8);
approx(debugCapture.targetBaseColor[1], 0.5);
approx(debugCapture.targetNormal[2], 0.6);
approx(debugCapture.sceneNormal[0], 0.1);
approx(debugCapture.directShadowed[0], 0.25);
approx(debugCapture.directUnshadowed[2], 0.85);
assert.strictEqual(debugCapture.telemetry.sceneColorCount, 1);
assert.strictEqual(debugCapture.telemetry.directShadowedCount, 1);

const bakedMesh = buildFakeMesh(buildBundleFixture(6));
const bakedSplatMesh = asSplatMesh(bakedMesh);
assert.strictEqual(configureUegsBundleForMesh(bakedSplatMesh), true);
let bakedRuntime = inspectUegsRuntimeTelemetry(bakedSplatMesh);
assert.strictEqual(bakedRuntime.autoConfigured, true);
assert.strictEqual(bakedRuntime.modifierConfigured, true);
assert.strictEqual(bakedRuntime.exactGeometryAvailable, true);
assert.strictEqual(bakedRuntime.exactGeometrySource, "hybrid");
assert.strictEqual(bakedRuntime.enableViewToWorld, true);
assert.strictEqual(bakedRuntime.maxSh, 0);
assert.strictEqual(bakedRuntime.bakedShadowTransferAvailable, true);
assert.strictEqual(bakedRuntime.runtimeUniforms.bakedShadowEnabled, true);
const bakedResources = bakedMesh.packedSplats.extra.uegsGpuResources;
assert.ok(bakedResources);
approx(bakedResources.exactCenterTexture.value.image.data[0], 20);
approx(bakedResources.exactCenterTexture.value.image.data[1], 30);
approx(bakedResources.exactCenterTexture.value.image.data[2], -10);
approx(bakedResources.exactScaleTexture.value.image.data[0], 9);
approx(bakedResources.exactScaleTexture.value.image.data[1], 8);
approx(bakedResources.exactScaleTexture.value.image.data[2], 7);
approx(bakedResources.exactQuaternionTexture.value.image.data[0], 0.5);
approx(bakedResources.exactQuaternionTexture.value.image.data[1], 0.5);
approx(bakedResources.exactQuaternionTexture.value.image.data[2], 0.5);
approx(bakedResources.exactQuaternionTexture.value.image.data[3], 0.5);
approx(bakedResources.capturedSceneColorTexture.value.image.data[0], 0.8);
approx(bakedResources.capturedTargetBaseColorTexture.value.image.data[1], 0.5);
approx(bakedResources.capturedDirectShadowedTexture.value.image.data[2], 0.45);
assert.strictEqual(setUegsBakedShadowEnabled(bakedSplatMesh, false), true);
assert.strictEqual(setUegsDirectLightingEnabled(bakedSplatMesh, false), true);
assert.strictEqual(setUegsSkyLightingEnabled(bakedSplatMesh, false), true);
assert.strictEqual(setUegsAmbientOcclusionEnabled(bakedSplatMesh, false), true);
assert.strictEqual(
  setUegsDebugViewMode(bakedSplatMesh, UegsDebugViewMode.BakedShadow),
  true,
);
bakedRuntime = inspectUegsRuntimeTelemetry(bakedSplatMesh);
assert.strictEqual(bakedRuntime.runtimeUniforms.bakedShadowEnabled, false);
assert.strictEqual(bakedRuntime.runtimeUniforms.directLightingEnabled, false);
assert.strictEqual(bakedRuntime.runtimeUniforms.skyLightingEnabled, false);
assert.strictEqual(bakedRuntime.runtimeUniforms.ambientOcclusionEnabled, false);
assert.strictEqual(
  bakedRuntime.runtimeUniforms.debugViewMode,
  UegsDebugViewMode.BakedShadow,
);
assert.deepStrictEqual(bakedRuntime.recommendedViewContract, {
  sortRadial: false,
  sort32: true,
  stochastic: false,
  sort360: false,
  depthBias: 0,
  reason:
    "UEGS explorable scene-parity bundles should follow the canonical UEGS runtime more closely than Spark's shell heuristic. Prefer stable 32-bit depth ordering without stochastic depth writes so the full 3D Gaussian ellipsoid projects accumulate like the UEGS renderer instead of turning into dot-noise shell ownership.",
});
assert.deepStrictEqual(bakedRuntime.recommendedRenderContract, {
  enable2DGS: false,
  useUegsProjectedEllipse: false,
  opaqueShellCoverage: true,
  maxPixelRadius: 512,
  flattenMinAxisTo2D: false,
  clampMinimumShellScale: true,
  cullBackfacingShellSplats: true,
  orientNormalsToShellHemisphere: false,
  flipNormalsToView: false,
  usePayloadOpacity: true,
  useSerializedBaseColorForBaseView: false,
  reason:
    "UEGS explorable scene-parity bundles render most faithfully in Spark by keeping the payload's exact 3D ellipsoid geometry for coverage while preserving the exported shading normal as-is. Suppress splats whose exported surface normal faces away from the view so rear-layer baked-shadow values do not leak through the front surface, and keep the exported shading normal without reorienting it toward the derived shell frame.",
});
assert.strictEqual(bakedMesh.updateVersionCalls, 0);

const bakedView = {
  sortRadial: true,
  sort32: false,
  stochastic: false,
  sort360: false,
  depthBias: 0,
};
assert.deepStrictEqual(
  applyUegsSparkViewContract(bakedView, bakedSplatMesh),
  bakedRuntime.recommendedViewContract,
);
assert.deepStrictEqual(bakedView, {
  sortRadial: false,
  sort32: true,
  stochastic: false,
  sort360: false,
  depthBias: 0,
});

const relightMesh = buildFakeMesh(buildBundleFixture(5));
const relightSplatMesh = asSplatMesh(relightMesh);
assert.strictEqual(configureUegsBundleForMesh(relightSplatMesh), true);
const relightRuntime = inspectUegsRuntimeTelemetry(relightSplatMesh);
assert.strictEqual(relightRuntime.bakedShadowTransferAvailable, false);
assert.strictEqual(relightRuntime.exactGeometryAvailable, true);
assert.strictEqual(relightRuntime.exactGeometrySource, "hybrid");
assert.strictEqual(relightRuntime.runtimeUniforms.bakedShadowEnabled, false);
assert.strictEqual(setUegsBakedShadowEnabled(relightSplatMesh, true), false);
assert.deepStrictEqual(getUegsSparkViewContract(relightSplatMesh), {
  sortRadial: false,
  sort32: true,
  stochastic: false,
  sort360: false,
  depthBias: 0,
  reason:
    "UEGS explorable scene-parity bundles should follow the canonical UEGS runtime more closely than Spark's shell heuristic. Prefer stable 32-bit depth ordering without stochastic depth writes so the full 3D Gaussian ellipsoid projects accumulate like the UEGS renderer instead of turning into dot-noise shell ownership.",
});
assert.deepStrictEqual(getUegsSparkRenderContract(relightSplatMesh), {
  enable2DGS: false,
  useUegsProjectedEllipse: false,
  opaqueShellCoverage: true,
  maxPixelRadius: 512,
  flattenMinAxisTo2D: false,
  clampMinimumShellScale: true,
  cullBackfacingShellSplats: true,
  orientNormalsToShellHemisphere: false,
  flipNormalsToView: false,
  usePayloadOpacity: true,
  useSerializedBaseColorForBaseView: false,
  reason:
    "UEGS explorable scene-parity bundles render most faithfully in Spark by keeping the payload's exact 3D ellipsoid geometry for coverage while preserving the exported shading normal as-is. Suppress splats whose exported surface normal faces away from the view so rear-layer baked-shadow values do not leak through the front surface, and keep the exported shading normal without reorienting it toward the derived shell frame.",
});

const shellNormal = new THREE.Vector3(0, 0, 1);
const alignedOutward = alignUegsNormalToShellHemisphere(
  new THREE.Vector3(0, 0, -1),
  shellNormal,
);
approx(alignedOutward.x, 0);
approx(alignedOutward.y, 0);
approx(alignedOutward.z, 1);
const preservedOutward = alignUegsNormalToShellHemisphere(
  new THREE.Vector3(0.2, 0.3, 0.9),
  shellNormal,
);
assert.ok(preservedOutward.dot(shellNormal) > 0);

const translucentBundle = buildBundleFixture(6);
translucentBundle.payload.header.opaqueCount = 0;
translucentBundle.payload.header.translucentCount = 1;
const translucentUegsBundle = asUegsBundle(translucentBundle);
assert.strictEqual(getUegsSparkViewContract(translucentUegsBundle), undefined);
assert.strictEqual(
  getUegsSparkRenderContract(translucentUegsBundle),
  undefined,
);

const originalFetchForBakedManifest = globalThis.fetch;
const fetchedBakedManifestUrls: string[] = [];
try {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    fetchedBakedManifestUrls.push(url);
    if (url === "http://localhost/exports/uegs_manifest.json") {
      return new Response(
        JSON.stringify({
          tool: "UEGS",
          status: "gaussian_payload_export",
          settings: { export_format: "Spz" },
          payload_contract: {
            appearance_encoding: "conservative_first_order_sh",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("missing", { status: 404 });
  };

  const loadedBakedManifestBundle = await loadOptionalUegsBundleFromUrl(
    "/exports/uegs_gaussians.spz",
  );
  assert.strictEqual(loadedBakedManifestBundle, undefined);
  assert.deepStrictEqual(fetchedBakedManifestUrls, [
    "http://localhost/exports/uegs_manifest.json",
  ]);
} finally {
  globalThis.fetch = originalFetchForBakedManifest;
}

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "http://localhost/exports/uegs_manifest.json") {
      return new Response(
        JSON.stringify({
          tool: "UEGS",
          status: "gaussian_payload_export",
          settings: { export_format: "Spz" },
          payload_contract: {
            appearance_encoding: "explorable_scene_relight_baked_shadows",
          },
          gaussian_debug_capture_sidecar: {
            path: "uegs_captured_debug_passes.bin",
            schema: "uegs_captured_debug_passes_v1",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "http://localhost/exports/uegs_gaussians_payload.bin") {
      return new Response(buildPayloadFixture(6), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (url === "http://localhost/exports/uegs_scene_lighting.json") {
      return new Response(
        JSON.stringify({
          contract: "uegs_explorable_scene_lighting_v1",
          linear_scene_color: true,
          tone_mapping_applied: false,
          lens_effects_applied: false,
          material_ambient_occlusion_exported: true,
          geometry_contact_shadow_approximation_expected: false,
          baked_geometry_shadow_transfer_exported: true,
          intensity_units: "ue_raw_light_component_intensity",
          directional_lights: [],
          local_lights: [],
          sky_lights: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "http://localhost/exports/uegs_captured_debug_passes.bin") {
      return new Response(buildDebugCaptureFixture(), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    return new Response("missing", { status: 404 });
  };

  const loadedBundle = await loadOptionalUegsBundleFromUrl(
    "/exports/uegs_gaussians.spz",
  );
  assert.ok(loadedBundle);
  assert.strictEqual(
    loadedBundle?.payload.header.appearanceEncoding,
    UegsPayloadAppearanceEncoding.ExplorableSceneRelightBakedShadows,
  );
  approx(loadedBundle?.debugCapture?.sceneColor[0] ?? 0, 0.8);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("✅ UEGS bundle parsing tests passed");
