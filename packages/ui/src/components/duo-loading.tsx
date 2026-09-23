import { useEffect, useRef, useState } from 'react';
import { DuoFlatFrame } from './duo-flat-frame';
import { flatFrameGeometry } from './duo-flat-geometry';

/** Keep the device visible while signaling and the first video frame arrive. */
export function DuoLoadingScreen({ logo }: { logo?: string }) {
  return (
    <div className="rc-duo-loading-screen" role="status" aria-label="Connecting to iPhone Duo">
      {logo && <img src={logo} alt="" />}
    </div>
  );
}

export function DuoLoading({ logo, showFrame }: { logo?: string; showFrame: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const frame = flatFrameGeometry(false, 0, size.width, size.height);
  const scale =
    showFrame ? frame.scale : Math.min(size.width / frame.screenWidth, size.height / frame.screenHeight);
  const width = showFrame ? frame.bodyWidth : frame.screenWidth;
  const height = showFrame ? frame.bodyHeight : frame.screenHeight;
  return (
    <div className="rc-duo-view">
      <div className={showFrame ? 'rc-duo' : 'rc-duo rc-duo-frameless'}>
        <div ref={stage} className="rc-duo-flat-stage">
          <div
            className="rc-duo-flat-device"
            style={{ width: width * scale, height: height * scale, transform: 'translate(-50%, -50%)' }}
          >
            {showFrame && <DuoFlatFrame inner={false} width={width} height={height} />}
            <div
              className="rc-duo-flat-screen"
              style={{
                width: frame.screenWidth * scale,
                height: frame.screenHeight * scale,
                left: ((width - frame.screenWidth) / 2) * scale,
                top: ((height - frame.screenHeight) / 2) * scale,
                borderRadius: showFrame ? [0.8, 6.6, 6.6, 0.8].map((r) => r * scale + 'px').join(' ') : 0,
              }}
            >
              <DuoLoadingScreen logo={logo} />
            </div>
          </div>
        </div>
        {showFrame && <div className="rc-duo-loading-controls" aria-hidden="true" />}
      </div>
    </div>
  );
}
