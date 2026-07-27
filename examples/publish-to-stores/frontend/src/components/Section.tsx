import type { CSSProperties, ReactNode } from 'react';

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  padding: '16px',
  backgroundColor: 'white',
  border: '1px solid #e0e0e0',
  borderRadius: '8px',
};

const titleStyle: CSSProperties = { margin: 0, fontSize: '15px', fontWeight: 600 };

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={sectionStyle}>
      <h2 style={titleStyle}>{title}</h2>
      {children}
    </div>
  );
}
