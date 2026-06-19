import type { CSSProperties } from 'react';
import type { StepStatus } from '../types';

export type PhaseView = { title: string; steps: StepStatus[] };

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '16px',
  marginBottom: '20px',
  flexWrap: 'wrap',
};
const group: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '6px' };
const groupTitle: CSSProperties = {
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: '#888',
  textTransform: 'uppercase',
};
const pills: CSSProperties = { display: 'flex', gap: '8px', flexWrap: 'wrap' };
const arrow: CSSProperties = { fontSize: '20px', color: '#bbb' };

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

/**
 * Two-phase progress: "build artifact" then "install". The arrow between the
 * groups signals that the second phase consumes the output of the first.
 */
export function PhaseProgress({ phases }: { phases: PhaseView[] }) {
  return (
    <div style={row}>
      {phases.map((phase, phaseIndex) => (
        <div key={phase.title} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {phaseIndex > 0 && <span style={arrow}>→</span>}
          <div style={group}>
            <span style={groupTitle}>{phase.title}</span>
            <div style={pills}>
              {phase.steps.map((step) => (
                <div key={step.label} style={pill(step)}>
                  {step.done ? '✓ ' : ''}
                  {step.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
