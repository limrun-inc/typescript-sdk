import { useState } from 'react';
import { requestUSBAccess } from '@limrun/device-install';
import type { ConnectController } from '../hooks/useConnect';
import { errorMessage } from '../lib/backend';
import { hintText, infoBox, inputStyle, labelStyle, primaryButton, secondaryButton, warnBox } from '../theme';
import { Section } from './Section';

/**
 * Stage 2: pick the target iPhone. Devices covered by a stored ad-hoc
 * profile can be continued with directly — no cable, no Apple session.
 * WebUSB is used only to read a newly plugged-in iPhone's UDID (its USB
 * serial number) so it can be registered on the portal and added to an
 * ad-hoc profile; there is no pairing.
 */
export function DevicesPhase({ connect }: { connect: ConnectController }) {
  const [usbBusy, setUsbBusy] = useState(false);
  const [usbError, setUsbError] = useState<string>();
  const [chosenUDID, setChosenUDID] = useState<string>();

  if (!connect.connection) {
    return (
      <Section title="2. Target iPhone">
        <p style={hintText}>Locked. Complete the signing setup first.</p>
      </Section>
    );
  }

  const chosen = connect.devices.find((device) => device.udid === chosenUDID);
  const preparing = connect.busy === 'device-enrollment' || connect.deviceEnrollment.status === 'checking';

  async function registerNewViaUSB() {
    setUsbError(undefined);
    setUsbBusy(true);
    try {
      // requestUSBAccess only opens the browser's device picker and reads
      // the USB descriptor; the UDID is the serial number. No pairing, no
      // relay session.
      const target = await requestUSBAccess();
      const udid = target.hello.serialNumber;
      if (!udid) throw new Error('The selected device did not report a serial number.');
      setChosenUDID(udid.replace(/[^a-fA-F0-9]/g, '').toUpperCase());
      await connect.prepareDevice(udid, target.hello.productName ?? 'iPhone');
    } catch (error) {
      setUsbError(errorMessage(error, 'Could not read the iPhone over WebUSB'));
    } finally {
      setUsbBusy(false);
    }
  }

  return (
    <Section title="2. Target iPhone">
      {connect.devices.length > 0 ?
        <>
          <label style={labelStyle}>Registered devices</label>
          <select
            style={inputStyle}
            value={chosenUDID ?? connect.selectedDevice?.udid ?? ''}
            onChange={(event) => setChosenUDID(event.target.value || undefined)}
            disabled={preparing}
          >
            <option value="">Select a device…</option>
            {connect.devices.map((device) => (
              <option key={device.udid} value={device.udid}>
                {device.name ? `${device.name} — ` : ''}
                {device.udid}
                {device.covered ? '' : ' (not in the ad-hoc profile yet)'}
              </option>
            ))}
          </select>
          <button
            style={primaryButton(!chosen || preparing)}
            disabled={!chosen || preparing}
            onClick={() => {
              if (!chosen) return;
              if (chosen.covered) {
                connect.selectDevice(chosen);
              } else {
                // Extending coverage to a portal-registered device needs an
                // Apple session; prepareDevice flags needs-login otherwise.
                void connect.prepareDevice(chosen.udid, chosen.name ?? 'iPhone');
              }
            }}
          >
            {preparing ?
              'Preparing ad-hoc signing…'
            : chosen && !chosen.covered ?
              'Add to ad-hoc profile and continue'
            : 'Continue with this device'}
          </button>
        </>
      : <p style={hintText}>
          No registered devices found in the stored profiles
          {connect.loggedIn ? ' or on the Developer Portal' : ''}. Register one below.
        </p>
      }

      <button
        style={secondaryButton(usbBusy || preparing)}
        disabled={usbBusy || preparing}
        onClick={() => void registerNewViaUSB()}
      >
        {usbBusy ? 'Opening device picker…' : 'Register a new iPhone via USB'}
      </button>
      <p style={hintText}>
        Reads the plugged-in iPhone&apos;s UDID over WebUSB and registers it with Apple. Registration requires
        an Apple sign-in; installation later happens entirely over the QR page.
      </p>
      {usbError && <div style={warnBox}>{usbError}</div>}
      {connect.deviceEnrollment.note && connect.deviceEnrollment.status !== 'idle' && (
        <div
          style={
            connect.deviceEnrollment.status === 'error' || connect.deviceEnrollment.status === 'needs-login' ?
              warnBox
            : infoBox
          }
        >
          {connect.deviceEnrollment.note}
        </div>
      )}
      {connect.selectedDevice?.covered && (
        <div style={infoBox}>
          Target: {connect.selectedDevice.name ? `${connect.selectedDevice.name} — ` : ''}
          {connect.selectedDevice.udid}
        </div>
      )}
    </Section>
  );
}
