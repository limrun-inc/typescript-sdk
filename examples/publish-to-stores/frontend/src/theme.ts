// All inline styles for the example live here so the components stay focused on
// behaviour. This is a tiny demo, so plain style objects keep things obvious;
// a real app would likely use CSS modules, Tailwind, or your design system.
import type { CSSProperties } from 'react';

export const layout = {
  page: {
    display: 'flex',
    height: '100vh',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  } satisfies CSSProperties,
  sidebar: {
    width: '420px',
    padding: '24px',
    backgroundColor: '#f8f9fa',
    borderRight: '1px solid #e0e0e0',
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    boxSizing: 'border-box',
    overflowY: 'auto',
  } satisfies CSSProperties,
  title: { margin: 0, fontSize: '20px', fontWeight: 600 } satisfies CSSProperties,
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '24px',
    minWidth: 0,
    gap: '16px',
  } satisfies CSSProperties,
};

export const labelStyle: CSSProperties = { fontSize: '13px', fontWeight: 500, color: '#444' };

export const inputStyle: CSSProperties = {
  width: '100%',
  padding: '10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '14px',
  boxSizing: 'border-box',
};

export const infoBox: CSSProperties = {
  padding: '10px',
  backgroundColor: '#e8f5e9',
  color: '#2e7d32',
  borderRadius: '6px',
  fontSize: '13px',
};

export const warnBox: CSSProperties = {
  padding: '10px',
  backgroundColor: '#fff8e1',
  color: '#8a6d00',
  borderRadius: '6px',
  fontSize: '13px',
};

export const errorBox: CSSProperties = {
  padding: '12px',
  backgroundColor: '#fee',
  color: '#c33',
  borderRadius: '6px',
  fontSize: '13px',
};

export const hintText: CSSProperties = {
  fontSize: '12px',
  color: '#666',
  lineHeight: 1.5,
};

function baseButton(disabled: boolean): CSSProperties {
  return {
    width: '100%',
    padding: '12px',
    fontSize: '14px',
    fontWeight: 500,
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background-color 0.2s',
  };
}

export function primaryButton(disabled: boolean): CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#0066ff' };
}

export function secondaryButton(disabled: boolean): CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#444' };
}

export const tabBar: CSSProperties = {
  display: 'flex',
  gap: '6px',
  padding: '4px',
  backgroundColor: '#eceef1',
  borderRadius: '8px',
};

export function tabButton(selected: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '8px',
    fontSize: '14px',
    fontWeight: 600,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: selected ? 'white' : 'transparent',
    color: selected ? '#111' : '#666',
    boxShadow: selected ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
  };
}

export function methodCard(selected: boolean, disabled: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: '160px',
    padding: '14px',
    borderRadius: '8px',
    border: selected ? '2px solid #0066ff' : '1px solid #ddd',
    backgroundColor: disabled ? '#f4f4f4' : 'white',
    color: disabled ? '#999' : '#222',
    cursor: disabled ? 'not-allowed' : 'pointer',
    textAlign: 'left',
  };
}
