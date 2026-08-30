const TERMINATION_REASON_LABELS: Readonly<Record<string, string>> = {
  UserRequested: 'User requested',
  InactivityTimeout: 'Inactivity timeout',
  HardTimeout: 'Hard timeout',
  Unknown: 'Unknown',
};

export function formatTerminationReason(reason: string): string {
  return TERMINATION_REASON_LABELS[reason] ?? TERMINATION_REASON_LABELS.Unknown;
}
