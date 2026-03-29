
precision highp float;
precision highp int;
precision highp usampler2DArray;

#include <splatDefines>
#include <logdepthbuf_pars_vertex>

attribute uint splatIndex;

out vec4 vRgba;
out vec2 vSplatUv;
out vec3 vNdc;
out vec3 vConic;
out vec2 vScreenCenter;
flat out uint vSplatIndex;

uniform vec2 renderSize;
uniform uint numSplats;
uniform vec4 renderToViewQuat;
uniform vec3 renderToViewPos;
uniform float maxStdDev;
uniform float minPixelRadius;
uniform float maxPixelRadius;
uniform float time;
uniform float deltaTime;
uniform bool debugFlag;
uniform float minAlpha;
uniform bool stochastic;
uniform bool enable2DGS;
uniform bool useUegsProjectedEllipse;
uniform float blurAmount;
uniform float preBlurAmount;
uniform float focalDistance;
uniform float apertureAngle;
uniform float clipXY;
uniform float focalAdjustment;

uniform usampler2DArray packedSplats;
uniform vec4 rgbMinMaxLnScaleMinMax;

#ifdef USE_LOGDEPTHBUF
    bool isPerspectiveMatrix( mat4 m ) {
      return m[ 2 ][ 3 ] == - 1.0;
    }
#endif

