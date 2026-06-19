import type { Sandbox } from '../types';
import { codeBlock, dangerButton, infoBox, primaryButton, warnBox } from '../theme';
import { Section } from './Section';

type Props = {
  sandbox?: Sandbox;
  provisioning: boolean;
  stopping: boolean;
  onCreate: () => void;
  onStop: () => void;
};

/**
 * Step 1 — provision an Xcode build sandbox via the backend. Once it's ready we
 * remind the user to sync their project into *this* instance (`--id`), since a
 * build runs against whatever source has been synced.
 */
export function SandboxStep({ sandbox, provisioning, stopping, onCreate, onStop }: Props) {
  return (
    <Section title="Build sandbox">
      {!sandbox ?
        <button style={primaryButton(provisioning)} onClick={onCreate} disabled={provisioning}>
          {provisioning ? 'Provisioning...' : 'Create Xcode sandbox'}
        </button>
      : <>
          <div style={infoBox}>
            Sandbox <code>{sandbox.id}</code> ready.
          </div>
          <div style={warnBox}>
            Now sync your project into <strong>this</strong> sandbox before building, otherwise the build
            returns <code>no synced folder found</code>. Pass <code>--id</code> so it targets the right
            instance:
            <pre style={codeBlock}>lim xcode sync . --id {sandbox.id}</pre>
            Run it from your project root (or build directly with{' '}
            <code>lim xcode build . --id {sandbox.id}</code>).
          </div>
          <button style={dangerButton(stopping)} onClick={onStop} disabled={stopping}>
            {stopping ? 'Stopping...' : 'Stop sandbox'}
          </button>
        </>
      }
    </Section>
  );
}
