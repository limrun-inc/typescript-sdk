import * as THREE from 'three';

/**
 * A procedural studio for the 3D device frames to reflect. Continuous light-to-dark sweeps give
 * broad metal faces reflections at every viewing angle. The caller disposes the returned target.
 */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const studioWidth = 512;
  const studioHeight = 256;
  const studioPixels = new Float32Array(studioWidth * studioHeight * 4);
  for (let y = 0; y < studioHeight; y++) {
    const latitude = ((y + 0.5) / studioHeight - 0.5) * Math.PI;
    for (let x = 0; x < studioWidth; x++) {
      const longitude = ((x + 0.5) / studioWidth) * Math.PI * 2;
      const sweep = Math.pow(0.5 + 0.5 * Math.sin(4 * longitude + 1.8 * Math.sin(latitude)), 3);
      const fill = Math.pow(0.5 + 0.5 * Math.cos(2 * longitude - 3 * latitude), 3);
      const light = 0.12 + 3.2 * sweep + 0.8 * fill;
      const offset = (y * studioWidth + x) * 4;
      studioPixels.set([light, light, light, 1], offset);
    }
  }
  const studio = new THREE.DataTexture(
    studioPixels,
    studioWidth,
    studioHeight,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  studio.mapping = THREE.EquirectangularReflectionMapping;
  studio.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentMap = pmrem.fromEquirectangular(studio);
  studio.dispose();
  pmrem.dispose();
  return environmentMap;
}
