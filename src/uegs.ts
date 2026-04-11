import * as THREE from "three";
import type { PackedSplats } from "./PackedSplats";
import type { GsplatModifier } from "./SplatGenerator";
import type { SplatMesh } from "./SplatMesh";
import {
  DynoBool,
  DynoInt,
  DynoSampler2D,
  DynoSampler2DArray,
  DynoVec4,
  Gsplat,
  combineGsplat,
  defineGsplatNormal,
  dyno,
  dynoBlock,
  unindent,
  unindentLines,
} from "./dyno";
import { getTextureSize } from "./utils";

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
const UEGS_DEBUG_CAPTURE_HAS_TARGET_BASE_COLOR = 1 << 1;
const UEGS_DEBUG_CAPTURE_HAS_TARGET_NORMAL = 1 << 2;
const UEGS_DEBUG_CAPTURE_HAS_SCENE_NORMAL = 1 << 3;
const UEGS_DEBUG_CAPTURE_HAS_DIRECT_SHADOWED = 1 << 4;
const UEGS_DEBUG_CAPTURE_HAS_DIRECT_UNSHADOWED = 1 << 5;
const MAX_DIRECTIONAL_LIGHTS = 8;
const MAX_LOCAL_LIGHTS = 16;

type JsonRecord = Record<string, unknown>;

export enum UegsPayloadMaterialTruthSource {
  Unknown = 0,
  HeuristicBindings = 1,
  BakedSurface = 2,
}

export enum UegsPayloadColorSemantic {
  Unknown = 0,
  SurfaceBaseColorLinear = 1,
  BakedMaterialAppearanceLinear = 2,
  BakedSceneAppearanceLinear = 3,
}

export enum UegsPayloadAppearanceEncoding {
  None = 0,
  ConservativeFirstOrderSh = 1,
  DirectColorOnly = 2,
  ExplorableSceneRelight = 3,
  ExplorableSceneRelightBakedShadows = 4,
}

export enum UegsDebugViewMode {
  Final = 0,
  BaseColor = 1,
  SerializedColor = 18,
  CapturedSceneColor = 19,
  CapturedTargetBaseColor = 20,
  CapturedTargetNormal = 21,
  CapturedSceneNormal = 22,
  CapturedDirectShadowed = 23,
  CapturedDirectUnshadowed = 24,
  Normal = 2,
  RawNormal = 8,
  DirectLighting = 3,
  AmbientLighting = 4,
  Emissive = 5,
  AmbientOcclusion = 6,
  BakedShadow = 7,
  AmbientTransfer = 9,
  AmbientTransferOccluded = 10,
  DirectTransfer = 11,
  DirectTransferShadowed = 12,
  AmbientContribution = 13,
  AmbientContributionOccluded = 14,
  DirectContribution = 15,
  DirectContributionShadowed = 16,
  BakedComposition = 17,
}

export type UegsManifest = {
  tool: string;
  status: string;
  bounds?: {
    origin_x_cm?: number;
    origin_y_cm?: number;
    origin_z_cm?: number;
    extent_x_cm?: number;
    extent_y_cm?: number;
    extent_z_cm?: number;
  };
  comparison_viewpoint?: {
    source?: string;
    position_x_cm?: number;
    position_y_cm?: number;
    position_z_cm?: number;
    rotation_pitch_degrees?: number;
    rotation_yaw_degrees?: number;
    rotation_roll_degrees?: number;
    quaternion_x?: number;
    quaternion_y?: number;
    quaternion_z?: number;
    quaternion_w?: number;
    vertical_fov_degrees?: number;
    viewport_width_px?: number;
    viewport_height_px?: number;
    inherited_from_viewport?: boolean;
    spark_open_cv?: boolean;
  };
  payload_contract?: {
    material_truth_source?: string;
    color_semantic?: string;
    appearance_encoding?: string;
    appearance_intent?: string;
  };
  settings?: {
    export_format?: string;
    export_appearance_mode?: string;
  };
  scene_lighting_contract?: {
    path?: string;
    contract?: string;
    color_pipeline?: string;
    lens_effects_baked?: boolean;
    baked_geometry_shadow_transfer_exported?: boolean;
    directional_light_count?: number;
    local_light_count?: number;
    sky_light_count?: number;
  };
  gaussian_payload_sidecar?: {
    path?: string;
    schema?: string;
    role?: string;
    preserves_normals?: boolean;
    preserves_emissive?: boolean;
    preserves_ambient_occlusion?: boolean;
    preserves_metallic?: boolean;
    preserves_roughness?: boolean;
    preserves_baked_shadow?: boolean;
    gaussian_count?: number;
  };
  gaussian_debug_capture_sidecar?: {
    path?: string;
    schema?: string;
    role?: string;
    gaussian_count?: number;
    preserves_scene_color?: boolean;
    preserves_target_base_color?: boolean;
    preserves_target_normal?: boolean;
    preserves_scene_normal?: boolean;
    preserves_direct_shadowed_color?: boolean;
    preserves_direct_unshadowed_color?: boolean;
    scene_color_count?: number;
    target_base_color_count?: number;
    target_normal_count?: number;
    scene_normal_count?: number;
    direct_shadowed_color_count?: number;
    direct_unshadowed_color_count?: number;
  };
  gaussian_seed_artifact?: {
    path?: string;
    format?: string;
    gaussian_count?: number;
  };
};

export type UegsComparisonViewpoint = {
  source?: string;
  positionX: number;
  positionY: number;
  positionZ: number;
  quaternionX: number;
  quaternionY: number;
  quaternionZ: number;
  quaternionW: number;
  verticalFovDegrees: number;
  sparkOpenCv: boolean | null;
};

export type UegsDirectionalLight = {
  direction: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  castsShadows: boolean;
};

export type UegsLocalLight = {
  type: "point" | "spot";
  position: THREE.Vector3;
  direction: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  attenuationRadiusCm: number;
  innerConeCos: number;
  outerConeCos: number;
  castsShadows: boolean;
};

export type UegsSkyLight = {
  color: THREE.Color;
  intensity: number;
  realTimeCapture: boolean;
};

export type UegsSceneLightingContract = {
  contract: string;
  linearSceneColor: boolean;
  toneMappingApplied: boolean;
  lensEffectsApplied: boolean;
  materialAmbientOcclusionExported: boolean;
  geometryContactShadowApproximationExpected: boolean;
  bakedGeometryShadowTransferExported: boolean;
  intensityUnits: string;
  directionalLights: UegsDirectionalLight[];
  localLights: UegsLocalLight[];
  skyLights: UegsSkyLight[];
};

export type UegsPayloadHeader = {
  magic: number;
  version: number;
  recordCount: number;
  shDegree: number;
  boundsOrigin: THREE.Vector3;
  boundsExtent: THREE.Vector3;
  opaqueCount: number;
  maskedCount: number;
  translucentCount: number;
  materialTruthSource: UegsPayloadMaterialTruthSource;
  colorSemantic: UegsPayloadColorSemantic;
  appearanceEncoding: UegsPayloadAppearanceEncoding;
  reserved0: number;
};

export type UegsChannelStats = {
  min: number;
  max: number;
  mean: number;
  nonZeroCount: number;
  defaultOneCount: number;
};

export type UegsPayloadTelemetry = {
  recordCount: number;
  header: {
    appearanceEncoding: UegsPayloadAppearanceEncoding;
    materialTruthSource: UegsPayloadMaterialTruthSource;
    colorSemantic: UegsPayloadColorSemantic;
  };
  baseColor: {
    min: THREE.Vector3;
    max: THREE.Vector3;
  };
  emissive: {
    min: THREE.Vector3;
    max: THREE.Vector3;
  };
  roughness: UegsChannelStats;
  metallic: UegsChannelStats;
  ambientOcclusion: UegsChannelStats;
  bakedShadow: UegsChannelStats;
  opacity: UegsChannelStats;
  normalLength: UegsChannelStats;
};

export type UegsGaussianPayload = {
  header: UegsPayloadHeader;
  textureSize: {
    width: number;
    height: number;
    depth: number;
    maxSplats: number;
  };
  normalRoughness: Float32Array;
  baseMetallic: Float32Array;
  emissiveAmbientOcclusion: Float32Array;
  bakedShadowOpacity: Float32Array;
  exactGeometry: UegsRenderableExactSplatGeometry;
  telemetry: UegsPayloadTelemetry;
};

export type UegsDebugCaptureTelemetry = {
  recordCount: number;
  sceneColorCount: number;
  targetBaseColorCount: number;
  targetNormalCount: number;
  sceneNormalCount: number;
  directShadowedCount: number;
  directUnshadowedCount: number;
};

export type UegsDebugCaptureSidecar = {
  recordCount: number;
  textureSize: {
    width: number;
    height: number;
    depth: number;
    maxSplats: number;
  };
  sceneColor: Float32Array;
  targetBaseColor: Float32Array;
  targetNormal: Float32Array;
  sceneNormal: Float32Array;
  directShadowed: Float32Array;
  directUnshadowed: Float32Array;
  telemetry: UegsDebugCaptureTelemetry;
};

export type UegsBundle = {
  manifest: UegsManifest;
  payload: UegsGaussianPayload;
  sceneLighting: UegsSceneLightingContract;
  debugCapture?: UegsDebugCaptureSidecar;
};

export type UegsRuntimeTelemetry = {
  hasBundle: boolean;
  autoConfigured: boolean;
  modifierConfigured: boolean;
  gpuResourcesCreated: boolean;
  exactGeometryAvailable: boolean;
  exactGeometrySource: "payload" | "spz" | "hybrid" | null;
  enableViewToWorld: boolean;
  maxSh: number | null;
  appearanceEncoding: UegsPayloadAppearanceEncoding | null;
  directionalLightCount: number;
  localLightCount: number;
  skyLightCount: number;
  bakedShadowTransferAvailable: boolean;
  recommendedViewContract: UegsSparkViewContract | null;
  recommendedRenderContract: UegsSparkRenderContract | null;
  runtimeUniforms: {
    bakedShadowEnabled: boolean | null;
    directLightingEnabled: boolean | null;
    skyLightingEnabled: boolean | null;
    ambientOcclusionEnabled: boolean | null;
    debugViewMode: UegsDebugViewMode | null;
  };
};

export type UegsSparkViewContract = {
  sortRadial: boolean;
  sort32: boolean;
  stochastic: boolean;
  sort360: boolean;
  depthBias: number;
  reason: string;
};

export type UegsSparkRenderContract = {
  enable2DGS: boolean;
  useUegsProjectedEllipse: boolean;
  opaqueShellCoverage: boolean;
  maxPixelRadius: number;
  flattenMinAxisTo2D: boolean;
  clampMinimumShellScale: boolean;
  cullBackfacingShellSplats: boolean;
  orientNormalsToShellHemisphere: boolean;
  flipNormalsToView: boolean;
  usePayloadOpacity: boolean;
  useSerializedBaseColorForBaseView: boolean;
  reason: string;
};

