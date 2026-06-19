import type { CSSProperties, ReactNode } from 'react';

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '16px',
  border: '1px solid #e0e0e0',
  borderRadius: '10px',
  backgroundColor: '#fff',
};

const header: CSSProperties = { display: 'flex', gap: '10px', alignItems: 'flex-start' };

const badge: CSSProperties = {
  flex: '0 0 auto',
  width: '26px',
  height: '26px',
  borderRadius: '999px',
  backgroundColor: '#0066ff',
  color: '#fff',
  fontSize: '13px',
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const titleStyle: CSSProperties = { fontSize: '15px', fontWeight: 700, color: '#111' };
const subtitleStyle: CSSProperties = { fontSize: '12px', color: '#666', lineHeight: 1.4, marginTop: '2px' };

/**
 * A phase groups together the steps for one of the two distinct tasks:
 * "build a signed artifact" and "install onto a device". Grouping them this way
 * mirrors how they're usually done — often at different times — and makes the
 * dependency between them (Phase 2 needs Phase 1's artifact) explicit.
 */
export function Phase({
  index,
  title,
  subtitle,
  children,
}: {
  index: number;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section style={wrap}>
      <div style={header}>
        <div style={badge}>{index}</div>
        <div>
          <div style={titleStyle}>{title}</div>
          <div style={subtitleStyle}>{subtitle}</div>
        </div>
      </div>
      {children}
    </section>
  );
}
