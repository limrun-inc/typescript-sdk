import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { PublishLogLine } from '../hooks/usePublish';

const panelStyle: CSSProperties = {
  flex: 1,
  minHeight: '240px',
  overflowY: 'auto',
  padding: '12px',
  backgroundColor: '#0d1117',
  color: '#c9d1d9',
  borderRadius: '8px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const streamColor: Record<PublishLogLine['stream'], string> = {
  stdout: '#c9d1d9',
  stderr: '#e3b341',
  error: '#f85149',
};

export function LogPanel({ lines }: { lines: PublishLogLine[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  return (
    <div style={panelStyle}>
      {lines.length === 0 ?
        <span style={{ color: '#8b949e' }}>Build logs will appear here.</span>
      : lines.map((line, index) => (
          <div key={index} style={{ color: streamColor[line.stream] }}>
            {line.text}
          </div>
        ))
      }
      <div ref={bottomRef} />
    </div>
  );
}
