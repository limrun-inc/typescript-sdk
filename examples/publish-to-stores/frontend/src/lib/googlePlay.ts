// Browser-direct Google Play access probe: opening (and immediately
// discarding) an edit is the only way to ask "does this app exist and can
// this account release it?", the Play Developer API has no list-apps
// endpoint. Same pattern the Limrun design doc calls "check again": no
// server surface, the browser talks to Google with its own token.

export type PlayAccessProbe =
  | { result: 'ok' }
  | { result: 'unauthorized' }
  | { result: 'pending'; message: string };

export async function probePlayAccess(accessToken: string, packageName: string): Promise<PlayAccessProbe> {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    packageName,
  )}/edits`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  let response: Response;
  try {
    response = await fetch(base, { method: 'POST', headers, body: '{}' });
  } catch (error) {
    return {
      result: 'pending',
      message: `Cannot reach Google Play: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.ok) {
    // Clean up the probe edit; a leaked one would block none, but tidy is tidy.
    try {
      const edit = (await response.json()) as { id?: string };
      if (edit.id) {
        void fetch(`${base}/${edit.id}`, { method: 'DELETE', headers }).catch(() => undefined);
      }
    } catch {
      // The probe already answered; cleanup is best-effort.
    }
    return { result: 'ok' };
  }
  if (response.status === 401) {
    return { result: 'unauthorized' };
  }
  // Google reports a missing app as 404, and missing permission as 403;
  // both resolve the same way (create the app / get access), so they share
  // the pending state and the message carries the distinction.
  let message = `Google Play answered HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error body; the status line is the best we have.
  }
  return { result: 'pending', message };
}
