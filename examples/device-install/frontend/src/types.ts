// Shared types used across the example. Keeping these in one place makes the
// data that flows between the backend, hooks, and UI easy to follow.

/** An Xcode build sandbox provisioned by the backend. */
export type Sandbox = { id: string; apiUrl: string; token: string };

/** One line in the human-readable "Activity" panel. */
export type LogEntry = { at: string; message: string; detail?: string };

/** A single dot in the top progress stepper. */
export type StepStatus = { label: string; done: boolean; active: boolean };

/** Which signing flow the user picked in step 3. */
export type SigningSource = 'apple' | 'upload';
