import type { CSSProperties } from 'react';
import type { StepStatus } from '../types';

const row: CSSProperties = { display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' };

function pill(step: StepStatus): CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: '999px',
    fontSize: '13px',
    fontWeight: 500,
    backgroundColor:
      step.done ? '#e8f5e9'
      : step.active ? '#e3f2fd'
      : '#f0f0f0',
    color:
      step.done ? '#2e7d32'
      : step.active ? '#1565c0'
      : '#999',
    border: `1px solid ${
      step.done ? '#a5d6a7'
      : step.active ? '#90caf9'
      : '#e0e0e0'
    }`,
  };
}

/** The horizontal progress indicator at the top of the main area. */
export function Stepper({ steps }: { steps: StepStatus[] }) {
  return (
    <div style={row}>
      {steps.map((step) => (
        <div key={step.label} style={pill(step)}>
          {step.done ? '✓ ' : ''}
          {step.label}
        </div>
      ))}
    </div>
  );
}