type UegsGpuResources = {
  normalRoughnessTexture: DynoSampler2DArray<string, THREE.DataArrayTexture>;
  baseMetallicTexture: DynoSampler2DArray<string, THREE.DataArrayTexture>;
  exactCenterTexture: DynoSampler2DArray<string, THREE.DataArrayTexture>;
  exactScaleTexture: DynoSampler2DArray<string, THREE.DataArrayTexture>;
  exactQuaternionTexture: DynoSampler2DArray<string, THREE.DataArrayTexture>;
  emissiveAmbientOcclusionTexture: DynoSampler2DArray<
    string,
    THREE.DataArrayTexture
  >;
  bakedShadowOpacityTexture: DynoSampler2DArray<string, THREE.DataArrayTexture>;
  capturedSceneColorTexture: DynoSampler2DArray<string, THREE.DataArrayTexture>;
  capturedTargetBaseColorTexture: DynoSampler2DArray<
    string,
    THREE.DataArrayTexture
  >;
  capturedTargetNormalTexture: DynoSampler2DArray<
    string,
    THREE.DataArrayTexture
  >;
  capturedSceneNormalTexture: DynoSampler2DArray<
    string,
    THREE.DataArrayTexture
  >;
  capturedDirectShadowedTexture: DynoSampler2DArray<
    string,
    THREE.DataArrayTexture
  >;
  capturedDirectUnshadowedTexture: DynoSampler2DArray<
    string,
    THREE.DataArrayTexture
  >;
  directionalLightsTexture: DynoSampler2D<string, THREE.DataTexture>;
  directionalLightCount: DynoInt<"uegsDirectionalLightCount">;
  localLightsTexture: DynoSampler2D<string, THREE.DataTexture>;
  localLightCount: DynoInt<"uegsLocalLightCount">;
  skyRadiance: DynoVec4<THREE.Vector4, string>;
  bakedShadowEnabled: DynoBool<"uegsBakedShadowEnabled">;
  directLightingEnabled: DynoBool<"uegsDirectLightingEnabled">;
  skyLightingEnabled: DynoBool<"uegsSkyLightingEnabled">;
  ambientOcclusionEnabled: DynoBool<"uegsAmbientOcclusionEnabled">;
  debugViewMode: DynoInt<"uegsDebugViewMode">;
  hasExactSplatGeometry: DynoBool<"uegsHasExactSplatGeometry">;
};

type UegsRenderableExactSplatGeometry = {
  centers: Float32Array;
  scales: Float32Array;
  quaternions: Float32Array;
  source: "payload" | "spz" | "hybrid";
};

type UegsSpzExactSplatGeometry = {
  scales: Float32Array;
  quaternions: Float32Array;
};

type UegsRenderGeometryPreference = "hybrid" | "payload" | "spz";

type UegsExtra = Record<string, unknown> & {
  spzExactGeometry?: UegsSpzExactSplatGeometry;
  uegsBundle?: UegsBundle;
  uegsGpuResources?: UegsGpuResources;
  uegsAutoConfigured?: boolean;
  uegsRenderGeometryPreference?: UegsRenderGeometryPreference;
  uegsRenderContractOverride?: Partial<UegsSparkRenderContract>;
  uegsRequestedMaxSh?: number;
};

function assertObject(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as JsonRecord;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected string`);
  }
  return value;
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid ${label}: expected number`);
  }
  return value;
}

function readBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function readFloat32(view: DataView, offset: number) {
  return view.getFloat32(offset, true);
}

function readVec3(view: DataView, offset: number): THREE.Vector3 {
  return new THREE.Vector3(
    readFloat32(view, offset),
    readFloat32(view, offset + 4),
    readFloat32(view, offset + 8),
  );
}

function convertUegsPositionToSpzBasis(value: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(value.y, value.z, -value.x);
}

function convertUegsDirectionToSpzBasis(value: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(value.y, value.z, -value.x);
}

const UEGS_TO_SPZ_BASIS = new THREE.Matrix4().set(
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  -1,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
);

function quaternionFromAxes(
  axisXIn: THREE.Vector3,
  axisYIn: THREE.Vector3,
  axisZIn: THREE.Vector3,
): THREE.Quaternion {
  const axisX = axisXIn.clone().normalize();
  const axisY = axisYIn.clone().normalize();
  const axisZ = axisZIn.clone().normalize();
  const rotation = new THREE.Matrix4().makeBasis(axisX, axisY, axisZ);
  return new THREE.Quaternion().setFromRotationMatrix(rotation).normalize();
}

function convertUegsQuaternionToSpzBasis(
  value: THREE.Quaternion,
): THREE.Quaternion {
  // UEGS shells use local +Z as the surface normal / thin axis. After converting
  // into the SPZ basis and scale ordering, Spark's generic gsplat path expects that
  // thin axis on local +Y because the extent permutation is (x, y, z) -> (y, z, x).
  const uegsRotation = value.clone().normalize();
  const spzAxisX = convertUegsDirectionToSpzBasis(
    new THREE.Vector3(0, 1, 0).applyQuaternion(uegsRotation),
  );
  const spzAxisZ = convertUegsDirectionToSpzBasis(
    new THREE.Vector3(-1, 0, 0).applyQuaternion(uegsRotation),
  );
  const spzAxisY = new THREE.Vector3()
    .crossVectors(spzAxisZ, spzAxisX)
    .normalize();
  const orthonormalAxisZ = new THREE.Vector3()
    .crossVectors(spzAxisX, spzAxisY)
    .normalize();
  return quaternionFromAxes(spzAxisX, spzAxisY, orthonormalAxisZ);
}

function convertUegsExtentToSpzBasis(value: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    Math.abs(value.y),
    Math.abs(value.z),
    Math.abs(value.x),
  );
}

function createEmptyScalarStats(): UegsChannelStats {
  return {
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    mean: 0,
    nonZeroCount: 0,
    defaultOneCount: 0,
  };
}

function updateScalarStats(stats: UegsChannelStats, value: number) {
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
  stats.mean += value;
  if (Math.abs(value) > 1.0e-6) {
    stats.nonZeroCount += 1;
  }
  if (Math.abs(value - 1.0) <= 1.0e-6) {
    stats.defaultOneCount += 1;
  }
}

function finalizeScalarStats(stats: UegsChannelStats, count: number) {
  if (count <= 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      nonZeroCount: 0,
      defaultOneCount: 0,
    };
  }
  return {
    min: Number.isFinite(stats.min) ? stats.min : 0,
    max: Number.isFinite(stats.max) ? stats.max : 0,
    mean: stats.mean / count,
    nonZeroCount: stats.nonZeroCount,
    defaultOneCount: stats.defaultOneCount,
  };
}

