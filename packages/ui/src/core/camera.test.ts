import { describe, expect, test, vi } from 'vitest';
import {
  CameraOperationCoordinator,
  cameraCaptureConstraints,
  createGrantedCameraResult,
  parseCameraRequest,
  shouldReacquireCamera,
} from './camera';

describe('parseCameraRequest', () => {
  test('parses active camera facing', () => {
    expect(
      parseCameraRequest({
        type: 'cameraRequest',
        active: true,
        facingMode: 'environment',
      }),
    ).toEqual({
      active: true,
      facingMode: 'environment',
    });
  });

  test('rejects messages without a boolean active field', () => {
    expect(parseCameraRequest({ type: 'cameraRequest', active: 'true' })).toBeNull();
    expect(parseCameraRequest({ type: 'other', active: true })).toBeNull();
  });
});

describe('cameraCaptureConstraints', () => {
  test('uses ideal facing and frame-rate preferences without geometry', () => {
    const constraints = cameraCaptureConstraints({
      active: true,
      facingMode: 'environment',
    });

    expect(constraints).toEqual({
      frameRate: { ideal: 30, max: 30 },
      facingMode: { ideal: 'environment' },
    });
  });
});

describe('shouldReacquireCamera', () => {
  test('reuses an existing track only for the same facing', () => {
    expect(shouldReacquireCamera({ facingMode: 'user' }, { facingMode: 'user' })).toBe(false);
    expect(shouldReacquireCamera({}, {})).toBe(false);
  });

  test('reacquires when facing changes', () => {
    expect(shouldReacquireCamera({ facingMode: 'user' }, { facingMode: 'environment' })).toBe(true);
    expect(shouldReacquireCamera(undefined, { facingMode: 'user' })).toBe(true);
  });
});

describe('CameraOperationCoordinator', () => {
  test('invalidates suspended work before serially starting the next operation', async () => {
    const coordinator = new CameraOperationCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstDeferred = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.enqueue(async ({ isCurrent }) => {
      events.push('first:start');
      markFirstStarted();
      await firstDeferred;
      events.push(isCurrent() ? 'first:commit' : 'first:stale');
    });
    await firstStarted;

    const second = coordinator.enqueue(async ({ isCurrent }) => {
      events.push('second:start');
      events.push(isCurrent() ? 'second:commit' : 'second:stale');
    });
    const endedCleanup = coordinator.enqueueCurrent(async ({ isCurrent }) => {
      events.push('ended:start');
      events.push(isCurrent() ? 'ended:current' : 'ended:stale');
    });

    expect(events).toEqual(['first:start']);
    expect(coordinator.currentGeneration).toBe(2);
    releaseFirst();
    await Promise.all([first, second, endedCleanup]);
    expect(events).toEqual([
      'first:start',
      'first:stale',
      'second:start',
      'second:commit',
      'ended:start',
      'ended:current',
    ]);
  });

  test('continues serial processing after an operation rejects', async () => {
    const coordinator = new CameraOperationCoordinator();
    await expect(
      coordinator.enqueue(async () => {
        throw new Error('capture failed');
      }),
    ).rejects.toThrow('capture failed');

    const operation = vi.fn();
    await coordinator.enqueue(async () => operation());
    expect(operation).toHaveBeenCalledOnce();
  });

  test('marks non-invalidating work stale when a later request arrives', async () => {
    const coordinator = new CameraOperationCoordinator();
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.enqueue(async () => deferred);
    const cleanup = coordinator.enqueueCurrent(async ({ isCurrent }) => {
      expect(isCurrent()).toBe(false);
    });
    const newerRequest = coordinator.enqueue(async ({ isCurrent }) => {
      expect(isCurrent()).toBe(true);
    });

    release();
    await Promise.all([first, cleanup, newerRequest]);
  });
});

describe('camera result metadata', () => {
  test('reads settings afresh for every acknowledgement', () => {
    const getSettings = vi
      .fn()
      .mockReturnValueOnce({ width: 1280, height: 720, deviceId: 'front' })
      .mockReturnValueOnce({ width: 720, height: 1280, deviceId: 'front' });
    const track = {
      getSettings,
      label: 'Built-in Camera',
    } as unknown as MediaStreamTrack;

    expect(createGrantedCameraResult(track).camera).toMatchObject({
      width: 1280,
      height: 720,
      label: 'Built-in Camera',
    });
    expect(createGrantedCameraResult(track).camera).toMatchObject({
      width: 720,
      height: 1280,
      label: 'Built-in Camera',
    });
    expect(getSettings).toHaveBeenCalledTimes(2);
  });
});
