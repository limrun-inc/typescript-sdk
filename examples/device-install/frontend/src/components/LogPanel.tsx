import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

const wrap: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 };
const heading: CSSProperties = { fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '8px' };
const body: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  backgroundColor: '#0d1117',
  color: '#c9d1d9',
  borderRadius: '8px',
  padding: '12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

/**
 * A scrollable terminal-style panel. Pass `scrollKey` (e.g. the line count) so
 * the newest line is kept in view as content streams in.
 */
export function LogPanel({
  title,
  scrollKey,
  children,
}: {
  title: string;
  scrollKey?: number;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollKey]);

  return (
    <div style={wrap}>
      <div style={heading}>{title}</div>
      <div ref={scrollRef} style={body}>
        {children}
      </div>
    </div>
  );
}
