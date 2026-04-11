import { PackedSplats } from './PackedSplats';
import { SplatMesh } from './SplatMesh';
import * as THREE from "three";
type JsonRecord = Record<string, unknown>;
export declare enum UegsPayloadMaterialTruthSource {
    Unknown = 0,
    HeuristicBindings = 1,
    BakedSurface = 2
}
export declare enum UegsPayloadColorSemantic {
    Unknown = 0,
    SurfaceBaseColorLinear = 1,
    BakedMaterialAppearanceLinear = 2,
    BakedSceneAppearanceLinear = 3
}
export declare enum UegsPayloadAppearanceEncoding {
    None = 0,
    ConservativeFirstOrderSh = 1,
    DirectColorOnly = 2,
    ExplorableSceneRelight = 3,
    ExplorableSceneRelightBakedShadows = 4
}
export declare enum UegsDebugViewMode {
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
    BakedComposition = 17
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
type UegsRenderableExactSplatGeometry = {
    centers: Float32Array;
    scales: Float32Array;
    quaternions: Float32Array;
    source: "payload" | "spz" | "hybrid";
};
export declare function parseUegsManifest(json: string | JsonRecord): UegsManifest;
export declare function parseUegsComparisonViewpoint(manifest: UegsManifest | null | undefined): UegsComparisonViewpoint | null;
export declare function scaleUegsComparisonViewpointToSceneBounds(comparisonViewpoint: UegsComparisonViewpoint | null | undefined, manifest: UegsManifest | null | undefined, sceneBounds: THREE.Box3 | null | undefined): UegsComparisonViewpoint | null;
export declare function parseUegsSceneLightingContract(json: string | JsonRecord): UegsSceneLightingContract;
export declare function parseUegsGaussianPayload(input: ArrayBuffer | Uint8Array): UegsGaussianPayload;
export declare function parseUegsDebugCaptureSidecar(input: ArrayBuffer | Uint8Array): UegsDebugCaptureSidecar;
export declare function summarizeUegsBundle(bundle: UegsBundle): {
    appearanceEncoding: UegsPayloadAppearanceEncoding;
    recordCount: number;
    directionalLightCount: number;
    localLightCount: number;
    skyLightCount: number;
    bakedGeometryShadowTransferExported: boolean;
    toneMappingApplied: boolean;
    lensEffectsApplied: boolean;
    geometryContactShadowApproximationExpected: boolean;
    skyRadiance: THREE.Vector3;
    payloadTelemetry: UegsPayloadTelemetry;
    debugCaptureTelemetry: UegsDebugCaptureTelemetry | null;
};
export declare function loadOptionalUegsBundleFromUrl(spzUrl: string, requestInit?: RequestInit): Promise<UegsBundle | undefined>;
export declare function attachUegsBundle(packedSplats: PackedSplats, bundle: UegsBundle): void;
export declare function getUegsSparkViewContract(source: UegsBundle | PackedSplats | SplatMesh | undefined): UegsSparkViewContract | undefined;
export declare function getUegsSparkRenderContract(source: UegsBundle | PackedSplats | SplatMesh | undefined): UegsSparkRenderContract | undefined;
export declare function alignUegsNormalToShellHemisphere(normal: THREE.Vector3, shellNormal: THREE.Vector3): THREE.Vector3;
export declare function applyUegsSparkViewContract(viewpoint: {
    sortRadial: boolean;
    sort32?: boolean;
    stochastic: boolean;
    sort360?: boolean;
    depthBias?: number;
}, source: UegsBundle | PackedSplats | SplatMesh | undefined): UegsSparkViewContract | undefined;
export declare function inspectUegsRuntimeTelemetry(mesh: SplatMesh): UegsRuntimeTelemetry;
export declare function configureUegsBundleForMesh(mesh: SplatMesh): boolean;
export declare function setUegsBakedShadowEnabled(mesh: SplatMesh, enabled: boolean): boolean;
export declare function setUegsDirectLightingEnabled(mesh: SplatMesh, enabled: boolean): boolean;
export declare function setUegsSkyLightingEnabled(mesh: SplatMesh, enabled: boolean): boolean;
export declare function setUegsAmbientOcclusionEnabled(mesh: SplatMesh, enabled: boolean): boolean;
export declare function setUegsDebugViewMode(mesh: SplatMesh, mode: UegsDebugViewMode): boolean;
export {};