void main() {
    // Default to outside the frustum so it's discarded if we return early
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vConic = vec3(-0.5, 0.0, -0.5);
    vScreenCenter = vec2(0.0);

    if (uint(gl_InstanceID) >= numSplats) {
        return;
    }

    ivec3 texCoord;
    if (stochastic) {
        texCoord = ivec3(
            uint(gl_InstanceID) & SPLAT_TEX_WIDTH_MASK,
            (uint(gl_InstanceID) >> SPLAT_TEX_WIDTH_BITS) & SPLAT_TEX_HEIGHT_MASK,
            (uint(gl_InstanceID) >> SPLAT_TEX_LAYER_BITS)
        );
    } else {
        if (splatIndex == 0xffffffffu) {
            // Special value reserved for "no splat"
            return;
        }
        texCoord = ivec3(
            splatIndex & SPLAT_TEX_WIDTH_MASK,
            (splatIndex >> SPLAT_TEX_WIDTH_BITS) & SPLAT_TEX_HEIGHT_MASK,
            splatIndex >> SPLAT_TEX_LAYER_BITS
        );
    }
    uvec4 packed = texelFetch(packedSplats, texCoord, 0);

    vec3 center, scales;
    vec4 quaternion, rgba;
    unpackSplatEncoding(packed, center, scales, quaternion, rgba, rgbMinMaxLnScaleMinMax);

    if (rgba.a < minAlpha) {
        return;
    }
    bvec3 zeroScales = equal(scales, vec3(0.0));
    if (all(zeroScales)) {
        return;
    }

    // Compute the view space center of the splat
    vec3 viewCenter = quatVec(renderToViewQuat, center) + renderToViewPos;

    // Discard splats behind the camera
    if (viewCenter.z >= 0.0) {
        return;
    }

    // Compute the clip space center of the splat
    vec4 clipCenter = projectionMatrix * vec4(viewCenter, 1.0);
    vec3 ndcCenter = clipCenter.xyz / clipCenter.w;

    // Discard splats outside near/far planes
    if (abs(clipCenter.z) >= clipCenter.w) {
        return;
    }

    // Discard splats more than clipXY times outside the XY frustum
    float clip = clipXY * clipCenter.w;
    if (abs(clipCenter.x) > clip || abs(clipCenter.y) > clip) {
        return;
    }

    // Record the splat index for entropy
    vSplatIndex = splatIndex;

    // Compute view space quaternion of splat
    vec4 viewQuaternion = quatQuat(renderToViewQuat, quaternion);

    if (enable2DGS && any(zeroScales)) {
        vRgba = rgba;
        vSplatUv = position.xy * maxStdDev;

        vec3 offset;
        if (zeroScales.z) {
            offset = vec3(vSplatUv.xy * scales.xy, 0.0);
        } else if (zeroScales.y) {
            offset = vec3(vSplatUv.x * scales.x, 0.0, vSplatUv.y * scales.z);
        } else {
            offset = vec3(0.0, vSplatUv.xy * scales.yz);
        }

        vec3 viewPos = viewCenter + quatVec(viewQuaternion, offset);
        gl_Position = projectionMatrix * vec4(viewPos, 1.0);
        vNdc = gl_Position.xyz / gl_Position.w;
        #include <logdepthbuf_vertex>
        return;
    }

    if (useUegsProjectedEllipse) {
        vec3 axisXView = quatVec(viewQuaternion, vec3(scales.x, 0.0, 0.0));
        vec3 axisYView = quatVec(viewQuaternion, vec3(0.0, scales.y, 0.0));
        vec3 axisZView = quatVec(viewQuaternion, vec3(0.0, 0.0, scales.z));

        vec4 clipAxisX = projectionMatrix * vec4(viewCenter + axisXView, 1.0);
        vec4 clipAxisY = projectionMatrix * vec4(viewCenter + axisYView, 1.0);
        vec4 clipAxisZ = projectionMatrix * vec4(viewCenter + axisZView, 1.0);
        if (clipAxisX.w <= 1.0e-6 || clipAxisY.w <= 1.0e-6 || clipAxisZ.w <= 1.0e-6) {
            return;
        }

        vec2 centerScreen = vec2(
            (ndcCenter.x * 0.5 + 0.5) * renderSize.x,
            (0.5 - ndcCenter.y * 0.5) * renderSize.y
        );
        vec2 axisXScreen = vec2(
            ((clipAxisX.x / clipAxisX.w) * 0.5 + 0.5) * renderSize.x,
            (0.5 - (clipAxisX.y / clipAxisX.w) * 0.5) * renderSize.y
        );
        vec2 axisYScreen = vec2(
            ((clipAxisY.x / clipAxisY.w) * 0.5 + 0.5) * renderSize.x,
            (0.5 - (clipAxisY.y / clipAxisY.w) * 0.5) * renderSize.y
        );
        vec2 axisZScreen = vec2(
            ((clipAxisZ.x / clipAxisZ.w) * 0.5 + 0.5) * renderSize.x,
            (0.5 - (clipAxisZ.y / clipAxisZ.w) * 0.5) * renderSize.y
        );

        vec2 basisX = axisXScreen - centerScreen;
        vec2 basisY = axisYScreen - centerScreen;
        vec2 basisZ = axisZScreen - centerScreen;

        float covXX =
            basisX.x * basisX.x +
            basisY.x * basisY.x +
            basisZ.x * basisZ.x;
        float covXY =
            basisX.x * basisX.y +
            basisY.x * basisY.y +
            basisZ.x * basisZ.y;
        float covYY =
            basisX.y * basisX.y +
            basisY.y * basisY.y +
            basisZ.y * basisZ.y;

        covXX += 0.3;
        covYY += 0.3;
        if (covXX <= 0.0 || covYY <= 0.0) {
            return;
        }

        float mid = covXX + covYY;
        float delta = length(vec2(covXX - covYY, 2.0 * covXY));
        float lambda1 = 0.5 * (mid + delta);
        float lambda2 = 0.5 * (mid - delta);
        if (lambda1 <= 0.0 || lambda2 <= 0.0) {
            return;
        }

        vec2 diagonalVector = vec2(covXY, lambda1 - covXX);
        if (dot(diagonalVector, diagonalVector) <= 1.0e-8) {
            diagonalVector = vec2(1.0, 0.0);
        } else {
            diagonalVector = normalize(diagonalVector);
        }

        float majorScale = min(maxPixelRadius, 3.0 * sqrt(lambda1));
        float minorScale = min(maxPixelRadius, 3.0 * sqrt(lambda2));
        if (majorScale < minPixelRadius && minorScale < minPixelRadius) {
            return;
        }

        vec2 majorAxisPixels = majorScale * diagonalVector;
        vec2 minorAxisPixels = minorScale * vec2(diagonalVector.y, -diagonalVector.x);

        float determinant = covXX * covYY - covXY * covXY;
        if (abs(determinant) <= 1.0e-8) {
            return;
        }

        float inverseDeterminant = 1.0 / determinant;
        float invXX = covYY * inverseDeterminant;
        float invXY = -covXY * inverseDeterminant;
        float invYY = covXX * inverseDeterminant;

        vec2 majorAxisNdc = vec2(
            majorAxisPixels.x * 2.0 / renderSize.x,
            -majorAxisPixels.y * 2.0 / renderSize.y
        );
        vec2 minorAxisNdc = vec2(
            minorAxisPixels.x * 2.0 / renderSize.x,
            -minorAxisPixels.y * 2.0 / renderSize.y
        );
        vec2 quadNdc = ndcCenter.xy + position.x * majorAxisNdc + position.y * minorAxisNdc;

        vRgba = rgba;
        vSplatUv = position.xy * 3.0;
        vNdc = vec3(quadNdc, ndcCenter.z);
        vConic = vec3(-0.5 * invXX, -invXY, -0.5 * invYY);
        vScreenCenter = centerScreen;
        gl_Position = vec4(quadNdc * clipCenter.w, clipCenter.zw);
        #include <logdepthbuf_vertex>
        return;
    }

    // Compute the 3D covariance matrix of the splat
    mat3 RS = scaleQuaternionToMatrix(scales, viewQuaternion);
    mat3 cov3D = RS * transpose(RS);

    // Compute the Jacobian of the splat's projection at its center
    vec2 scaledRenderSize = renderSize * focalAdjustment;
    vec2 focal = 0.5 * scaledRenderSize * vec2(projectionMatrix[0][0], projectionMatrix[1][1]);

    mat3 J;
    if(isOrthographic) {
        J = mat3(
            focal.x, 0.0, 0.0,
            0.0, focal.y, 0.0,
            0.0, 0.0, 0.0
        );
    } else {
        float invZ = 1.0 / viewCenter.z;
        vec2 J1 = focal * invZ;
        vec2 J2 = -(J1 * viewCenter.xy) * invZ;
        J = mat3(
            J1.x, 0.0, J2.x,
            0.0, J1.y, J2.y,
            0.0, 0.0, 0.0
        );
    }

    // Compute the 2D covariance by projecting the 3D covariance
    // and picking out the XY plane components.
    // Keeping below because we may need it in the future
    // for skinning deformations.
    // mat3 W = transpose(mat3(viewMatrix));
    // mat3 T = W * J;
    // mat3 cov2D = transpose(T) * cov3D * T;
    mat3 cov2D = transpose(J) * cov3D * J;
    float a = cov2D[0][0];
    float d = cov2D[1][1];
    float b = cov2D[0][1];

    // Optionally pre-blur the splat to match non-antialias optimized splats
    a += preBlurAmount;
    d += preBlurAmount;

    float fullBlurAmount = blurAmount;
    if ((focalDistance > 0.0) && (apertureAngle > 0.0)) {
        float focusRadius = maxPixelRadius;
        if (viewCenter.z < 0.0) {
            float focusBlur = abs((-viewCenter.z - focalDistance) / viewCenter.z);
            float apertureRadius = focal.x * tan(0.5 * apertureAngle);
            focusRadius = focusBlur * apertureRadius;
        }
        fullBlurAmount = clamp(sqr(focusRadius), blurAmount, sqr(maxPixelRadius));
    }

    // Do convolution with a 0.5-pixel Gaussian for anti-aliasing: sqrt(0.3) ~= 0.5
    float detOrig = a * d - b * b;
    a += fullBlurAmount;
    d += fullBlurAmount;
    float det = a * d - b * b;

    // Compute anti-aliasing intensity scaling factor
    float blurAdjust = sqrt(max(0.0, detOrig / det));
    rgba.a *= blurAdjust;
    if (rgba.a < minAlpha) {
        return;
    }

    // Compute the eigenvalue and eigenvectors of the 2D covariance matrix
    float eigenAvg = 0.5 * (a + d);
    float eigenDelta = sqrt(max(0.0, eigenAvg * eigenAvg - det));
    float eigen1 = eigenAvg + eigenDelta;
    float eigen2 = eigenAvg - eigenDelta;

    vec2 eigenVec1 = normalize(vec2((abs(b) < 0.001) ? 1.0 : b, eigen1 - a));
    vec2 eigenVec2 = vec2(eigenVec1.y, -eigenVec1.x);

    float scale1 = min(maxPixelRadius, maxStdDev * sqrt(eigen1));
    float scale2 = min(maxPixelRadius, maxStdDev * sqrt(eigen2));
    if (scale1 < minPixelRadius && scale2 < minPixelRadius) {
        return;
    }

    // Compute the NDC coordinates for the ellipsoid's diagonal axes.
    vec2 pixelOffset = position.x * eigenVec1 * scale1 + position.y * eigenVec2 * scale2;
    vec2 ndcOffset = (2.0 / scaledRenderSize) * pixelOffset;
    vec3 ndc = vec3(ndcCenter.xy + ndcOffset, ndcCenter.z);

    vRgba = rgba;
    vSplatUv = position.xy * maxStdDev;
    vNdc = ndc;
    gl_Position = vec4(ndc.xy * clipCenter.w, clipCenter.zw);
    #include <logdepthbuf_vertex>
}
