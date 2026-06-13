export type RectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type NormalizedVideoPoint = {
  x: number;
  y: number;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const getContainedVideoRect = (
  container: RectLike,
  videoWidth: number,
  videoHeight: number,
): RectLike => {
  if (container.width <= 0 || container.height <= 0 || videoWidth <= 0 || videoHeight <= 0) {
    return container;
  }

  const containerRatio = container.width / container.height;
  const videoRatio = videoWidth / videoHeight;
  if (videoRatio > containerRatio) {
    const height = container.width / videoRatio;
    return {
      left: container.left,
      top: container.top + (container.height - height) / 2,
      width: container.width,
      height,
    };
  }

  const width = container.height * videoRatio;
  return {
    left: container.left + (container.width - width) / 2,
    top: container.top,
    width,
    height: container.height,
  };
};

export const normalizeVideoPoint = (
  container: RectLike,
  videoWidth: number,
  videoHeight: number,
  clientX: number,
  clientY: number,
): NormalizedVideoPoint | undefined => {
  const videoRect = getContainedVideoRect(container, videoWidth, videoHeight);
  if (videoRect.width <= 0 || videoRect.height <= 0) return undefined;

  const x = (clientX - videoRect.left) / videoRect.width;
  const y = (clientY - videoRect.top) / videoRect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x: clamp01(x), y: clamp01(y) };
};