function basenameFromPath(path?: string): string | undefined {
  if (!path) {
    return undefined;
  }
  const withoutSuffix = path.split(/[?#]/, 1)[0];
  const normalized = withoutSuffix.split("\\").join("/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function siblingUrl(url: string, fileName: string): string {
  try {
    return new URL(fileName, url).toString();
  } catch {
    const browserBase =
      typeof window !== "undefined" && window.location
        ? window.location.href
        : "http://localhost/";
    return new URL(fileName, new URL(url, browserBase)).toString();
  }
}

function isNotFoundStatus(status: number) {
  return status === 404 || status === 410;
}

async function fetchMaybe(
  url: string,
  requestInit: RequestInit,
): Promise<Response | undefined> {
  const response = await fetch(new Request(url, requestInit));
  if (isNotFoundStatus(response.status)) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `${response.status} "${response.statusText}" fetching URL: ${url}`,
    );
  }
  return response;
}

function makeFloatTextureArray(
  data: Float32Array,
  width: number,
  height: number,
  depth: number,
) {
  const texture = new THREE.DataArrayTexture(data, width, height, depth);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.FloatType;
  texture.internalFormat = "RGBA32F";
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function makeFloatTexture2D(data: Float32Array, width: number, height: number) {
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.internalFormat = "RGBA32F";
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function parseUegsManifest(json: string | JsonRecord): UegsManifest {
  const root =
    typeof json === "string"
      ? assertObject(JSON.parse(json), "UEGS manifest")
      : json;
  if (root.tool !== "UEGS") {
    throw new Error(
      `Invalid UEGS manifest: expected tool=UEGS, got ${String(root.tool)}`,
    );
  }
  return root as UegsManifest;
}

export function parseUegsComparisonViewpoint(
  manifest: UegsManifest | null | undefined,
): UegsComparisonViewpoint | null {
  const viewpoint = manifest?.comparison_viewpoint;
  if (!viewpoint) {
    return null;
  }

  const rawPosition = new THREE.Vector3(
    Number(viewpoint.position_x_cm),
    Number(viewpoint.position_y_cm),
    Number(viewpoint.position_z_cm),
  );
  const rawQuaternion = new THREE.Quaternion(
    Number(viewpoint.quaternion_x),
    Number(viewpoint.quaternion_y),
    Number(viewpoint.quaternion_z),
    Number(viewpoint.quaternion_w),
  );
  const hasFinitePose =
    Number.isFinite(rawPosition.x) &&
    Number.isFinite(rawPosition.y) &&
    Number.isFinite(rawPosition.z) &&
    Number.isFinite(rawQuaternion.x) &&
    Number.isFinite(rawQuaternion.y) &&
    Number.isFinite(rawQuaternion.z) &&
    Number.isFinite(rawQuaternion.w);
  if (!hasFinitePose) {
    return null;
  }

  const position = convertUegsPositionToSpzBasis(rawPosition);
  const quaternion = convertUegsQuaternionToSpzBasis(rawQuaternion);
  return {
    source: typeof viewpoint.source === "string" ? viewpoint.source : undefined,
    positionX: position.x,
    positionY: position.y,
    positionZ: position.z,
    quaternionX: quaternion.x,
    quaternionY: quaternion.y,
    quaternionZ: quaternion.z,
    quaternionW: quaternion.w,
    verticalFovDegrees: Number(viewpoint.vertical_fov_degrees),
    sparkOpenCv:
      viewpoint.spark_open_cv == null ? null : Boolean(viewpoint.spark_open_cv),
  };
}

export function scaleUegsComparisonViewpointToSceneBounds(
  comparisonViewpoint: UegsComparisonViewpoint | null | undefined,
  manifest: UegsManifest | null | undefined,
  sceneBounds: THREE.Box3 | null | undefined,
): UegsComparisonViewpoint | null {
  if (!comparisonViewpoint) {
    return null;
  }
  const manifestBounds = manifest?.bounds;
  if (!manifestBounds || !sceneBounds || sceneBounds.isEmpty()) {
    return comparisonViewpoint;
  }

  const rawManifestOrigin = new THREE.Vector3(
    Number(manifestBounds.origin_x_cm),
    Number(manifestBounds.origin_y_cm),
    Number(manifestBounds.origin_z_cm),
  );
  const rawManifestExtent = new THREE.Vector3(
    Number(manifestBounds.extent_x_cm),
    Number(manifestBounds.extent_y_cm),
    Number(manifestBounds.extent_z_cm),
  );
  const hasFiniteBounds =
    Number.isFinite(rawManifestOrigin.x) &&
    Number.isFinite(rawManifestOrigin.y) &&
    Number.isFinite(rawManifestOrigin.z) &&
    Number.isFinite(rawManifestExtent.x) &&
    Number.isFinite(rawManifestExtent.y) &&
    Number.isFinite(rawManifestExtent.z);
  if (!hasFiniteBounds) {
    return comparisonViewpoint;
  }

  const manifestOrigin = convertUegsPositionToSpzBasis(rawManifestOrigin);
  const manifestExtent = convertUegsExtentToSpzBasis(rawManifestExtent);
  const sceneExtent = sceneBounds
    .getSize(new THREE.Vector3())
    .multiplyScalar(0.5);
  const candidateRatios = [sceneExtent.x, sceneExtent.y, sceneExtent.z]
    .map((value, index) => {
      const denominator = manifestExtent.getComponent(index);
      return denominator > 1.0e-6 ? value / denominator : Number.NaN;
    })
    .filter((value) => Number.isFinite(value) && value > 1.0e-6);
  if (candidateRatios.length === 0) {
    return comparisonViewpoint;
  }

  const positionScale = Math.max(...candidateRatios);
  const scaledPosition = new THREE.Vector3(
    comparisonViewpoint.positionX,
    comparisonViewpoint.positionY,
    comparisonViewpoint.positionZ,
  )
    .sub(manifestOrigin)
    .multiplyScalar(positionScale)
    .add(manifestOrigin);

  return {
    ...comparisonViewpoint,
    positionX: scaledPosition.x,
    positionY: scaledPosition.y,
    positionZ: scaledPosition.z,
  };
}

export function parseUegsSceneLightingContract(
  json: string | JsonRecord,
): UegsSceneLightingContract {
  const root =
    typeof json === "string"
      ? assertObject(JSON.parse(json), "UEGS scene lighting contract")
      : json;
  if (root.contract !== "uegs_explorable_scene_lighting_v1") {
    throw new Error(
      `Unsupported UEGS scene lighting contract: ${String(root.contract)}`,
    );
  }

  const directionalLights = Array.isArray(root.directional_lights)
    ? root.directional_lights.map((value, index) => {
        const light = assertObject(value, `directional_lights[${index}]`);
        return {
          direction: convertUegsDirectionToSpzBasis(
            new THREE.Vector3(
              assertNumber(
                light.direction_x,
                `directional_lights[${index}].direction_x`,
              ),
              assertNumber(
                light.direction_y,
                `directional_lights[${index}].direction_y`,
              ),
              assertNumber(
                light.direction_z,
                `directional_lights[${index}].direction_z`,
              ),
            ),
          ).normalize(),
          color: new THREE.Color(
            assertNumber(light.color_r, `directional_lights[${index}].color_r`),
            assertNumber(light.color_g, `directional_lights[${index}].color_g`),
            assertNumber(light.color_b, `directional_lights[${index}].color_b`),
          ),
          intensity: assertNumber(
            light.intensity,
            `directional_lights[${index}].intensity`,
          ),
          castsShadows: Boolean(light.casts_shadows),
        };
      })
    : [];

  const localLights = Array.isArray(root.local_lights)
    ? root.local_lights.map((value, index) => {
        const light = assertObject(value, `local_lights[${index}]`);
        const type = assertString(light.type, `local_lights[${index}].type`);
        return {
          type: type === "spot" ? "spot" : "point",
          position: convertUegsPositionToSpzBasis(
            new THREE.Vector3(
              assertNumber(
                light.position_x,
                `local_lights[${index}].position_x`,
              ),
              assertNumber(
                light.position_y,
                `local_lights[${index}].position_y`,
              ),
              assertNumber(
                light.position_z,
                `local_lights[${index}].position_z`,
              ),
            ),
          ),
          direction: convertUegsDirectionToSpzBasis(
            new THREE.Vector3(
              assertNumber(
                light.direction_x,
                `local_lights[${index}].direction_x`,
              ),
              assertNumber(
                light.direction_y,
                `local_lights[${index}].direction_y`,
              ),
              assertNumber(
                light.direction_z,
                `local_lights[${index}].direction_z`,
              ),
            ),
          ).normalize(),
          color: new THREE.Color(
            assertNumber(light.color_r, `local_lights[${index}].color_r`),
            assertNumber(light.color_g, `local_lights[${index}].color_g`),
            assertNumber(light.color_b, `local_lights[${index}].color_b`),
          ),
          intensity: assertNumber(
            light.intensity,
            `local_lights[${index}].intensity`,
          ),
          attenuationRadiusCm: assertNumber(
            light.attenuation_radius_cm,
            `local_lights[${index}].attenuation_radius_cm`,
          ),
          innerConeCos:
            typeof light.inner_cone_cos === "number" ? light.inner_cone_cos : 1,
          outerConeCos:
            typeof light.outer_cone_cos === "number" ? light.outer_cone_cos : 0,
          castsShadows: Boolean(light.casts_shadows),
        } satisfies UegsLocalLight;
      })
    : [];

  const skyLights = Array.isArray(root.sky_lights)
    ? root.sky_lights.map((value, index) => {
        const light = assertObject(value, `sky_lights[${index}]`);
        return {
          color: new THREE.Color(
            assertNumber(light.color_r, `sky_lights[${index}].color_r`),
            assertNumber(light.color_g, `sky_lights[${index}].color_g`),
            assertNumber(light.color_b, `sky_lights[${index}].color_b`),
          ),
          intensity: assertNumber(
            light.intensity,
            `sky_lights[${index}].intensity`,
          ),
          realTimeCapture: Boolean(light.real_time_capture),
        };
      })
    : [];

  return {
    contract: "uegs_explorable_scene_lighting_v1",
    linearSceneColor: Boolean(root.linear_scene_color),
    toneMappingApplied: Boolean(root.tone_mapping_applied),
    lensEffectsApplied: Boolean(root.lens_effects_applied),
    materialAmbientOcclusionExported: Boolean(
      root.material_ambient_occlusion_exported,
    ),
    geometryContactShadowApproximationExpected: Boolean(
      root.geometry_contact_shadow_approximation_expected,
    ),
    bakedGeometryShadowTransferExported: Boolean(
      root.baked_geometry_shadow_transfer_exported,
    ),
    intensityUnits: assertString(root.intensity_units, "intensity_units"),
    directionalLights,
    localLights,
    skyLights,
  };
}

export function parseUegsGaussianPayload(
  input: ArrayBuffer | Uint8Array,
): UegsGaussianPayload {
  const bytes = readBytes(input);
  if (bytes.byteLength < UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES) {
    throw new Error("UEGS payload is too small to contain the header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== UEGS_GAUSSIAN_PAYLOAD_MAGIC) {
    throw new Error(
      `Unsupported UEGS payload magic: expected 0x${UEGS_GAUSSIAN_PAYLOAD_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
    );
  }
  if (
    version < UEGS_GAUSSIAN_PAYLOAD_MIN_VERSION ||
    version > UEGS_GAUSSIAN_PAYLOAD_VERSION
  ) {
    throw new Error(
      `Unsupported UEGS payload version: expected ${UEGS_GAUSSIAN_PAYLOAD_MIN_VERSION}-${UEGS_GAUSSIAN_PAYLOAD_VERSION}, got ${version}`,
    );
  }

  const recordBytes =
    version >= 6
      ? UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V6
      : UEGS_GAUSSIAN_PAYLOAD_RECORD_BYTES_V5;

  const recordCount = view.getUint32(8, true);
  const expectedBytes =
    UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES + recordCount * recordBytes;
  if (bytes.byteLength < expectedBytes) {
    throw new Error(
      `UEGS payload is truncated: expected at least ${expectedBytes} bytes, got ${bytes.byteLength}`,
    );
  }

  const header: UegsPayloadHeader = {
    magic,
    version,
    recordCount,
    shDegree: view.getUint32(12, true),
    boundsOrigin: convertUegsPositionToSpzBasis(readVec3(view, 16)),
    boundsExtent: convertUegsExtentToSpzBasis(readVec3(view, 28)),
    opaqueCount: view.getUint32(40, true),
    maskedCount: view.getUint32(44, true),
    translucentCount: view.getUint32(48, true),
    materialTruthSource: view.getUint8(52) as UegsPayloadMaterialTruthSource,
    colorSemantic: view.getUint8(53) as UegsPayloadColorSemantic,
    appearanceEncoding: view.getUint8(54) as UegsPayloadAppearanceEncoding,
    reserved0: view.getUint8(55),
  };

  const textureSize = getTextureSize(recordCount);
  const normalRoughness = new Float32Array(textureSize.maxSplats * 4);
  const baseMetallic = new Float32Array(textureSize.maxSplats * 4);
  const emissiveAmbientOcclusion = new Float32Array(textureSize.maxSplats * 4);
  const bakedShadowOpacity = new Float32Array(textureSize.maxSplats * 4);
  const exactCenters = new Float32Array(textureSize.maxSplats * 4);
  const exactScales = new Float32Array(textureSize.maxSplats * 4);
  const exactQuaternions = new Float32Array(textureSize.maxSplats * 4);

  const baseMin = new THREE.Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const baseMax = new THREE.Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  const emissiveMin = new THREE.Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const emissiveMax = new THREE.Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  const roughnessStats = createEmptyScalarStats();
  const metallicStats = createEmptyScalarStats();
  const ambientOcclusionStats = createEmptyScalarStats();
  const bakedShadowStats = createEmptyScalarStats();
  const opacityStats = createEmptyScalarStats();
  const normalLengthStats = createEmptyScalarStats();

  let offset = UEGS_GAUSSIAN_PAYLOAD_HEADER_BYTES;
  for (let index = 0; index < recordCount; index += 1) {
    const position = convertUegsPositionToSpzBasis(readVec3(view, offset));
    offset += 12; // Position
    const normal = convertUegsDirectionToSpzBasis(
      new THREE.Vector3(
        readFloat32(view, offset),
        readFloat32(view, offset + 4),
        readFloat32(view, offset + 8),
      ),
    );
    offset += 12; // Normal
    const rotation = convertUegsQuaternionToSpzBasis(
      new THREE.Quaternion(
        readFloat32(view, offset),
        readFloat32(view, offset + 4),
        readFloat32(view, offset + 8),
        readFloat32(view, offset + 12),
      ),
    );
    offset += 16; // Rotation
    const scale = convertUegsExtentToSpzBasis(
      new THREE.Vector3(
        Math.exp(readFloat32(view, offset)),
        Math.exp(readFloat32(view, offset + 4)),
        Math.exp(readFloat32(view, offset + 8)),
      ),
    );
    offset += 12; // Log scale
    offset += 12; // Covariance diagonal
    offset += 12; // Covariance off diagonal
    const baseR = readFloat32(view, offset);
    const baseG = readFloat32(view, offset + 4);
    const baseB = readFloat32(view, offset + 8);
    offset += 12;
    const emissiveR = readFloat32(view, offset);
    const emissiveG = readFloat32(view, offset + 4);
    const emissiveB = readFloat32(view, offset + 8);
    offset += 12;
    const opacity = readFloat32(view, offset);
    offset += 4;
    offset += 12; // SH dc
    const metallic = readFloat32(view, offset);
    offset += 4;
    offset += 36; // SH first order
    const roughness = readFloat32(view, offset);
    offset += 4;
    const ambientOcclusion = readFloat32(view, offset);
    offset += 4;
    const bakedShadow = version >= 6 ? readFloat32(view, offset) : 1.0;
    if (version >= 6) {
      offset += 4;
    }
    const alphaMode = view.getUint8(offset);
    const materialTruthSource = view.getUint8(offset + 1);
    offset += 4;

    const dest = index * 4;
    exactCenters[dest + 0] = position.x;
    exactCenters[dest + 1] = position.y;
    exactCenters[dest + 2] = position.z;
    exactCenters[dest + 3] = 1.0;

    exactScales[dest + 0] = scale.x;
    exactScales[dest + 1] = scale.y;
    exactScales[dest + 2] = scale.z;
    exactScales[dest + 3] = 0.0;

    exactQuaternions[dest + 0] = rotation.x;
    exactQuaternions[dest + 1] = rotation.y;
    exactQuaternions[dest + 2] = rotation.z;
    exactQuaternions[dest + 3] = rotation.w;

    normalRoughness[dest + 0] = normal.x;
    normalRoughness[dest + 1] = normal.y;
    normalRoughness[dest + 2] = normal.z;
    normalRoughness[dest + 3] = roughness;

    baseMetallic[dest + 0] = baseR;
    baseMetallic[dest + 1] = baseG;
    baseMetallic[dest + 2] = baseB;
    baseMetallic[dest + 3] = metallic;

    emissiveAmbientOcclusion[dest + 0] = emissiveR;
    emissiveAmbientOcclusion[dest + 1] = emissiveG;
    emissiveAmbientOcclusion[dest + 2] = emissiveB;
    emissiveAmbientOcclusion[dest + 3] = ambientOcclusion;

    bakedShadowOpacity[dest + 0] = bakedShadow;
    bakedShadowOpacity[dest + 1] = opacity;
    bakedShadowOpacity[dest + 2] = alphaMode;
    bakedShadowOpacity[dest + 3] = materialTruthSource;

    baseMin.min(new THREE.Vector3(baseR, baseG, baseB));
    baseMax.max(new THREE.Vector3(baseR, baseG, baseB));
    emissiveMin.min(new THREE.Vector3(emissiveR, emissiveG, emissiveB));
    emissiveMax.max(new THREE.Vector3(emissiveR, emissiveG, emissiveB));
    updateScalarStats(roughnessStats, roughness);
    updateScalarStats(metallicStats, metallic);
    updateScalarStats(ambientOcclusionStats, ambientOcclusion);
    updateScalarStats(bakedShadowStats, bakedShadow);
    updateScalarStats(opacityStats, opacity);
    updateScalarStats(normalLengthStats, normal.length());
  }

  const telemetry: UegsPayloadTelemetry = {
    recordCount,
    header: {
      appearanceEncoding: header.appearanceEncoding,
      materialTruthSource: header.materialTruthSource,
      colorSemantic: header.colorSemantic,
    },
    baseColor: {
      min: Number.isFinite(baseMin.x) ? baseMin : new THREE.Vector3(),
      max: Number.isFinite(baseMax.x) ? baseMax : new THREE.Vector3(),
    },
    emissive: {
      min: Number.isFinite(emissiveMin.x) ? emissiveMin : new THREE.Vector3(),
      max: Number.isFinite(emissiveMax.x) ? emissiveMax : new THREE.Vector3(),
    },
    roughness: finalizeScalarStats(roughnessStats, recordCount),
    metallic: finalizeScalarStats(metallicStats, recordCount),
    ambientOcclusion: finalizeScalarStats(ambientOcclusionStats, recordCount),
    bakedShadow: finalizeScalarStats(bakedShadowStats, recordCount),
    opacity: finalizeScalarStats(opacityStats, recordCount),
    normalLength: finalizeScalarStats(normalLengthStats, recordCount),
  };

  return {
    header,
    textureSize,
    normalRoughness,
    baseMetallic,
    emissiveAmbientOcclusion,
    bakedShadowOpacity,
    exactGeometry: {
      centers: exactCenters,
      scales: exactScales,
      quaternions: exactQuaternions,
      source: "payload",
    },
    telemetry,
  };
}

export function parseUegsDebugCaptureSidecar(
  input: ArrayBuffer | Uint8Array,
): UegsDebugCaptureSidecar {
  const bytes = readBytes(input);
  if (bytes.byteLength < UEGS_DEBUG_CAPTURE_HEADER_BYTES) {
    throw new Error("UEGS debug capture sidecar is too small");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== UEGS_DEBUG_CAPTURE_MAGIC) {
    throw new Error(
      `Unsupported UEGS debug capture magic: expected 0x${UEGS_DEBUG_CAPTURE_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
    );
  }
  if (version !== UEGS_DEBUG_CAPTURE_VERSION) {
    throw new Error(
      `Unsupported UEGS debug capture version: expected ${UEGS_DEBUG_CAPTURE_VERSION}, got ${version}`,
    );
  }

  const recordCount = view.getUint32(8, true);
  const headerBytes = view.getUint32(12, true);
  const recordBytes = view.getUint32(16, true);
  if (headerBytes !== UEGS_DEBUG_CAPTURE_HEADER_BYTES) {
    throw new Error(
      `Unsupported UEGS debug capture header size: expected ${UEGS_DEBUG_CAPTURE_HEADER_BYTES}, got ${headerBytes}`,
    );
  }
  if (recordBytes !== UEGS_DEBUG_CAPTURE_RECORD_BYTES) {
    throw new Error(
      `Unsupported UEGS debug capture record size: expected ${UEGS_DEBUG_CAPTURE_RECORD_BYTES}, got ${recordBytes}`,
    );
  }

  const expectedBytes = headerBytes + recordCount * recordBytes;
  if (bytes.byteLength < expectedBytes) {
    throw new Error(
      `UEGS debug capture sidecar is truncated: expected at least ${expectedBytes} bytes, got ${bytes.byteLength}`,
    );
  }

  const textureSize = getTextureSize(recordCount);
  const sceneColor = new Float32Array(textureSize.maxSplats * 4);
  const targetBaseColor = new Float32Array(textureSize.maxSplats * 4);
  const targetNormal = new Float32Array(textureSize.maxSplats * 4);
  const sceneNormal = new Float32Array(textureSize.maxSplats * 4);
  const directShadowed = new Float32Array(textureSize.maxSplats * 4);
  const directUnshadowed = new Float32Array(textureSize.maxSplats * 4);

  const applyDebugCaptureMask = (
    values: Float32Array,
    dest: number,
    hasChannel: boolean,
  ) => {
    if (!hasChannel) {
      values[dest + 0] = 0;
      values[dest + 1] = 0;
      values[dest + 2] = 0;
      values[dest + 3] = 0;
      return;
    }
    values[dest + 3] = 1;
  };

  let sceneColorCount = 0;
  let targetBaseColorCount = 0;
  let targetNormalCount = 0;
  let sceneNormalCount = 0;
  let directShadowedCount = 0;
  let directUnshadowedCount = 0;

  let offset = headerBytes;
  for (let index = 0; index < recordCount; index += 1) {
    const dest = index * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      sceneColor[dest + channel] = readFloat32(view, offset + channel * 4);
    }
    offset += 16;
    for (let channel = 0; channel < 4; channel += 1) {
      targetBaseColor[dest + channel] = readFloat32(view, offset + channel * 4);
    }
    offset += 16;
    for (let channel = 0; channel < 4; channel += 1) {
      targetNormal[dest + channel] = readFloat32(view, offset + channel * 4);
    }
    offset += 16;
    for (let channel = 0; channel < 4; channel += 1) {
      sceneNormal[dest + channel] = readFloat32(view, offset + channel * 4);
    }
    offset += 16;
    for (let channel = 0; channel < 4; channel += 1) {
      directShadowed[dest + channel] = readFloat32(view, offset + channel * 4);
    }
    offset += 16;
    for (let channel = 0; channel < 4; channel += 1) {
      directUnshadowed[dest + channel] = readFloat32(
        view,
        offset + channel * 4,
      );
    }
    offset += 16;
    const flags = view.getUint32(offset, true);
    offset += 4;
    offset += 1; // scene sample result
    offset += 1; // shadow sample result
    offset += 2; // reserved

    const hasSceneColor = (flags & UEGS_DEBUG_CAPTURE_HAS_SCENE_COLOR) !== 0;
    const hasTargetBaseColor =
      (flags & UEGS_DEBUG_CAPTURE_HAS_TARGET_BASE_COLOR) !== 0;
    const hasTargetNormal =
      (flags & UEGS_DEBUG_CAPTURE_HAS_TARGET_NORMAL) !== 0;
    const hasSceneNormal = (flags & UEGS_DEBUG_CAPTURE_HAS_SCENE_NORMAL) !== 0;
    const hasDirectShadowed =
      (flags & UEGS_DEBUG_CAPTURE_HAS_DIRECT_SHADOWED) !== 0;
    const hasDirectUnshadowed =
      (flags & UEGS_DEBUG_CAPTURE_HAS_DIRECT_UNSHADOWED) !== 0;

    applyDebugCaptureMask(sceneColor, dest, hasSceneColor);
    applyDebugCaptureMask(targetBaseColor, dest, hasTargetBaseColor);
    applyDebugCaptureMask(targetNormal, dest, hasTargetNormal);
    applyDebugCaptureMask(sceneNormal, dest, hasSceneNormal);
    applyDebugCaptureMask(directShadowed, dest, hasDirectShadowed);
    applyDebugCaptureMask(directUnshadowed, dest, hasDirectUnshadowed);

    if (hasSceneColor) {
      sceneColorCount += 1;
    }
    if (hasTargetBaseColor) {
      targetBaseColorCount += 1;
    }
    if (hasTargetNormal) {
      targetNormalCount += 1;
    }
    if (hasSceneNormal) {
      sceneNormalCount += 1;
    }
    if (hasDirectShadowed) {
      directShadowedCount += 1;
    }
    if (hasDirectUnshadowed) {
      directUnshadowedCount += 1;
    }
  }

  return {
    recordCount,
    textureSize,
    sceneColor,
    targetBaseColor,
    targetNormal,
    sceneNormal,
    directShadowed,
    directUnshadowed,
    telemetry: {
      recordCount,
      sceneColorCount,
      targetBaseColorCount,
      targetNormalCount,
      sceneNormalCount,
      directShadowedCount,
      directUnshadowedCount,
    },
  };
}

export function summarizeUegsBundle(bundle: UegsBundle) {
  const skyRadiance = bundle.sceneLighting.skyLights.reduce(
    (sum, light) =>
      sum.add(
        new THREE.Vector3(
          light.color.r * light.intensity,
          light.color.g * light.intensity,
          light.color.b * light.intensity,
        ),
      ),
    new THREE.Vector3(),
  );
  return {
    appearanceEncoding: bundle.payload.header.appearanceEncoding,
    recordCount: bundle.payload.header.recordCount,
    directionalLightCount: bundle.sceneLighting.directionalLights.length,
    localLightCount: bundle.sceneLighting.localLights.length,
    skyLightCount: bundle.sceneLighting.skyLights.length,
    bakedGeometryShadowTransferExported:
      bundle.sceneLighting.bakedGeometryShadowTransferExported,
    toneMappingApplied: bundle.sceneLighting.toneMappingApplied,
    lensEffectsApplied: bundle.sceneLighting.lensEffectsApplied,
    geometryContactShadowApproximationExpected:
      bundle.sceneLighting.geometryContactShadowApproximationExpected,
    skyRadiance,
    payloadTelemetry: bundle.payload.telemetry,
    debugCaptureTelemetry: bundle.debugCapture?.telemetry ?? null,
  };
}

export async function loadOptionalUegsBundleFromUrl(
  spzUrl: string,
  requestInit: RequestInit = {},
): Promise<UegsBundle | undefined> {
  const fileName = basenameFromPath(spzUrl);
  if (!fileName?.toLowerCase().endsWith(".spz")) {
    return undefined;
  }

  const manifestResponse = await fetchMaybe(
    siblingUrl(spzUrl, "uegs_manifest.json"),
    requestInit,
  );
  if (!manifestResponse) {
    return undefined;
  }

  const manifest = parseUegsManifest(await manifestResponse.text());
  const appearanceEncoding = (
    manifest.payload_contract?.appearance_encoding ?? ""
  ).toLowerCase();
  const declaresExplorableBundle =
    appearanceEncoding === "explorable_scene_relight" ||
    appearanceEncoding === "explorable_scene_relight_baked_shadows";
  const declaresSidecarBundle =
    manifest.gaussian_payload_sidecar != null ||
    manifest.scene_lighting_contract != null;
  if (!declaresExplorableBundle && !declaresSidecarBundle) {
    return undefined;
  }

  const payloadFileName =
    basenameFromPath(manifest.gaussian_payload_sidecar?.path) ??
    "uegs_gaussians_payload.bin";
  const sceneLightingFileName =
    basenameFromPath(manifest.scene_lighting_contract?.path) ??
    "uegs_scene_lighting.json";
  const debugCaptureFileName = basenameFromPath(
    manifest.gaussian_debug_capture_sidecar?.path,
  );

  const [payloadResponse, sceneLightingResponse, debugCaptureResponse] =
    await Promise.all([
      fetchMaybe(siblingUrl(spzUrl, payloadFileName), requestInit),
      fetchMaybe(siblingUrl(spzUrl, sceneLightingFileName), requestInit),
      debugCaptureFileName
        ? fetchMaybe(siblingUrl(spzUrl, debugCaptureFileName), requestInit)
        : Promise.resolve(undefined),
    ]);

  if (!payloadResponse) {
    throw new Error(
      `UEGS bundle manifest was found for ${spzUrl}, but ${payloadFileName} is missing`,
    );
  }
  if (!sceneLightingResponse) {
    throw new Error(
      `UEGS bundle manifest was found for ${spzUrl}, but ${sceneLightingFileName} is missing`,
    );
  }
  if (debugCaptureFileName && !debugCaptureResponse) {
    throw new Error(
      `UEGS bundle manifest was found for ${spzUrl}, but ${debugCaptureFileName} is missing`,
    );
  }

  const [payloadBytes, sceneLightingJson, debugCaptureBytes] =
    await Promise.all([
      payloadResponse.arrayBuffer(),
      sceneLightingResponse.text(),
      debugCaptureResponse?.arrayBuffer() ?? Promise.resolve(undefined),
    ]);

  return {
    manifest,
    payload: parseUegsGaussianPayload(payloadBytes),
    sceneLighting: parseUegsSceneLightingContract(sceneLightingJson),
    debugCapture: debugCaptureBytes
      ? parseUegsDebugCaptureSidecar(debugCaptureBytes)
      : undefined,
  };
}

export function attachUegsBundle(
  packedSplats: PackedSplats,
  bundle: UegsBundle,
): void {
  if (bundle.payload.header.recordCount !== packedSplats.numSplats) {
    throw new Error(
      `UEGS bundle record count ${bundle.payload.header.recordCount} does not match SPZ splat count ${packedSplats.numSplats}`,
    );
  }
  if (
    bundle.debugCapture &&
    bundle.debugCapture.recordCount !== packedSplats.numSplats
  ) {
    throw new Error(
      `UEGS debug capture record count ${bundle.debugCapture.recordCount} does not match SPZ splat count ${packedSplats.numSplats}`,
    );
  }
  (packedSplats.extra as UegsExtra).uegsBundle = bundle;
}

function getUegsBundle(packedSplats: PackedSplats) {
  return (packedSplats.extra as UegsExtra).uegsBundle;
}

function resolveUegsBundle(
  source: UegsBundle | PackedSplats | SplatMesh | undefined,
): UegsBundle | undefined {
  if (!source) {
    return undefined;
  }

  if ("payload" in source && "sceneLighting" in source) {
    return source;
  }

  if ("packedSplats" in source) {
    return getUegsBundle(source.packedSplats);
  }

  return getUegsBundle(source);
}

function resolveUegsExtra(
  source: UegsBundle | PackedSplats | SplatMesh | undefined,
): UegsExtra | undefined {
  if (!source) {
    return undefined;
  }
  if ("packedSplats" in source) {
    return source.packedSplats.extra as UegsExtra | undefined;
  }
  if ("extra" in source) {
    return source.extra as UegsExtra | undefined;
  }
  return undefined;
}

function isExplorableSceneParityEncoding(
  appearanceEncoding: UegsPayloadAppearanceEncoding,
) {
  return (
    appearanceEncoding ===
      UegsPayloadAppearanceEncoding.ExplorableSceneRelight ||
    appearanceEncoding ===
      UegsPayloadAppearanceEncoding.ExplorableSceneRelightBakedShadows
  );
}

function bundleUsesOpaqueSurfaceShell(bundle: UegsBundle | undefined): boolean {
  if (!bundle) {
    return false;
  }

  const { header } = bundle.payload;
  return (
    isExplorableSceneParityEncoding(header.appearanceEncoding) &&
    header.recordCount > 0 &&
    header.opaqueCount === header.recordCount &&
    header.maskedCount === 0 &&
    header.translucentCount === 0
  );
}

export function getUegsSparkViewContract(
  source: UegsBundle | PackedSplats | SplatMesh | undefined,
): UegsSparkViewContract | undefined {
  const bundle = resolveUegsBundle(source);
  if (!bundleUsesOpaqueSurfaceShell(bundle)) {
    return undefined;
  }

  return {
    sortRadial: false,
    sort32: true,
    stochastic: false,
    sort360: false,
    depthBias: 0.0,
    reason:
      "UEGS explorable scene-parity bundles should follow the canonical UEGS runtime more closely than Spark's shell heuristic. Prefer stable 32-bit depth ordering without stochastic depth writes so the full 3D Gaussian ellipsoid projects accumulate like the UEGS renderer instead of turning into dot-noise shell ownership.",
  };
}

export function getUegsSparkRenderContract(
  source: UegsBundle | PackedSplats | SplatMesh | undefined,
): UegsSparkRenderContract | undefined {
  const bundle = resolveUegsBundle(source);
  if (!bundleUsesOpaqueSurfaceShell(bundle)) {
    return undefined;
  }

  const contract = {
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
  };
  const override = resolveUegsExtra(source)?.uegsRenderContractOverride;
  return override
    ? {
        ...contract,
        ...override,
      }
    : contract;
}

export function alignUegsNormalToShellHemisphere(
  normal: THREE.Vector3,
  shellNormal: THREE.Vector3,
): THREE.Vector3 {
  const aligned = normal.clone();
  if (aligned.lengthSq() <= 1.0e-8) {
    return shellNormal.clone().normalize();
  }
  aligned.normalize();
  const reference = shellNormal.clone();
  if (reference.lengthSq() <= 1.0e-8) {
    return aligned;
  }
  reference.normalize();
  return aligned.dot(reference) < 0.0 ? aligned.negate() : aligned;
}

export function applyUegsSparkViewContract(
  viewpoint: {
    sortRadial: boolean;
    sort32?: boolean;
    stochastic: boolean;
    sort360?: boolean;
    depthBias?: number;
  },
  source: UegsBundle | PackedSplats | SplatMesh | undefined,
): UegsSparkViewContract | undefined {
  const contract = getUegsSparkViewContract(source);
  if (!contract) {
    return undefined;
  }

  viewpoint.sortRadial = contract.sortRadial;
  viewpoint.sort32 = contract.sort32;
  viewpoint.stochastic = contract.stochastic;
  viewpoint.sort360 = contract.sort360;
  viewpoint.depthBias = contract.depthBias;
  return contract;
}

function bundleExportsBakedShadowTransfer(
  bundle: UegsBundle | undefined,
): boolean {
  return Boolean(
    bundle &&
      bundle.payload.header.appearanceEncoding ===
        UegsPayloadAppearanceEncoding.ExplorableSceneRelightBakedShadows &&
      bundle.sceneLighting.bakedGeometryShadowTransferExported,
  );
}

function resolveUegsRenderContract(
  bundle: UegsBundle | undefined,
  extra: UegsExtra | undefined,
): UegsSparkRenderContract | undefined {
  const base = getUegsSparkRenderContract(bundle);
  if (!base) {
    return undefined;
  }
  const override = extra?.uegsRenderContractOverride;
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
  };
}

export function inspectUegsRuntimeTelemetry(
  mesh: SplatMesh,
): UegsRuntimeTelemetry {
  const extra = mesh.packedSplats.extra as UegsExtra;
  const bundle = getUegsBundle(mesh.packedSplats);
  const resources = ensureUegsGpuResources(mesh.packedSplats);
  const {
    selectedGeometrySource,
    payloadExactGeometry,
    spzExactGeometry,
    renderExactGeometry,
  } = resolveUegsExactGeometrySources(bundle, extra);

  return {
    hasBundle: Boolean(bundle),
    autoConfigured: Boolean(extra.uegsAutoConfigured),
    modifierConfigured: Boolean(mesh.uegsModifier),
    gpuResourcesCreated: Boolean(resources),
    exactGeometryAvailable: Boolean(renderExactGeometry),
    exactGeometrySource: selectedGeometrySource,
    enableViewToWorld: Boolean(mesh.enableViewToWorld),
    maxSh: typeof mesh.maxSh === "number" ? mesh.maxSh : null,
    appearanceEncoding: bundle?.payload.header.appearanceEncoding ?? null,
    directionalLightCount: bundle?.sceneLighting.directionalLights.length ?? 0,
    localLightCount: bundle?.sceneLighting.localLights.length ?? 0,
    skyLightCount: bundle?.sceneLighting.skyLights.length ?? 0,
    bakedShadowTransferAvailable: bundleExportsBakedShadowTransfer(bundle),
    recommendedViewContract: getUegsSparkViewContract(bundle) ?? null,
    recommendedRenderContract: getUegsSparkRenderContract(bundle) ?? null,
    runtimeUniforms: {
      bakedShadowEnabled: resources?.bakedShadowEnabled.value ?? null,
      directLightingEnabled: resources?.directLightingEnabled.value ?? null,
      skyLightingEnabled: resources?.skyLightingEnabled.value ?? null,
      ambientOcclusionEnabled: resources?.ambientOcclusionEnabled.value ?? null,
      debugViewMode:
        (resources?.debugViewMode.value as UegsDebugViewMode | undefined) ??
        null,
    },
  };
}

function buildDirectionalLightTexture(contract: UegsSceneLightingContract) {
  const data = new Float32Array(
    Math.max(contract.directionalLights.length, 1) * 8,
  );
  contract.directionalLights
    .slice(0, MAX_DIRECTIONAL_LIGHTS)
    .forEach((light, index) => {
      const base = index * 8;
      data[base + 0] = light.direction.x;
      data[base + 1] = light.direction.y;
      data[base + 2] = light.direction.z;
      data[base + 3] = light.intensity;
      data[base + 4] = light.color.r;
      data[base + 5] = light.color.g;
      data[base + 6] = light.color.b;
      data[base + 7] = light.castsShadows ? 1 : 0;
    });
  return makeFloatTexture2D(
    data,
    2,
    Math.max(contract.directionalLights.length, 1),
  );
}

function buildLocalLightTexture(contract: UegsSceneLightingContract) {
  const data = new Float32Array(Math.max(contract.localLights.length, 1) * 16);
  contract.localLights.slice(0, MAX_LOCAL_LIGHTS).forEach((light, index) => {
    const base = index * 16;
    data[base + 0] = light.position.x;
    data[base + 1] = light.position.y;
    data[base + 2] = light.position.z;
    data[base + 3] = light.intensity;
    data[base + 4] = light.direction.x;
    data[base + 5] = light.direction.y;
    data[base + 6] = light.direction.z;
    data[base + 7] = light.attenuationRadiusCm;
    data[base + 8] = light.color.r;
    data[base + 9] = light.color.g;
    data[base + 10] = light.color.b;
    data[base + 11] = light.type === "spot" ? 1 : 0;
    data[base + 12] = light.innerConeCos;
    data[base + 13] = light.outerConeCos;
    data[base + 14] = light.castsShadows ? 1 : 0;
    data[base + 15] = 0;
  });
  return makeFloatTexture2D(data, 4, Math.max(contract.localLights.length, 1));
}

function buildExactGeometryTextureData(
  values: Float32Array | undefined,
  textureSize: UegsGaussianPayload["textureSize"],
) {
  const texelCount = textureSize.width * textureSize.height * textureSize.depth;
  const data = new Float32Array(texelCount * 4);
  if (values) {
    data.set(values.subarray(0, Math.min(values.length, data.length)));
  }
  return data;
}

function hasExactGeometryValues(
  values: Float32Array | undefined,
  recordCount: number,
) {
  return Boolean(values && values.length >= recordCount * 4);
}

function resolveUegsExactGeometrySources(
  bundle: UegsBundle | undefined,
  extra: UegsExtra,
) {
  if (!bundle) {
    return {
      selectedGeometrySource: null,
      payloadExactGeometry: undefined,
      spzExactGeometry: undefined,
      renderExactGeometry: undefined,
    };
  }

  const recordCount = bundle.payload.header.recordCount;
  const payloadExactGeometry =
    hasExactGeometryValues(bundle.payload.exactGeometry.centers, recordCount) &&
    hasExactGeometryValues(bundle.payload.exactGeometry.scales, recordCount) &&
    hasExactGeometryValues(
      bundle.payload.exactGeometry.quaternions,
      recordCount,
    )
      ? bundle.payload.exactGeometry
      : undefined;
  const spzExactGeometry =
    extra.spzExactGeometry &&
    hasExactGeometryValues(extra.spzExactGeometry.scales, recordCount) &&
    hasExactGeometryValues(extra.spzExactGeometry.quaternions, recordCount)
      ? extra.spzExactGeometry
      : undefined;
  const preference = extra.uegsRenderGeometryPreference ?? "hybrid";
  let renderExactGeometry: UegsRenderableExactSplatGeometry | undefined;
  let selectedGeometrySource:
    | UegsRenderableExactSplatGeometry["source"]
    | null = null;

  if (preference === "spz") {
    selectedGeometrySource = spzExactGeometry ? "spz" : null;
  } else if (preference === "payload") {
    renderExactGeometry = payloadExactGeometry;
    selectedGeometrySource = payloadExactGeometry?.source ?? null;
  } else {
    renderExactGeometry =
      payloadExactGeometry && spzExactGeometry
        ? {
            centers: payloadExactGeometry.centers,
            scales: spzExactGeometry.scales,
            quaternions: spzExactGeometry.quaternions,
            source: "hybrid" as const,
          }
        : payloadExactGeometry;
    selectedGeometrySource = renderExactGeometry?.source ?? null;
  }

  return {
    selectedGeometrySource,
    payloadExactGeometry,
    spzExactGeometry,
    renderExactGeometry,
  };
}

function ensureUegsGpuResources(
  packedSplats: PackedSplats,
): UegsGpuResources | undefined {
  const extra = packedSplats.extra as UegsExtra;
  const bundle = extra.uegsBundle;
  if (!bundle) {
    return undefined;
  }

  if (extra.uegsGpuResources) {
    return extra.uegsGpuResources;
  }

  const {
    textureSize,
    normalRoughness,
    baseMetallic,
    emissiveAmbientOcclusion,
    bakedShadowOpacity,
  } = bundle.payload;
  const debugCapture = bundle.debugCapture;
  const { renderExactGeometry } = resolveUegsExactGeometrySources(
    bundle,
    extra,
  );

  const normalRoughnessTexture = new DynoSampler2DArray({
    key: "uegsNormalRoughness",
    value: makeFloatTextureArray(
      normalRoughness,
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const baseMetallicTexture = new DynoSampler2DArray({
    key: "uegsBaseMetallic",
    value: makeFloatTextureArray(
      baseMetallic,
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const exactCenterTexture = new DynoSampler2DArray({
    key: "uegsExactCenter",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(renderExactGeometry?.centers, textureSize),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const exactScaleTexture = new DynoSampler2DArray({
    key: "uegsExactScale",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(renderExactGeometry?.scales, textureSize),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const exactQuaternionTexture = new DynoSampler2DArray({
    key: "uegsExactQuaternion",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(
        renderExactGeometry?.quaternions,
        textureSize,
      ),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const emissiveAmbientOcclusionTexture = new DynoSampler2DArray({
    key: "uegsEmissiveAmbientOcclusion",
    value: makeFloatTextureArray(
      emissiveAmbientOcclusion,
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const bakedShadowOpacityTexture = new DynoSampler2DArray({
    key: "uegsBakedShadowOpacity",
    value: makeFloatTextureArray(
      bakedShadowOpacity,
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const capturedSceneColorTexture = new DynoSampler2DArray({
    key: "uegsCapturedSceneColor",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(debugCapture?.sceneColor, textureSize),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const capturedTargetBaseColorTexture = new DynoSampler2DArray({
    key: "uegsCapturedTargetBaseColor",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(debugCapture?.targetBaseColor, textureSize),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const capturedTargetNormalTexture = new DynoSampler2DArray({
    key: "uegsCapturedTargetNormal",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(debugCapture?.targetNormal, textureSize),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const capturedSceneNormalTexture = new DynoSampler2DArray({
    key: "uegsCapturedSceneNormal",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(debugCapture?.sceneNormal, textureSize),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const capturedDirectShadowedTexture = new DynoSampler2DArray({
    key: "uegsCapturedDirectShadowed",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(debugCapture?.directShadowed, textureSize),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });
  const capturedDirectUnshadowedTexture = new DynoSampler2DArray({
    key: "uegsCapturedDirectUnshadowed",
    value: makeFloatTextureArray(
      buildExactGeometryTextureData(
        debugCapture?.directUnshadowed,
        textureSize,
      ),
      textureSize.width,
      textureSize.height,
      textureSize.depth,
    ),
  });

  const directionalLightsTexture = new DynoSampler2D({
    key: "uegsDirectionalLights",
    value: buildDirectionalLightTexture(bundle.sceneLighting),
  });
  const localLightsTexture = new DynoSampler2D({
    key: "uegsLocalLights",
    value: buildLocalLightTexture(bundle.sceneLighting),
  });
  const directionalLightCount = new DynoInt({
    key: "uegsDirectionalLightCount",
    value: Math.min(
      bundle.sceneLighting.directionalLights.length,
      MAX_DIRECTIONAL_LIGHTS,
    ),
  });
  const localLightCount = new DynoInt({
    key: "uegsLocalLightCount",
    value: Math.min(bundle.sceneLighting.localLights.length, MAX_LOCAL_LIGHTS),
  });
  const skyRadiance = bundle.sceneLighting.skyLights.reduce(
    (sum, light) =>
      sum.add(
        new THREE.Vector4(
          light.color.r * light.intensity,
          light.color.g * light.intensity,
          light.color.b * light.intensity,
          light.intensity,
        ),
      ),
    new THREE.Vector4(0, 0, 0, 0),
  );
  const skyRadianceDyno = new DynoVec4({
    key: "uegsSkyRadiance",
    value: skyRadiance,
  });
  const bakedShadowEnabled = new DynoBool({
    key: "uegsBakedShadowEnabled",
    value:
      bundle.payload.header.appearanceEncoding ===
        UegsPayloadAppearanceEncoding.ExplorableSceneRelightBakedShadows &&
      bundle.sceneLighting.bakedGeometryShadowTransferExported,
  });
  const directLightingEnabled = new DynoBool({
    key: "uegsDirectLightingEnabled",
    value: true,
  });
  const skyLightingEnabled = new DynoBool({
    key: "uegsSkyLightingEnabled",
    value: true,
  });
  const ambientOcclusionEnabled = new DynoBool({
    key: "uegsAmbientOcclusionEnabled",
    value: true,
  });
  const debugViewMode = new DynoInt({
    key: "uegsDebugViewMode",
    value: UegsDebugViewMode.Final,
  });
  const hasExactSplatGeometry = new DynoBool({
    key: "uegsHasExactSplatGeometry",
    value: Boolean(renderExactGeometry),
  });

  const resources = {
    normalRoughnessTexture,
    baseMetallicTexture,
    exactCenterTexture,
    exactScaleTexture,
    exactQuaternionTexture,
    emissiveAmbientOcclusionTexture,
    bakedShadowOpacityTexture,
    capturedSceneColorTexture,
    capturedTargetBaseColorTexture,
    capturedTargetNormalTexture,
    capturedSceneNormalTexture,
    capturedDirectShadowedTexture,
    capturedDirectUnshadowedTexture,
    directionalLightsTexture,
    directionalLightCount,
    localLightsTexture,
    localLightCount,
    skyRadiance: skyRadianceDyno,
    bakedShadowEnabled,
    directLightingEnabled,
    skyLightingEnabled,
    ambientOcclusionEnabled,
    debugViewMode,
    hasExactSplatGeometry,
  } satisfies UegsGpuResources;

  extra.uegsGpuResources = resources;
  return resources;
}

const defineUegsLighting = unindent(`
  const float UEGS_PI = 3.14159265359;
  const int UEGS_MAX_DIRECTIONAL_LIGHTS = ${MAX_DIRECTIONAL_LIGHTS};
  const int UEGS_MAX_LOCAL_LIGHTS = ${MAX_LOCAL_LIGHTS};

  vec3 uegsQuatVec(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  vec3 uegsFresnelSchlick(float cosTheta, vec3 f0) {
    return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  }

  vec3 uegsFresnelSchlickRoughness(float cosTheta, vec3 f0, float roughness) {
    return f0 + (max(vec3(1.0 - roughness), f0) - f0) *
      pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  }

  float uegsDistributionGGX(vec3 n, vec3 h, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float ndoth = max(dot(n, h), 0.0);
    float ndoth2 = ndoth * ndoth;
    float denom = ndoth2 * (a2 - 1.0) + 1.0;
    return a2 / max(UEGS_PI * denom * denom, 1.0e-4);
  }

  float uegsGeometrySchlickGGX(float ndotv, float roughness) {
    float r = roughness + 1.0;
    float k = (r * r) / 8.0;
    return ndotv / max(ndotv * (1.0 - k) + k, 1.0e-4);
  }

  float uegsGeometrySmith(vec3 n, vec3 v, vec3 l, float roughness) {
    float ndotv = max(dot(n, v), 0.0);
    float ndotl = max(dot(n, l), 0.0);
    return uegsGeometrySchlickGGX(ndotv, roughness) *
      uegsGeometrySchlickGGX(ndotl, roughness);
  }

  vec3 uegsEvaluateDirectPbr(
    vec3 baseColor,
    float metallic,
    float roughness,
    vec3 n,
    vec3 v,
    vec3 l,
    vec3 radiance
  ) {
    vec3 h = normalize(v + l);
    float ndotl = max(dot(n, l), 0.0);
    float ndotv = max(dot(n, v), 0.0);
    if (ndotl <= 1.0e-4 || ndotv <= 1.0e-4) {
      return vec3(0.0);
    }

    vec3 f0 = mix(vec3(0.04), baseColor, metallic);
    vec3 f = uegsFresnelSchlick(max(dot(h, v), 0.0), f0);
    float ndf = uegsDistributionGGX(n, h, roughness);
    float g = uegsGeometrySmith(n, v, l, roughness);
    vec3 specular = (ndf * g * f) / max(4.0 * ndotv * ndotl, 1.0e-4);
    vec3 ks = f;
    vec3 kd = (vec3(1.0) - ks) * (1.0 - metallic);
    return (kd * baseColor / UEGS_PI + specular) * radiance * ndotl;
  }

  vec3 uegsEvaluateSkyAmbient(
    vec3 baseColor,
    float metallic,
    float roughness,
    float ao,
    vec3 n,
    vec3 v,
    vec3 skyRadiance
  ) {
    vec3 f0 = mix(vec3(0.04), baseColor, metallic);
    vec3 f = uegsFresnelSchlickRoughness(max(dot(n, v), 0.0), f0, roughness);
    vec3 kd = (vec3(1.0) - f) * (1.0 - metallic);
    vec3 diffuse = kd * baseColor * skyRadiance;
    vec3 specular = f * skyRadiance * (0.25 + (1.0 - roughness) * 0.75);
    return (diffuse + specular) * ao;
  }

  float uegsLocalAttenuation(float distanceCm, float attenuationRadiusCm) {
    if (attenuationRadiusCm <= 1.0e-4) {
      return 0.0;
    }
    float falloff = clamp(1.0 - distanceCm / attenuationRadiusCm, 0.0, 1.0);
    return falloff * falloff;
  }

  float uegsSpotAttenuation(
    vec3 lightDirection,
    vec3 lightToPoint,
    float innerConeCos,
    float outerConeCos
  ) {
    float cosTheta = dot(lightDirection, lightToPoint);
    float denom = max(innerConeCos - outerConeCos, 1.0e-4);
    return clamp((cosTheta - outerConeCos) / denom, 0.0, 1.0);
  }
`);

function makeUegsModifier(mesh: SplatMesh): GsplatModifier | undefined {
  const bundle = getUegsBundle(mesh.packedSplats);
  if (!bundle) {
    return undefined;
  }
  const extra = mesh.packedSplats.extra as UegsExtra;

  const resources = ensureUegsGpuResources(mesh.packedSplats);
  if (!resources) {
    return undefined;
  }

  const renderContract = resolveUegsRenderContract(bundle, extra);
  const flattenMinAxisTo2D = Boolean(renderContract?.flattenMinAxisTo2D);
  const clampMinimumShellScale = renderContract?.clampMinimumShellScale ?? true;
  const cullBackfacingShellSplats = Boolean(
    renderContract?.cullBackfacingShellSplats,
  );
  const orientNormalsToShellHemisphere = Boolean(
    renderContract?.orientNormalsToShellHemisphere,
  );
  const flipNormalsToView = renderContract?.flipNormalsToView ?? true;
  const usePayloadOpacity = renderContract?.usePayloadOpacity ?? true;
  const useSerializedBaseColorForBaseView =
    renderContract?.useSerializedBaseColorForBaseView ?? false;
  const useSerializedSceneAppearanceForFinalView =
    bundle.payload.header.colorSemantic ===
    UegsPayloadColorSemantic.BakedSceneAppearanceLinear;

  return dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
    if (!gsplat) {
      throw new Error("UEGS modifier requires gsplat input");
    }

    const { rgba, renderCenter, renderScales, renderQuaternion } = dyno({
      inTypes: {
        gsplat: Gsplat,
        normalRoughness: "sampler2DArray",
        baseMetallic: "sampler2DArray",
        exactCenter: "sampler2DArray",
        exactScale: "sampler2DArray",
        exactQuaternion: "sampler2DArray",
        emissiveAmbientOcclusion: "sampler2DArray",
        bakedShadowOpacity: "sampler2DArray",
        capturedSceneColor: "sampler2DArray",
        capturedTargetBaseColor: "sampler2DArray",
        capturedTargetNormal: "sampler2DArray",
        capturedSceneNormal: "sampler2DArray",
        capturedDirectShadowed: "sampler2DArray",
        capturedDirectUnshadowed: "sampler2DArray",
        directionalLights: "sampler2D",
        directionalLightCount: "int",
        localLights: "sampler2D",
        localLightCount: "int",
        skyRadiance: "vec4",
        viewWorldPosition: "vec3",
        objectToWorldRotation: "vec4",
        bakedShadowEnabled: "bool",
        directLightingEnabled: "bool",
        skyLightingEnabled: "bool",
        ambientOcclusionEnabled: "bool",
        debugViewMode: "int",
        hasExactSplatGeometry: "bool",
      },
      outTypes: {
        rgba: "vec4",
        renderCenter: "vec3",
        renderScales: "vec3",
        renderQuaternion: "vec4",
      },
      inputs: {
        gsplat,
        normalRoughness: resources.normalRoughnessTexture,
        baseMetallic: resources.baseMetallicTexture,
        exactCenter: resources.exactCenterTexture,
        exactScale: resources.exactScaleTexture,
        exactQuaternion: resources.exactQuaternionTexture,
        emissiveAmbientOcclusion: resources.emissiveAmbientOcclusionTexture,
        bakedShadowOpacity: resources.bakedShadowOpacityTexture,
        capturedSceneColor: resources.capturedSceneColorTexture,
        capturedTargetBaseColor: resources.capturedTargetBaseColorTexture,
        capturedTargetNormal: resources.capturedTargetNormalTexture,
        capturedSceneNormal: resources.capturedSceneNormalTexture,
        capturedDirectShadowed: resources.capturedDirectShadowedTexture,
        capturedDirectUnshadowed: resources.capturedDirectUnshadowedTexture,
        directionalLights: resources.directionalLightsTexture,
        directionalLightCount: resources.directionalLightCount,
        localLights: resources.localLightsTexture,
        localLightCount: resources.localLightCount,
        skyRadiance: resources.skyRadiance,
        viewWorldPosition: mesh.context.viewToWorld.translate,
        objectToWorldRotation: mesh.context.transform.rotate,
        bakedShadowEnabled: resources.bakedShadowEnabled,
        directLightingEnabled: resources.directLightingEnabled,
        skyLightingEnabled: resources.skyLightingEnabled,
        ambientOcclusionEnabled: resources.ambientOcclusionEnabled,
        debugViewMode: resources.debugViewMode,
        hasExactSplatGeometry: resources.hasExactSplatGeometry,
      },
      globals: () => [defineUegsLighting, defineGsplatNormal],
      statements: ({ inputs, outputs }) =>
        unindentLines(`
          if (!isGsplatActive(${inputs.gsplat}.flags)) {
            ${outputs.rgba} = vec4(0.0);
            ${outputs.renderCenter} = ${inputs.gsplat}.center;
            ${outputs.renderScales} = ${inputs.gsplat}.scales;
            ${outputs.renderQuaternion} = ${inputs.gsplat}.quaternion;
          } else {
            ivec3 uegsCoord = splatTexCoord(${inputs.gsplat}.index);
            vec4 uegsNormalRoughness = texelFetch(${inputs.normalRoughness}, uegsCoord, 0);
            vec4 uegsBaseMetallic = texelFetch(${inputs.baseMetallic}, uegsCoord, 0);
            vec4 uegsExactCenter = texelFetch(${inputs.exactCenter}, uegsCoord, 0);
            vec4 uegsExactScale = texelFetch(${inputs.exactScale}, uegsCoord, 0);
            vec4 uegsExactQuaternion = texelFetch(${inputs.exactQuaternion}, uegsCoord, 0);
            vec4 uegsEmissiveAmbientOcclusion = texelFetch(${inputs.emissiveAmbientOcclusion}, uegsCoord, 0);
            vec4 uegsBakedShadowOpacity = texelFetch(${inputs.bakedShadowOpacity}, uegsCoord, 0);
            vec4 uegsCapturedSceneColor = texelFetch(${inputs.capturedSceneColor}, uegsCoord, 0);
            vec4 uegsCapturedTargetBaseColor = texelFetch(${inputs.capturedTargetBaseColor}, uegsCoord, 0);
            vec4 uegsCapturedTargetNormal = texelFetch(${inputs.capturedTargetNormal}, uegsCoord, 0);
            vec4 uegsCapturedSceneNormal = texelFetch(${inputs.capturedSceneNormal}, uegsCoord, 0);
            vec4 uegsCapturedDirectShadowed = texelFetch(${inputs.capturedDirectShadowed}, uegsCoord, 0);
            vec4 uegsCapturedDirectUnshadowed = texelFetch(${inputs.capturedDirectUnshadowed}, uegsCoord, 0);
            vec3 uegsSerializedBaseColor = ${inputs.gsplat}.rgba.rgb;
            vec3 uegsRenderCenter = ${inputs.hasExactSplatGeometry}
              ? uegsExactCenter.xyz
              : ${inputs.gsplat}.center;
            vec3 uegsRenderScales = ${inputs.hasExactSplatGeometry}
              ? uegsExactScale.xyz
              : ${inputs.gsplat}.scales;
            ${
              clampMinimumShellScale
                ? "uegsRenderScales = max(uegsRenderScales, vec3(0.01, 0.01, 0.001));"
                : ""
            }
            vec4 uegsRenderQuaternion = ${inputs.hasExactSplatGeometry}
              ? normalize(uegsExactQuaternion)
              : ${inputs.gsplat}.quaternion;

            ${
              flattenMinAxisTo2D
                ? unindent(`
            float uegsMinScale = min(uegsRenderScales.x, min(uegsRenderScales.y, uegsRenderScales.z));
            if (uegsRenderScales.z <= uegsMinScale) {
              uegsRenderScales.z = 0.0;
            } else if (uegsRenderScales.y <= uegsMinScale) {
              uegsRenderScales.y = 0.0;
            } else {
              uegsRenderScales.x = 0.0;
            }
            `)
                : ""
            }

            vec4 uegsWorldQuaternion = quatQuat(${inputs.objectToWorldRotation}, uegsRenderQuaternion);
            vec3 uegsShellNormal = normalize(gsplatNormal(uegsRenderScales, uegsWorldQuaternion));
            vec3 uegsRawNormal = normalize(uegsQuatVec(${inputs.objectToWorldRotation}, uegsNormalRoughness.xyz));
            vec3 uegsView = normalize(${inputs.viewWorldPosition} - uegsRenderCenter);
            float uegsShellViewDot = dot(uegsShellNormal, uegsView);
            float uegsNormalViewDot = dot(uegsRawNormal, uegsView);
            vec3 uegsNormal = uegsRawNormal;
            ${
              orientNormalsToShellHemisphere
                ? unindent(`
            if (dot(uegsNormal, uegsShellNormal) < 0.0) {
              uegsNormal = -uegsNormal;
            }
            `)
                : ""
            }
            ${
              flipNormalsToView
                ? unindent(`
            if (uegsNormalViewDot < 0.0) {
              uegsNormal = -uegsNormal;
            }
            `)
                : ""
            }

            float uegsRoughness = clamp(uegsNormalRoughness.w, 0.045, 1.0);
            float uegsMetallic = clamp(uegsBaseMetallic.w, 0.0, 1.0);
            float uegsAo = clamp(uegsEmissiveAmbientOcclusion.w, 0.0, 1.0);
            float uegsBakedShadow = clamp(uegsBakedShadowOpacity.x, 0.0, 1.0);
            float uegsOpacity = ${usePayloadOpacity ? "clamp(uegsBakedShadowOpacity.y, 0.0, 1.0)" : `${inputs.gsplat}.rgba.a`};
            if (${cullBackfacingShellSplats}) {
              float uegsFacingWeight = smoothstep(-0.25, 0.1, uegsNormalViewDot);
              uegsOpacity *= uegsFacingWeight;
            }
            float uegsAoForShading = ${inputs.ambientOcclusionEnabled} ? uegsAo : 1.0;

            vec3 uegsDirectTransfer = vec3(0.0);
            vec3 uegsDirectLighting = vec3(0.0);
            if (${inputs.directLightingEnabled}) {
              for (int lightIndex = 0; lightIndex < UEGS_MAX_DIRECTIONAL_LIGHTS; ++lightIndex) {
                if (lightIndex >= ${inputs.directionalLightCount}) {
                  break;
                }
                vec4 dirData = texelFetch(${inputs.directionalLights}, ivec2(0, lightIndex), 0);
                vec4 colorData = texelFetch(${inputs.directionalLights}, ivec2(1, lightIndex), 0);
                vec3 toLight = normalize(dirData.xyz);
                vec3 radiance = colorData.rgb * dirData.w;
                float ndotl = max(dot(uegsNormal, toLight), 0.0);
                uegsDirectTransfer += radiance * ndotl;
                uegsDirectLighting += uegsEvaluateDirectPbr(
                  uegsBaseMetallic.rgb,
                  uegsMetallic,
                  uegsRoughness,
                  uegsNormal,
                  uegsView,
                  toLight,
                  radiance
                );
              }

              for (int lightIndex = 0; lightIndex < UEGS_MAX_LOCAL_LIGHTS; ++lightIndex) {
                if (lightIndex >= ${inputs.localLightCount}) {
                  break;
                }
                vec4 positionIntensity = texelFetch(${inputs.localLights}, ivec2(0, lightIndex), 0);
                vec4 directionRadius = texelFetch(${inputs.localLights}, ivec2(1, lightIndex), 0);
                vec4 colorType = texelFetch(${inputs.localLights}, ivec2(2, lightIndex), 0);
                vec4 coneShadow = texelFetch(${inputs.localLights}, ivec2(3, lightIndex), 0);

                vec3 lightVector = positionIntensity.xyz - ${inputs.gsplat}.center;
                float distanceToLight = length(lightVector);
                vec3 toLight = distanceToLight > 1.0e-4 ? lightVector / distanceToLight : vec3(0.0, 0.0, 1.0);
                float attenuation = uegsLocalAttenuation(distanceToLight, directionRadius.w);
                if (colorType.w > 0.5) {
                  attenuation *= uegsSpotAttenuation(
                    normalize(directionRadius.xyz),
                    normalize(${inputs.gsplat}.center - positionIntensity.xyz),
                    coneShadow.x,
                    coneShadow.y
                  );
                }
                vec3 radiance = colorType.rgb * positionIntensity.w * attenuation;
                float ndotl = max(dot(uegsNormal, toLight), 0.0);
                uegsDirectTransfer += radiance * ndotl;
                uegsDirectLighting += uegsEvaluateDirectPbr(
                  uegsBaseMetallic.rgb,
                  uegsMetallic,
                  uegsRoughness,
                  uegsNormal,
                  uegsView,
                  toLight,
                  radiance
                );
              }
            }

            if (${inputs.bakedShadowEnabled}) {
              uegsDirectLighting *= uegsBakedShadow;
            }

            vec3 uegsAmbientTransfer = ${inputs.skyLightingEnabled}
              ? ${inputs.skyRadiance}.rgb
              : vec3(0.0);
            vec3 uegsAmbientTransferOccluded = uegsAmbientTransfer * uegsAoForShading;
            vec3 uegsDirectTransferShadowed = ${inputs.bakedShadowEnabled}
              ? uegsDirectTransfer * uegsBakedShadow
              : uegsDirectTransfer;
            vec3 uegsAmbientContribution = uegsBaseMetallic.rgb * uegsAmbientTransfer;
            vec3 uegsAmbientContributionOccluded = uegsAmbientContribution * uegsAo;
            vec3 uegsDirectContribution = uegsBaseMetallic.rgb * uegsDirectTransfer;
            vec3 uegsDirectContributionShadowed = uegsDirectContribution * uegsBakedShadow;
            vec3 uegsAmbient = ${inputs.skyLightingEnabled}
              ? uegsEvaluateSkyAmbient(
                  uegsBaseMetallic.rgb,
                  uegsMetallic,
                  uegsRoughness,
                  uegsAoForShading,
                  uegsNormal,
                  uegsView,
                  ${inputs.skyRadiance}.rgb
                )
              : vec3(0.0);
            vec3 uegsBakedComposition = uegsEmissiveAmbientOcclusion.rgb;
            if (${inputs.skyLightingEnabled}) {
              uegsBakedComposition += ${inputs.ambientOcclusionEnabled}
                ? uegsAmbientContributionOccluded
                : uegsAmbientContribution;
            }
            if (${inputs.directLightingEnabled}) {
              uegsBakedComposition += ${inputs.bakedShadowEnabled}
                ? uegsDirectContributionShadowed
                : uegsDirectContribution;
            }
            vec3 uegsFinalRgb = ${
              useSerializedSceneAppearanceForFinalView
                ? "uegsSerializedBaseColor"
                : "uegsEmissiveAmbientOcclusion.rgb + uegsAmbient + uegsDirectLighting"
            };
            vec3 uegsDebugRgb = uegsFinalRgb;
            float uegsDebugOpacity = uegsOpacity;
            switch (${inputs.debugViewMode}) {
              case ${UegsDebugViewMode.BaseColor}:
                uegsDebugRgb = ${useSerializedBaseColorForBaseView ? "uegsSerializedBaseColor" : "uegsBaseMetallic.rgb"};
                break;
              case ${UegsDebugViewMode.SerializedColor}:
                uegsDebugRgb = uegsSerializedBaseColor;
                break;
              case ${UegsDebugViewMode.CapturedSceneColor}:
                uegsDebugRgb = clamp(uegsCapturedSceneColor.rgb, 0.0, 1.0);
                uegsDebugOpacity *= uegsCapturedSceneColor.a;
                break;
              case ${UegsDebugViewMode.CapturedTargetBaseColor}:
                uegsDebugRgb = clamp(uegsCapturedTargetBaseColor.rgb, 0.0, 1.0);
                uegsDebugOpacity *= uegsCapturedTargetBaseColor.a;
                break;
              case ${UegsDebugViewMode.CapturedTargetNormal}:
                uegsDebugRgb = clamp(uegsCapturedTargetNormal.rgb, 0.0, 1.0);
                uegsDebugOpacity *= uegsCapturedTargetNormal.a;
                break;
              case ${UegsDebugViewMode.CapturedSceneNormal}:
                uegsDebugRgb = clamp(uegsCapturedSceneNormal.rgb, 0.0, 1.0);
                uegsDebugOpacity *= uegsCapturedSceneNormal.a;
                break;
              case ${UegsDebugViewMode.CapturedDirectShadowed}:
                uegsDebugRgb = clamp(uegsCapturedDirectShadowed.rgb, 0.0, 1.0);
                uegsDebugOpacity *= uegsCapturedDirectShadowed.a;
                break;
              case ${UegsDebugViewMode.CapturedDirectUnshadowed}:
                uegsDebugRgb = clamp(uegsCapturedDirectUnshadowed.rgb, 0.0, 1.0);
                uegsDebugOpacity *= uegsCapturedDirectUnshadowed.a;
                break;
              case ${UegsDebugViewMode.Normal}:
                uegsDebugRgb = uegsNormal * 0.5 + 0.5;
                break;
              case ${UegsDebugViewMode.RawNormal}:
                uegsDebugRgb = uegsRawNormal * 0.5 + 0.5;
                break;
              case ${UegsDebugViewMode.DirectLighting}:
                uegsDebugRgb = clamp(uegsDirectLighting, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.AmbientLighting}:
                uegsDebugRgb = clamp(uegsAmbient, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.AmbientTransfer}:
                uegsDebugRgb = clamp(uegsAmbientTransfer, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.AmbientTransferOccluded}:
                uegsDebugRgb = clamp(uegsAmbientTransferOccluded, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.AmbientContribution}:
                uegsDebugRgb = clamp(uegsAmbientContribution, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.AmbientContributionOccluded}:
                uegsDebugRgb = clamp(uegsAmbientContributionOccluded, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.Emissive}:
                uegsDebugRgb = clamp(uegsEmissiveAmbientOcclusion.rgb, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.DirectTransfer}:
                uegsDebugRgb = clamp(uegsDirectTransfer, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.DirectTransferShadowed}:
                uegsDebugRgb = clamp(uegsDirectTransferShadowed, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.DirectContribution}:
                uegsDebugRgb = clamp(uegsDirectContribution, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.DirectContributionShadowed}:
                uegsDebugRgb = clamp(uegsDirectContributionShadowed, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.BakedComposition}:
                uegsDebugRgb = clamp(uegsBakedComposition, 0.0, 1.0);
                break;
              case ${UegsDebugViewMode.AmbientOcclusion}:
                uegsDebugRgb = vec3(uegsAo);
                break;
              case ${UegsDebugViewMode.BakedShadow}:
                uegsDebugRgb = vec3(uegsBakedShadow);
                break;
              case ${UegsDebugViewMode.Final}:
              default:
                break;
            }
            ${outputs.rgba} = vec4(uegsDebugRgb, uegsDebugOpacity);
            ${outputs.renderCenter} = uegsRenderCenter;
            ${outputs.renderScales} = uegsRenderScales;
            ${outputs.renderQuaternion} = uegsRenderQuaternion;
          }
        `),
    }).outputs;

    return {
      gsplat: combineGsplat({
        gsplat,
        center: renderCenter,
        rgba,
        scales: renderScales,
        quaternion: renderQuaternion,
      }),
    };
  });
}

export function configureUegsBundleForMesh(mesh: SplatMesh): boolean {
  const bundle = getUegsBundle(mesh.packedSplats);
  if (!bundle) {
    return false;
  }

  if (
    bundle.payload.header.appearanceEncoding !==
      UegsPayloadAppearanceEncoding.ExplorableSceneRelight &&
    bundle.payload.header.appearanceEncoding !==
      UegsPayloadAppearanceEncoding.ExplorableSceneRelightBakedShadows
  ) {
    return false;
  }

  const extra = mesh.packedSplats.extra as UegsExtra;
  if (extra.uegsAutoConfigured) {
    return true;
  }

  mesh.enableViewToWorld = true;
  mesh.maxSh =
    typeof extra.uegsRequestedMaxSh === "number" ? extra.uegsRequestedMaxSh : 0;
  mesh.uegsModifier = makeUegsModifier(mesh);
  extra.uegsAutoConfigured = true;
  return Boolean(mesh.uegsModifier);
}

function applyUegsRuntimeUniform<T extends boolean | number>(
  mesh: SplatMesh,
  selector: (
    resources: UegsGpuResources,
  ) => { value: T; uniform: { value: T } } | undefined,
  value: T,
): boolean {
  const resources = ensureUegsGpuResources(mesh.packedSplats);
  if (!resources) {
    return false;
  }
  const target = selector(resources);
  if (!target) {
    return false;
  }
  target.value = value;
  target.uniform.value = value;
  return true;
}

export function setUegsBakedShadowEnabled(
  mesh: SplatMesh,
  enabled: boolean,
): boolean {
  if (!bundleExportsBakedShadowTransfer(getUegsBundle(mesh.packedSplats))) {
    return false;
  }
  return applyUegsRuntimeUniform(
    mesh,
    (resources) => resources.bakedShadowEnabled,
    enabled,
  );
}

export function setUegsDirectLightingEnabled(
  mesh: SplatMesh,
  enabled: boolean,
): boolean {
  return applyUegsRuntimeUniform(
    mesh,
    (resources) => resources.directLightingEnabled,
    enabled,
  );
}

export function setUegsSkyLightingEnabled(
  mesh: SplatMesh,
  enabled: boolean,
): boolean {
  return applyUegsRuntimeUniform(
    mesh,
    (resources) => resources.skyLightingEnabled,
    enabled,
  );
}

export function setUegsAmbientOcclusionEnabled(
  mesh: SplatMesh,
  enabled: boolean,
): boolean {
  return applyUegsRuntimeUniform(
    mesh,
    (resources) => resources.ambientOcclusionEnabled,
    enabled,
  );
}

export function setUegsDebugViewMode(
  mesh: SplatMesh,
  mode: UegsDebugViewMode,
): boolean {
  return applyUegsRuntimeUniform(
    mesh,
    (resources) => resources.debugViewMode,
    mode,
  );
}
