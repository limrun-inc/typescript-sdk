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
    width: '360px',
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
  } satisfies CSSProperties,
  panels: { display: 'flex', gap: '20px', flex: 1, minHeight: 0 } satisfies CSSProperties,
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

export const multiSelectStyle: CSSProperties = { ...inputStyle, height: '88px' };

export const tabRow: CSSProperties = {
  display: 'flex',
  gap: '6px',
  padding: '4px',
  backgroundColor: '#eef0f2',
  borderRadius: '8px',
};

export function tabButton(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '8px',
    fontSize: '13px',
    fontWeight: 600,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: active ? '#fff' : 'transparent',
    color: active ? '#1565c0' : '#666',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
  };
}

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

export const codeBlock: CSSProperties = {
  margin: '8px 0 4px',
  padding: '8px 10px',
  backgroundColor: '#0d1117',
  color: '#c9d1d9',
  borderRadius: '6px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
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

export function dangerButton(disabled: boolean): CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#dc3545' };
}
