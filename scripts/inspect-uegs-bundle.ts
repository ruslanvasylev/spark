import fs from "node:fs/promises";
import path from "node:path";
import {
  parseUegsGaussianPayload,
  parseUegsManifest,
  parseUegsSceneLightingContract,
  summarizeUegsBundle,
} from "../src/uegs.js";

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error(
      "Usage: npm run inspect:uegs -- <uegs_gaussians.spz|bundle_dir>",
    );
  }

  const resolved = path.resolve(input);
  const stats = await fs.stat(resolved);
  const bundleDir = stats.isDirectory() ? resolved : path.dirname(resolved);

  const [manifestText, payloadBytes, sceneLightingText] = await Promise.all([
    fs.readFile(path.join(bundleDir, "uegs_manifest.json"), "utf8"),
    fs.readFile(path.join(bundleDir, "uegs_gaussians_payload.bin")),
    fs.readFile(path.join(bundleDir, "uegs_scene_lighting.json"), "utf8"),
  ]);

  const bundle = {
    manifest: parseUegsManifest(manifestText),
    payload: parseUegsGaussianPayload(payloadBytes),
    sceneLighting: parseUegsSceneLightingContract(sceneLightingText),
  };
  const summary = summarizeUegsBundle(bundle);

  console.log(
    JSON.stringify(
      {
        bundleDir,
        manifest: {
          exportFormat: bundle.manifest.settings?.export_format,
          exportAppearanceMode:
            bundle.manifest.settings?.export_appearance_mode,
          appearanceEncoding:
            bundle.manifest.payload_contract?.appearance_encoding,
          sceneLightingContract:
            bundle.manifest.scene_lighting_contract?.contract,
          sceneLightingColorPipeline:
            bundle.manifest.scene_lighting_contract?.color_pipeline,
          lensEffectsBaked:
            bundle.manifest.scene_lighting_contract?.lens_effects_baked,
          bakedGeometryShadowTransferExported:
            bundle.manifest.scene_lighting_contract
              ?.baked_geometry_shadow_transfer_exported,
        },
        summary,
      },
      null,
      2,
    ),
  );
}

void main();
