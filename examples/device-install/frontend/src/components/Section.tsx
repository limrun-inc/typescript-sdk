import type { CSSProperties, ReactNode } from 'react';

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '8px' };
const heading: CSSProperties = { fontSize: '13px', fontWeight: 600, color: '#444' };

/** A titled group of controls in the sidebar. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={wrap}>
      <div style={heading}>{title}</div>
      {children}
    </div>
  );
}
