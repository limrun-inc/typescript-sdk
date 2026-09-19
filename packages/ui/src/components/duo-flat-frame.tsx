import React, { useId } from 'react';

function outline(x: number, y: number, w: number, h: number, left: number, right: number) {
  return (
    'M' +
    (x + left) +
    ',' +
    y +
    'H' +
    (x + w - right) +
    'a' +
    right +
    ',' +
    right +
    ' 0 0 1 ' +
    right +
    ',' +
    right +
    'V' +
    (y + h - right) +
    'a' +
    right +
    ',' +
    right +
    ' 0 0 1 ' +
    -right +
    ',' +
    right +
    'H' +
    (x + left) +
    'a' +
    left +
    ',' +
    left +
    ' 0 0 1 ' +
    -left +
    ',' +
    -left +
    'V' +
    (y + left) +
    'a' +
    left +
    ',' +
    left +
    ' 0 0 1 ' +
    left +
    ',' +
    -left +
    'Z'
  );
}

/** Static silver rails and glass seals follow the same front silhouette as the 3D frame. */
export function DuoFlatFrame({ inner, width, height }: { inner: boolean; width: number; height: number }) {
  const id = useId().replace(/:/g, '');
  const left = inner ? 8.4 : 1.25;
  const right = 8.4;
  return (
    <svg className="rc-duo-flat-frame" viewBox={'0 0 ' + width + ' ' + height} aria-hidden="true">
      <defs>
        <linearGradient id={id + '-silver'} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#62676b" />
          <stop offset="0.035" stopColor="#f9faf9" />
          <stop offset="0.11" stopColor="#b0b4b6" />
          <stop offset="0.31" stopColor="#fdfefd" />
          <stop offset="0.43" stopColor="#797f84" />
          <stop offset="0.51" stopColor="#e8eaea" />
          <stop offset="0.7" stopColor="#979da1" />
          <stop offset="0.87" stopColor="#fafbf9" />
          <stop offset="1" stopColor="#5f676c" />
        </linearGradient>
        <linearGradient id={id + '-spine'}>
          <stop stopColor="#4a5154" />
          <stop offset="0.16" stopColor="#d6d9d9" />
          <stop offset="0.4" stopColor="#f8f9f7" />
          <stop offset="0.62" stopColor="#a2a8ab" />
          <stop offset="0.83" stopColor="#e4e7e5" />
          <stop offset="1" stopColor="#666e72" />
        </linearGradient>
      </defs>
      {!inner && (
        <>
          <rect
            x="-2.3"
            y="0.7"
            width="3.3"
            height={height - 1.4}
            rx="0.85"
            fill={'url(#' + id + '-spine)'}
            stroke="#8b9296"
            strokeWidth="0.15"
          />
          <path d={'M-.6 2V' + (height - 2)} stroke="#f5f6f4" strokeWidth="0.22" />
        </>
      )}
      <path
        d={outline(0, 0, width, height, left, right)}
        fill={'url(#' + id + '-silver)'}
        stroke="#696f72"
        strokeWidth="0.24"
      />
      <path
        d={outline(0.48, 0.48, width - 0.96, height - 0.96, Math.max(0.5, left - 0.48), right - 0.48)}
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.85"
        strokeWidth="0.2"
      />
      <path
        d={outline(1.12, 1.12, width - 2.24, height - 2.24, inner ? 7.15 : 0.65, 7.15)}
        fill="#090b0d"
        stroke="#34393c"
        strokeWidth="0.2"
      />
      {[width - 16, inner ? 19 : 16].map((x) => (
        <React.Fragment key={x}>
          <path
            d={'M' + x + ',0.17v0.82M' + x + ',' + (height - 1) + 'v0.82'}
            stroke="#b1b2ac"
            strokeWidth="1.1"
          />
        </React.Fragment>
      ))}
      {inner &&
        [0, height - 0.6].map((y) => (
          <rect
            key={y}
            x={width / 2 - 2.2}
            y={y}
            width="4.4"
            height="0.6"
            rx="0.18"
            fill={'url(#' + id + '-spine)'}
            stroke="#697074"
            strokeWidth="0.14"
          />
        ))}
      <path
        d={'M' + (width - 0.1) + ',20h-.9m.9,' + (height - 40) + 'h-.9'}
        stroke="#b1b2ac"
        strokeWidth="1.05"
      />
    </svg>
  );
}
