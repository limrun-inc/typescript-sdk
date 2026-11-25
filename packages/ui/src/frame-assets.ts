// Limrun's bundled device frames and boot logos. Imported only by the default
// entry so `@limrun/ui/lite` ships without ~600 KB of inlined artwork.
import type { RemoteControlAssets } from './components/remote-control';
import iphoneFrame from './assets/iphone16pro_black_bg.webp';
import iphoneFrameLandscape from './assets/iphone16pro_black_landscape_bg.webp';
import iphoneSEFrame from './assets/iphonese_black_bg.webp';
import iphoneSEFrameLandscape from './assets/iphonese_black_landscape_bg.webp';
import iphone17eFrame from './assets/iphone17e_black_bg.webp';
import iphone17eFrameLandscape from './assets/iphone17e_black_landscape_bg.webp';
import pixelFrame from './assets/pixel9_black.webp';
import pixelFrameLandscape from './assets/pixel9_black_landscape.webp';
import pixelTabletFrame from './assets/pixel_tablet_portrait.webp';
import pixelTabletFrameLandscape from './assets/pixel_tablet_landscape.webp';
import appleLogo from './assets/Apple_logo_white.svg';
import androidBootLogo from './assets/android_boot.webp';
// Rendered by scripts/render-macbook-frame.ts from "macbook pro M3 16 inch 2024" by jackbaeten,
// CC BY 4.0 (https://sketchfab.com/3d-models/8e34fc2b303144f78490007d91ff57c4), with its
// wallpaper removed.
import macbookFrame from './assets/macbook_pro_frame.webp';

export const defaultRemoteControlAssets: RemoteControlAssets = {
  ios: {
    frame: iphoneFrame,
    frameLandscape: iphoneFrameLandscape,
    modelFrames: {
      'iphone-se': { frame: iphoneSEFrame, frameLandscape: iphoneSEFrameLandscape },
      'iphone-17e': { frame: iphone17eFrame, frameLandscape: iphone17eFrameLandscape },
    },
    loadingLogo: appleLogo,
  },
  android: {
    frame: pixelFrame,
    frameLandscape: pixelFrameLandscape,
    tabletFrame: pixelTabletFrame,
    tabletFrameLandscape: pixelTabletFrameLandscape,
    loadingLogo: androidBootLogo,
  },
  macos: {
    frame: macbookFrame,
    // The render's screen opening below the notch's band, which render-macbook-frame.ts reports.
    screen: { left: 0.131975, top: 0.044232, width: 0.735994, height: 0.611388 },
  },
};
