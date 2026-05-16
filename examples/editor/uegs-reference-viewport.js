export function parsePositiveFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function getUegsReferenceViewport(manifest) {
  const viewpoint = manifest?.comparison_viewpoint ?? null;
  if (viewpoint == null || typeof viewpoint !== "object") {
    return null;
  }

  const width = parsePositiveFiniteNumber(viewpoint.viewport_width_px);
  const height = parsePositiveFiniteNumber(viewpoint.viewport_height_px);
  if (width == null || height == null) {
    return null;
  }

  return {
    width,
    height,
    aspect: width / height,
  };
}

export function referenceViewportsMatch(left, right, tolerance = 1e-6) {
  if (left == null || right == null) {
    return left == null && right == null;
  }

  return (
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  );
}

export function resolveSharedUegsReferenceViewport(viewports) {
  const validViewports = viewports.filter((viewport) => viewport != null);
  if (validViewports.length === 0) {
    return {
      viewport: null,
      mismatch: false,
      viewports: validViewports,
    };
  }

  const [firstViewport] = validViewports;
  const mismatch = validViewports.some(
    (viewport) => !referenceViewportsMatch(firstViewport, viewport),
  );

  return {
    viewport: firstViewport,
    mismatch,
    viewports: validViewports,
  };
}

export function fitReferenceViewportIntoContainers(
  viewport,
  containers,
  { allowUpscale = false } = {},
) {
  if (viewport == null) {
    return null;
  }

  const validContainers = containers
    .map((container) => ({
      width: parsePositiveFiniteNumber(container?.width),
      height: parsePositiveFiniteNumber(container?.height),
    }))
    .filter((container) => container.width != null && container.height != null);

  if (validContainers.length === 0) {
    return null;
  }

  const fitScale = Math.min(
    ...validContainers.map((container) =>
      Math.min(
        container.width / viewport.width,
        container.height / viewport.height,
      ),
    ),
  );
  const scale = allowUpscale ? fitScale : Math.min(1, fitScale);

  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  return {
    width: viewport.width * scale,
    height: viewport.height * scale,
    scale,
    aspect: viewport.aspect,
  };
}
