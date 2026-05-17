import { useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useDeviceInstall, type UseDeviceInstallOptions } from '../../hooks/use-device-install';
import type { DeviceInstallStep, DeviceInstallStepStatus } from '../../core/device-install';
import './device-install-dialog.css';

export type DeviceInstallDialogProps = UseDeviceInstallOptions & {
  disabled?: boolean;
};

const steps: Array<{ id: DeviceInstallStep; title: string; description: string }> = [
  {
    id: 'build',
    title: 'Start a device build',
    description: 'Upload signing assets if needed, then follow the live build logs until the device build succeeds.',
  },
  {
    id: 'usb',
    title: 'Access USB procedures',
    description: 'Allow WebUSB access to the connected iPhone from a Chromium browser on a secure origin.',
  },
  {
    id: 'pair',
    title: 'Pair with this browser',
    description: 'Pair once and store the pair record locally so future installs can reuse it.',
  },
  {
    id: 'install',
    title: 'Start installation',
    description: 'Relay the last successful device build to the paired iPhone.',
  },
];

export function DeviceInstallDialog({
  disabled,
  ...hookOptions
}: DeviceInstallDialogProps) {
  const [open, setOpen] = useState(false);
  const dialogTitleId = useId();
  const deviceInstall = useDeviceInstall(hookOptions);

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
                <p>Follow each step to build, authorize USB, pair, and install from this browser.</p>
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
                  status={deviceInstall.stepStatuses[step.id]}
                >
                  {step.id === 'build' && (
                    <div className="lr-device-install__step-body">
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
                          <span>.p12 password</span>
                          <input
                            type="password"
                            placeholder="Export password"
                            onChange={(event) =>
                              deviceInstall.setSigningFiles({ certificatePassword: event.currentTarget.value })
                            }
                          />
                        </label>
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

                  {step.id === 'usb' && (
                    <div className="lr-device-install__step-body">
                      <p>
                        WebUSB works in Chromium browsers on secure origins. Connect the iPhone over USB and approve
                        the browser permission prompt.
                      </p>
                      <button
                        type="button"
                        className="lr-device-install__primary"
                        disabled={disabled || !deviceInstall.canRequestUSBAccess}
                        onClick={() => void deviceInstall.requestUSBAccess()}
                      >
                        {deviceInstall.busyAction === 'usb' ? 'Selecting iPhone...' : 'Allow USB access'}
                      </button>
                      {deviceInstall.device && (
                        <div className="lr-device-install__device">
                          {`${deviceInstall.device.productName ?? 'iPhone'} ${
                            deviceInstall.device.serialNumber ?? ''
                          }`.trim()}
                        </div>
                      )}
                    </div>
                  )}

                  {step.id === 'pair' && (
                    <div className="lr-device-install__step-body">
                      {deviceInstall.pairConfirmationRequired && (
                        <p>
                          Unlock the iPhone and tap <strong>Trust</strong> in the system dialog, then confirm the pair
                          record.
                        </p>
                      )}
                      <button
                        type="button"
                        className="lr-device-install__primary"
                        disabled={disabled || !deviceInstall.canPairBrowser}
                        onClick={() => void deviceInstall.pairBrowser()}
                      >
                        {deviceInstall.busyAction === 'pair'
                          ? 'Pairing...'
                          : deviceInstall.pairConfirmationRequired
                            ? 'Confirm pair record'
                            : 'Pair browser'}
                      </button>
                      <p>
                        {deviceInstall.hasPairRecord
                          ? 'Pair record is stored locally. Installation is available.'
                          : 'Pair this browser once before installing.'}
                      </p>
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
  status,
  children,
}: {
  index: number;
  step: { id: DeviceInstallStep; title: string; description: string };
  active: boolean;
  status: DeviceInstallStepStatus;
  children: ReactNode;
}) {
  return (
    <article className={clsx('lr-device-install__step', active && 'lr-device-install__step--active')}>
      <div className="lr-device-install__step-header">
        <div className="lr-device-install__step-number">{index}</div>
        <div>
          <h3>{step.title}</h3>
          <p>{step.description}</p>
        </div>
        <span className={clsx('lr-device-install__status', `lr-device-install__status--${status}`)}>{status}</span>
      </div>
      {children}
    </article>
  );
}
