export type CameraFacingMode = 'user' | 'environment';

/**
 * Resolution preference for browser camera capture.
 *
 * `'auto'` leaves dimensions to the browser. Named values request standard
 * landscape dimensions independently from the host's output aspect.
 */
export type CameraResolutionCap = 'auto' | '1080p' | '720p' | '480p';

/**
 * Aspect reported by the simulated camera.
 *
 * `'auto'` clears an explicit override and lets the host follow capture.
 */
export type CameraAspect = 'auto' | '16:9' | '4:3' | '1:1' | '9:16';

/** Camera selection requested by the instance host. */
export interface CameraRequest {
  active: boolean;
  facingMode?: CameraFacingMode;
}

/** Browser capture metadata returned to the instance host. */
export interface CameraCaptureInfo {
  width?: number;
  height?: number;
  frameRate?: number;
  deviceId?: string;
  label?: string;
  facingMode?: string;
}

/** Acknowledgement sent after camera capture changes or is reused. */
export interface CameraResult {
  type: 'cameraResult';
  granted: boolean;
  camera?: CameraCaptureInfo;
}

export interface CameraOperationContext {
  generation: number;
  isCurrent: () => boolean;
}

/**
 * Serializes camera mutations while invalidating queued or suspended work.
 *
 * `enqueue` increments the generation before returning, so an operation
 * waiting on browser permission becomes stale as soon as a newer request
 * arrives, even though the newer operation has not started yet.
 */
export class CameraOperationCoordinator {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  get currentGeneration(): number {
    return this.generation;
  }

  enqueue(operation: (context: CameraOperationContext) => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    return this.append(generation, operation);
  }

  /**
   * Queues related work without superseding an already queued request.
   *
   * The operation retains the generation current at enqueue time and becomes
   * stale if a later camera request increments it before this work starts.
   */
  enqueueCurrent(operation: (context: CameraOperationContext) => Promise<void>): Promise<void> {
    return this.append(this.generation, operation);
  }

  private append(
    generation: number,
    operation: (context: CameraOperationContext) => Promise<void>,
  ): Promise<void> {
    const context: CameraOperationContext = {
      generation,
      isCurrent: () => generation === this.generation,
    };
    const next = this.tail.then(() => operation(context));
    this.tail = next.catch(() => undefined);
    return next;
  }

  invalidate(): void {
    ++this.generation;
  }
}

const CAMERA_CAP_DIMENSIONS: Record<
  Exclude<CameraResolutionCap, 'auto'>,
  { width: number; height: number }
> = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
};

export function parseCameraRequest(message: unknown): CameraRequest | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  if (value.type !== 'cameraRequest' || typeof value.active !== 'boolean') return null;

  const request: CameraRequest = { active: value.active };
  if (value.facingMode === 'user' || value.facingMode === 'environment') {
    request.facingMode = value.facingMode;
  }
  return request;
}

export function normalizeCameraAspect(aspect: CameraAspect | undefined): CameraAspect {
  return aspect ?? 'auto';
}

export function createCameraAspectMessage(aspect: CameraAspect | undefined): {
  type: 'cameraAspect';
  aspect: CameraAspect;
} {
  return { type: 'cameraAspect', aspect: normalizeCameraAspect(aspect) };
}

/**
 * Builds best-effort capture constraints.
 *
 * Facing and geometry are preferences so browsers can fall back instead of
 * rejecting capture when a phone-facing label or exact mode is unavailable.
 */
export function cameraCaptureConstraints(
  cap: CameraResolutionCap,
  request?: Pick<CameraRequest, 'facingMode'>,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    frameRate: { ideal: 30, max: 30 },
  };

  if (cap !== 'auto') {
    const dimensions = CAMERA_CAP_DIMENSIONS[cap];
    constraints.width = { ideal: dimensions.width };
    constraints.height = { ideal: dimensions.height };
  }

  if (request?.facingMode) {
    constraints.facingMode = { ideal: request.facingMode };
  }
  return constraints;
}

/**
 * Returns constraints only when the resolution cap changed during
 * acquisition, allowing a newly granted track to catch up before commit.
 */
export function cameraResolutionRefreshConstraints(
  acquisitionGeneration: number,
  currentGeneration: number,
  cap: CameraResolutionCap,
  request?: Pick<CameraRequest, 'facingMode'>,
): MediaTrackConstraints | undefined {
  if (acquisitionGeneration === currentGeneration) return undefined;
  return cameraCaptureConstraints(cap, request);
}

export function shouldReacquireCamera(
  current: Pick<CameraRequest, 'facingMode'> | undefined,
  requested: Pick<CameraRequest, 'facingMode'>,
): boolean {
  return !current || current.facingMode !== requested.facingMode;
}

export function cameraCaptureInfoFromTrack(track: MediaStreamTrack): CameraCaptureInfo {
  const settings = track.getSettings();
  return {
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate,
    deviceId: settings.deviceId,
    label: track.label || undefined,
    facingMode: settings.facingMode,
  };
}

export function createGrantedCameraResult(track: MediaStreamTrack): CameraResult {
  return {
    type: 'cameraResult',
    granted: true,
    camera: cameraCaptureInfoFromTrack(track),
  };
}
