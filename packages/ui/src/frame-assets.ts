// Limrun's bundled device frames and boot logos. Imported only by the default
// entry so `@limrun/ui/lite` ships without ~600 KB of inlined artwork.
import type { RemoteControlAssets } from './components/remote-control';
import iphoneFrame from './assets/iphone16pro_black_bg.webp';
import iphoneFrameLandscape from './assets/iphone16pro_black_landscape_bg.webp';
import pixelFrame from './assets/pixel9_black.webp';
import pixelFrameLandscape from './assets/pixel9_black_landscape.webp';
import pixelTabletFrame from './assets/pixel_tablet_portrait.webp';
import pixelTabletFrameLandscape from './assets/pixel_tablet_landscape.webp';
import appleLogo from './assets/Apple_logo_white.svg';
import androidBootLogo from './assets/android_boot.webp';

export const defaultRemoteControlAssets: RemoteControlAssets = {
  ios: { frame: iphoneFrame, frameLandscape: iphoneFrameLandscape, loadingLogo: appleLogo },
  android: {
    frame: pixelFrame,
    frameLandscape: pixelFrameLandscape,
    tabletFrame: pixelTabletFrame,
    tabletFrameLandscape: pixelTabletFrameLandscape,
    loadingLogo: androidBootLogo,
  },
};
