import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promoteUegsHelmetViewers } from "../scripts/lib/promote-uegs-helmet-viewers.js";

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath: string, value: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

const tmpRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "spark-promote-uegs-viewers-"),
);

try {
  const assetsRoot = path.join(tmpRoot, "assets");
  const compositeDir = path.join(tmpRoot, "composite");
  const debugDir = path.join(tmpRoot, "debug");

  const basePayloadContract = {
    appearance_encoding: "conservative_first_order_sh",
    appearance_intent: "baked_capture_parity_sh_residual",
    capture_backed_baked_final: true,
    color_semantic: "baked_scene_appearance_linear",
    material_truth_source: "heuristic_bindings",
    scene_appearance_build_method: "rendered_scene_capture",
    strict_baked_shadow_transfer_required: false,
  };

  const compositeManifest = {
    generated_at: "2026-04-16T06:01:27.199Z",
    payload_contract: basePayloadContract,
    gaussian_seed_artifact: { gaussian_count: 1 },
    gaussian_payload_sidecar: {
      path: "uegs_gaussians_payload.bin",
      schema: "uegs_canonical_gaussian_payload_v6",
      gaussian_count: 1,
    },
    scene_lighting_contract: {
      path: "uegs_scene_lighting.json",
      contract: "uegs_explorable_scene_lighting_v1",
      directional_light_count: 1,
      local_light_count: 0,
      sky_light_count: 1,
      baked_geometry_shadow_transfer_exported: false,
      baked_geometry_shadow_transfer_complete: false,
    },
  };

  const debugManifest = {
    generated_at: "2026-04-16T06:01:27.199Z",
    payload_contract: {
      appearance_encoding: "explorable_scene_relight_baked_shadows",
      appearance_intent: "debug_preserved_terms_baked_shadow_transfer",
      capture_backed_baked_final: false,
      color_semantic: "surface_base_color_linear",
      material_truth_source: "heuristic_bindings",
      scene_appearance_build_method: "none",
      strict_baked_shadow_transfer_required: false,
    },
    gaussian_seed_artifact: { gaussian_count: 1 },
    gaussian_payload_sidecar: {
      path: "uegs_gaussians_payload.bin",
      schema: "uegs_canonical_gaussian_payload_v6",
      gaussian_count: 1,
    },
    scene_lighting_contract: {
      path: "uegs_scene_lighting.json",
      contract: "uegs_explorable_scene_lighting_v1",
      directional_light_count: 1,
      local_light_count: 0,
      sky_light_count: 1,
      baked_geometry_shadow_transfer_exported: true,
      baked_geometry_shadow_transfer_complete: true,
    },
    gaussian_debug_capture_sidecar: {
      path: "uegs_captured_debug_passes.bin",
      schema: "uegs_captured_debug_passes_v1",
      gaussian_count: 1,
    },
  };

  await writeJson(path.join(compositeDir, "uegs_manifest.json"), compositeManifest);
  await writeText(path.join(compositeDir, "uegs_gaussians.spz"), "composite-spz");
  await writeText(
    path.join(compositeDir, "uegs_gaussians_payload.bin"),
    "composite-payload",
  );
  await writeText(
    path.join(compositeDir, "uegs_scene_lighting.json"),
    JSON.stringify({ contract: "uegs_explorable_scene_lighting_v1" }),
  );

  await writeJson(path.join(debugDir, "uegs_manifest.json"), debugManifest);
  await writeText(path.join(debugDir, "uegs_gaussians.spz"), "debug-spz");
  await writeText(path.join(debugDir, "uegs_gaussians_payload.bin"), "debug-payload");
  await writeText(
    path.join(debugDir, "uegs_scene_lighting.json"),
    JSON.stringify({ contract: "uegs_explorable_scene_lighting_v1" }),
  );
  await writeText(
    path.join(debugDir, "uegs_captured_debug_passes.bin"),
    "debug-capture",
  );

  const state = await promoteUegsHelmetViewers({
    assetsRoot,
    compositeDir,
    debugDir,
  });

  const compositeSceneLightingLink = path.join(
    assetsRoot,
    "current-composite",
    "uegs_scene_lighting.json",
  );
  const compositeSceneLightingStats = await fs.lstat(compositeSceneLightingLink);
  assert.ok(compositeSceneLightingStats.isSymbolicLink());
  assert.strictEqual(state.composite.sceneLightingPresent, true);
  assert.strictEqual(
    state.composite.files.sceneLighting,
    "/examples/editor/assets/current-composite/uegs_scene_lighting.json",
  );

  const compositeSceneLightingTarget = await fs.readlink(compositeSceneLightingLink);
  assert.ok(
    compositeSceneLightingTarget.endsWith(
      path.join("composite", "uegs_scene_lighting.json"),
    ),
  );

  const viewerState = JSON.parse(
    await fs.readFile(path.join(assetsRoot, "current-uegs-viewers.json"), "utf8"),
  ) as {
    composite: { sceneLightingPresent: boolean; files: { sceneLighting: string } };
  };
  assert.strictEqual(viewerState.composite.sceneLightingPresent, true);
  assert.strictEqual(
    viewerState.composite.files.sceneLighting,
    "/examples/editor/assets/current-composite/uegs_scene_lighting.json",
  );
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

console.log("✅ UEGS viewer promotion tests passed");
