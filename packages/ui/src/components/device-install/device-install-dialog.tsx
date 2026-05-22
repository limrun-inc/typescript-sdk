import { useEffect, useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useDeviceInstall, type UseDeviceInstallOptions } from '../../hooks/use-device-install';
import type { DeviceInstallStep, DeviceInstallStepStatus } from '../../core/device-install';
import './device-install-dialog.css';

export type DeviceInstallDialogProps = UseDeviceInstallOptions & {
  disabled?: boolean;
};

const steps: Array<{ id: DeviceInstallStep; title: string; description: string }> = [
  {
    id: 'signing',
    title: 'Prepare signing',
    description: 'Choose Apple ID login or upload certificates for a registered developer device.',
  },
  {
    id: 'build',
    title: 'Build for device',
    description: 'Start the signed iPhone build before connecting over USB.',
  },
  {
    id: 'connect',
    title: 'Connect and pair',
    description: 'After the build succeeds, connect the iPhone with WebUSB and pair this browser.',
  },
  {
    id: 'install',
    title: 'Start installation',
    description: 'Relay the last successful device build to the paired iPhone.',
  },
];

type SigningSection = 'apple-id' | 'upload';

export function DeviceInstallDialog({
  disabled,
  ...hookOptions
}: DeviceInstallDialogProps) {
  const [open, setOpen] = useState(false);
  const [openStep, setOpenStep] = useState<DeviceInstallStep>('signing');
  const [signingSection, setSigningSection] = useState<SigningSection>();
  const [appleAccountName, setAppleAccountName] = useState('');
  const [applePassword, setApplePassword] = useState('');
  const [appleTwoFactorCode, setAppleTwoFactorCode] = useState('');
  const dialogTitleId = useId();
  const deviceInstall = useDeviceInstall(hookOptions);

  useEffect(() => {
    setOpenStep(deviceInstall.currentStep);
  }, [deviceInstall.currentStep]);

  const updateSigningFiles = (field: 'certificateFile' | 'provisioningProfileFile', event: ChangeEvent<HTMLInputElement>) => {
    deviceInstall.setSigningFiles({
      [field]: event.currentTarget.files?.[0],
    });
  };

  return (
    <div className="lr-device-install">
      <button
        type="button"
        className="lr-device-install__trigger"
        disabled={disabled || !hookOptions.apiUrl}
        onClick={() => setOpen(true)}
      >
        Install to iPhone
      </button>

      {open && (
        <div className="lr-device-install__backdrop" role="presentation">
          <section
            aria-labelledby={dialogTitleId}
            aria-modal="true"
            className="lr-device-install__dialog"
            role="dialog"
          >
            <header className="lr-device-install__header">
              <div>
                <h2 id={dialogTitleId}>Install to a real iPhone</h2>
                <p>Prepare signing, build for the registered device, connect and pair, then install from this browser.</p>
              </div>
              <button type="button" className="lr-device-install__icon-button" onClick={() => setOpen(false)}>
                Close
              </button>
            </header>

            {deviceInstall.error && <div className="lr-device-install__error">{deviceInstall.error}</div>}

            <div className="lr-device-install__steps">
              {steps.map((step, index) => (
                <StepCard
                  key={step.id}
                  index={index + 1}
                  step={step}
                  active={deviceInstall.currentStep === step.id}
                  open={openStep === step.id}
                  status={deviceInstall.stepStatuses[step.id]}
                  onToggle={() => setOpenStep(step.id)}
                >
                  {step.id === 'signing' && (
                    <div className="lr-device-install__step-body">
                      <div className="lr-device-install__choice-grid">
                        <button
                          type="button"
                          className={clsx(
                            'lr-device-install__choice',
                            signingSection === 'apple-id' && 'lr-device-install__choice--active',
                          )}
                          onClick={() => setSigningSection('apple-id')}
                        >
                          <strong>Apple ID login</strong>
                          <span>Sign in, choose team, bundle ID, and registered devices, then generate signing assets.</span>
                        </button>
                        <button
                          type="button"
                          className={clsx(
                            'lr-device-install__choice',
                            signingSection === 'upload' && 'lr-device-install__choice--active',
                          )}
                          onClick={() => setSigningSection('upload')}
                        >
                          <strong>Upload certificates</strong>
                          <span>Use an existing .p12 certificate and provisioning profile.</span>
                        </button>
                      </div>

                      {signingSection === 'apple-id' && (
                        <div className="lr-device-install__section-panel">
                          <div className="lr-device-install__grid">
                            <label className="lr-device-install__field">
                              <span>Apple ID</span>
                              <input
                                type="email"
                                autoComplete="username"
                                placeholder="name@example.com"
                                value={appleAccountName}
                                onChange={(event) => setAppleAccountName(event.currentTarget.value)}
                              />
                            </label>
                            <label className="lr-device-install__field">
                              <span>Apple ID password</span>
                              <input
                                type="password"
                                autoComplete="current-password"
                                placeholder="Password stays in this browser"
                                value={applePassword}
                                onChange={(event) => setApplePassword(event.currentTarget.value)}
                              />
                            </label>
                            {!deviceInstall.hasReusableAppleCertificate && (
                              <label className="lr-device-install__field">
                                <span>Generated .p12 password</span>
                                <input
                                  type="password"
                                  placeholder="Used when exporting Apple certificate"
                                  onChange={(event) =>
                                    deviceInstall.setSigningFiles({ certificatePassword: event.currentTarget.value })
                                  }
                                />
                              </label>
                            )}
                          </div>
                          <div className="lr-device-install__actions">
                            <button
                              type="button"
                              className="lr-device-install__secondary"
                              disabled={
                                disabled ||
                                !hookOptions.apiUrl ||
                                !appleAccountName ||
                                !applePassword ||
                                deviceInstall.busyAction === 'signing'
                              }
                              onClick={() =>
                                void deviceInstall.startAppleIDLogin({
                                  accountName: appleAccountName,
                                  password: applePassword,
                                })
                              }
                            >
                              {deviceInstall.appleSigningStatus === 'authenticating'
                                ? 'Signing in...'
                                : 'Sign in with Apple ID'}
                            </button>
                            <span className="lr-device-install__hint">
                              Apple password is used only by browser-side SRP. Status: {deviceInstall.appleSigningStatus}
                            </span>
                          </div>
                          {deviceInstall.appleSigningStatus === 'two-factor-required' && (
                            <div className="lr-device-install__grid">
                              <label className="lr-device-install__field">
                                <span>Two-factor code</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  autoComplete="one-time-code"
                                  value={appleTwoFactorCode}
                                  onChange={(event) => setAppleTwoFactorCode(event.currentTarget.value)}
                                />
                              </label>
                              <button
                                type="button"
                                className="lr-device-install__secondary"
                                disabled={!appleTwoFactorCode || deviceInstall.busyAction === 'signing'}
                                onClick={() => void deviceInstall.submitAppleTwoFactorCode(appleTwoFactorCode)}
                              >
                                Submit Apple ID code
                              </button>
                            </div>
                          )}
                          {deviceInstall.appleTeams.length > 0 && (
                            <label className="lr-device-install__field">
                              <span>Apple Developer team</span>
                              <select
                                value={deviceInstall.selectedAppleTeamID ?? ''}
                                onChange={(event) =>
                                  deviceInstall.setSelectedAppleTeamID(event.currentTarget.value || undefined)
                                }
                              >
                                {deviceInstall.appleTeams.map((team, index) => {
                                  const teamID =
                                    team.teamId ??
                                    (team.providerId === undefined ? undefined : String(team.providerId)) ??
                                    team.publicProviderId ??
                                    '';
                                  return (
                                    <option key={`${teamID}-${index}`} value={teamID}>
                                      {team.name ?? 'Apple Developer Team'} {teamID ? `(${teamID})` : ''}
                                    </option>
                                  );
                                })}
                              </select>
                            </label>
                          )}
                          {deviceInstall.appleDevices.length > 0 && (
                            <label className="lr-device-install__field">
                              <span>Apple Developer devices</span>
                              <select
                                multiple
                                value={deviceInstall.selectedAppleDeviceIDs}
                                onChange={(event) =>
                                  deviceInstall.setSelectedAppleDeviceIDs(
                                    Array.from(event.currentTarget.selectedOptions).map((option) => option.value),
                                  )
                                }
                              >
                                {deviceInstall.appleDevices.map((appleDevice) => (
                                  <option
                                    key={appleDevice.deviceId ?? appleDevice.deviceNumber}
                                    value={appleDevice.deviceId ?? ''}
                                  >
                                    {appleDevice.name ?? appleDevice.model ?? 'Apple device'} {appleDevice.deviceNumber ?? ''}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {deviceInstall.applePortalSummary && (
                            <p className="lr-device-install__hint">
                              Found {deviceInstall.applePortalSummary.certificateCount} certificates and{' '}
                              {deviceInstall.applePortalSummary.profileCount} provisioning profiles.
                            </p>
                          )}
                          {deviceInstall.hasReusableAppleCertificate && (
                            <p className="lr-device-install__hint">
                              Reusing the certificate and private key stored in this browser.
                            </p>
                          )}
                          <button
                            type="button"
                            className="lr-device-install__primary"
                            disabled={disabled || !deviceInstall.canPrepareAppleSigningAssets}
                            onClick={() => void deviceInstall.prepareAppleSigningAssets()}
                          >
                            {deviceInstall.appleSigningStatus === 'preparing-assets'
                              ? 'Preparing signing assets...'
                              : 'Generate certificate and profile'}
                          </button>
                        </div>
                      )}

                      {signingSection === 'upload' && (
                        <div className="lr-device-install__section-panel">
                          <div className="lr-device-install__grid">
                            <label className="lr-device-install__field">
                              <span>Certificate (.p12)</span>
                              <input
                                type="file"
                                accept=".p12,application/x-pkcs12"
                                onChange={(event) => updateSigningFiles('certificateFile', event)}
                              />
                            </label>
                            <label className="lr-device-install__field">
                              <span>Provisioning profile</span>
                              <input
                                type="file"
                                accept=".mobileprovision"
                                onChange={(event) => updateSigningFiles('provisioningProfileFile', event)}
                              />
                            </label>
                            <label className="lr-device-install__field">
                              <span>Uploaded .p12 password</span>
                              <input
                                type="password"
                                placeholder="Export password"
                                onChange={(event) =>
                                  deviceInstall.setSigningFiles({ certificatePassword: event.currentTarget.value })
                                }
                              />
                            </label>
                          </div>
                          <p className="lr-device-install__hint">
                            The provisioning profile will be checked against the connected iPhone before installation.
                          </p>
                        </div>
                      )}

                      {deviceInstall.hasSigningAssets && (
                        <p>Signing assets are stored in this browser for the selected bundle and device.</p>
                      )}
                    </div>
                  )}

                  {step.id === 'connect' && (
                    <div className="lr-device-install__step-body">
                      <p>
                        WebUSB works in Chromium browsers on secure origins. Once the build succeeds, connect the iPhone
                        over USB, approve the browser permission prompt, then pair this browser.
                      </p>
                      <div className="lr-device-install__actions">
                        <button
                          type="button"
                          className="lr-device-install__primary"
                          disabled={disabled || !deviceInstall.canRequestUSBAccess}
                          onClick={() => void deviceInstall.requestUSBAccess()}
                        >
                          {deviceInstall.busyAction === 'usb' ? 'Selecting iPhone...' : 'Allow USB access'}
                        </button>
                        <button
                          type="button"
                          className="lr-device-install__secondary"
                          disabled={disabled || !deviceInstall.canPairBrowser}
                          onClick={() => void deviceInstall.pairBrowser()}
                        >
                          {deviceInstall.busyAction === 'pair'
                            ? 'Pairing...'
                            : deviceInstall.pairConfirmationRequired
                              ? 'Confirm pair record'
                              : 'Pair browser'}
                        </button>
                      </div>
                      {deviceInstall.device && (
                        <div className="lr-device-install__device">
                          {`${deviceInstall.device.productName ?? 'iPhone'} ${
                            deviceInstall.device.serialNumber ?? ''
                          }`.trim()}
                        </div>
                      )}
                      {deviceInstall.pairConfirmationRequired && (
                        <p>
                          Unlock the iPhone and tap <strong>Trust</strong> in the system dialog, then confirm the pair
                          record.
                        </p>
                      )}
                      <p>
                        {deviceInstall.hasPairRecord
                          ? 'Pair record is stored locally. Continue to installation.'
                          : 'Pair this browser once before installing.'}
                      </p>
                    </div>
                  )}

                  {step.id === 'build' && (
                    <div className="lr-device-install__step-body">
                      <div className="lr-device-install__checklist">
                        <StatusLine label="Signing assets" ready={deviceInstall.hasSigningInputs} />
                        <StatusLine label="Device build" ready={deviceInstall.buildStatus === 'succeeded' ? true : undefined} pendingText="Not started" />
                      </div>
                      <button
                        type="button"
                        className="lr-device-install__primary"
                        disabled={disabled || !deviceInstall.canBuild}
                        onClick={() => void deviceInstall.startDeviceBuild()}
                      >
                        {deviceInstall.busyAction === 'build' ? 'Starting build...' : 'Start device build'}
                      </button>
                      <details
                        className="lr-device-install__build-logs"
                        open={deviceInstall.buildLogPanelOpen}
                        onToggle={(event) => deviceInstall.setBuildLogPanelOpen(event.currentTarget.open)}
                      >
                        <summary>Build logs ({deviceInstall.buildStatus})</summary>
                        <pre>
                          {deviceInstall.buildLogs.length > 0
                            ? deviceInstall.buildLogs
                                .filter((line) => line.type !== 'meta')
                                .map((line) => line.data)
                                .join('\n')
                            : 'Build logs will appear here while the device build is running.'}
                        </pre>
                      </details>
                    </div>
                  )}

                  {step.id === 'install' && (
                    <div className="lr-device-install__step-body">
                      <button
                        type="button"
                        className="lr-device-install__primary"
                        disabled={disabled || !deviceInstall.canInstall}
                        onClick={() => void deviceInstall.startInstallation()}
                      >
                        {deviceInstall.busyAction === 'install' ? 'Installing...' : 'Install last build'}
                      </button>
                      <button type="button" className="lr-device-install__secondary" onClick={deviceInstall.stopRelay}>
                        Stop relay
                      </button>
                    </div>
                  )}
                </StepCard>
              ))}
            </div>

            <footer className="lr-device-install__logs">
              <h3>Progress</h3>
              <ol>
                {deviceInstall.logs.map((entry, index) => (
                  <li key={`${index}-${entry.slice(0, 24)}`}>{entry}</li>
                ))}
              </ol>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function StepCard({
  index,
  step,
  active,
  open,
  status,
  onToggle,
  children,
}: {
  index: number;
  step: { id: DeviceInstallStep; title: string; description: string };
  active: boolean;
  open: boolean;
  status: DeviceInstallStepStatus;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <article className={clsx('lr-device-install__step', active && 'lr-device-install__step--active')}>
      <button
        type="button"
        className="lr-device-install__step-header"
        aria-expanded={open}
        onClick={onToggle}
      >
        <div className="lr-device-install__step-number">{index}</div>
        <div>
          <h3>{step.title}</h3>
          <p>{step.description}</p>
        </div>
        <span className={clsx('lr-device-install__status', `lr-device-install__status--${status}`)}>
          {status === 'complete' ? '✓ Completed' : status}
        </span>
      </button>
      {open && children}
    </article>
  );
}

function StatusLine({
  label,
  ready,
  pendingText = 'Not ready',
}: {
  label: string;
  ready?: boolean;
  pendingText?: string;
}) {
  const text = ready === undefined ? pendingText : ready ? 'Ready' : 'Needs attention';
  return (
    <div className="lr-device-install__check-row">
      <span>{label}</span>
      <strong>{text}</strong>
    </div>
  );
}
