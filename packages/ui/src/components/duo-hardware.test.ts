import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createDuoModel } from './duo-model';
import { hardwareHoverEdge, hardwareLayout } from './duo-hardware';

describe('Duo edge hints', () => {
  it.each([0, 110, 180])('keeps icon targets outside the screen at %s degrees', (angle) => {
    const model = createDuoModel(new THREE.Texture(), new THREE.Texture());
    model.setAngle(angle);
    model.device.rotation.y = angle === 0 ? Math.PI / 2 : 0;
    model.device.updateMatrixWorld(true);
    const camera = new THREE.OrthographicCamera(-120, 120, 120, -120, 1, 1000);
    camera.position.z = 340;
    camera.updateMatrixWorld(true);
    const { guides, rect } = hardwareLayout(
      model.buttonAnchors(),
      model.getBounds(new THREE.Box3()),
      camera,
      500,
      500,
    );
    expect(guides).toHaveLength(3);
    for (const guide of guides) {
      expect(rect.containsPoint(new THREE.Vector2(guide.x, guide.y))).toBe(false);
      expect(hardwareHoverEdge(guide.x, guide.y, rect)).toBe(guide.edge);
    }
    expect(guides.filter((g) => g.button !== 'side').every((g) => g.edge === 'top')).toBe(true);
    const volume = guides.filter((guide) => guide.button !== 'side');
    expect(Math.abs(volume[0]!.x - volume[1]!.x)).toBeGreaterThanOrEqual(48);
    model.dispose();
  });

  it('keeps the edge visible while crossing from the device to its icon', () => {
    const rect = new THREE.Box2(new THREE.Vector2(100, 100), new THREE.Vector2(400, 600));
    for (const y of [104, 100, 90, 80, 72]) expect(hardwareHoverEdge(250, y, rect)).toBe('top');
    expect(hardwareHoverEdge(250, 350, rect)).toBeUndefined();
    expect(hardwareHoverEdge(250, 40, rect)).toBeUndefined();
    expect(hardwareHoverEdge(428, 250, rect)).toBe('right');
  });

  it('moves hints with native screen orientation', () => {
    const model = createDuoModel(new THREE.Texture(), new THREE.Texture());
    model.device.rotation.z = Math.PI / 2;
    model.device.updateMatrixWorld(true);
    const camera = new THREE.OrthographicCamera(-120, 120, 120, -120, 1, 1000);
    camera.position.z = 340;
    camera.updateMatrixWorld(true);
    const { guides } = hardwareLayout(
      model.buttonAnchors(),
      model.getBounds(new THREE.Box3()),
      camera,
      500,
      500,
    );
    expect(guides.filter((g) => g.button !== 'side').every((g) => g.edge === 'left')).toBe(true);
    expect(guides.find((g) => g.button === 'side')?.edge).toBe('top');
    model.dispose();
  });
});
