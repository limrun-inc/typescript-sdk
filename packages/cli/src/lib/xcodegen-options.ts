import type { XcodeGenConfig } from '@limrun/api';

/** Maps the shared xcodegen flags onto the request's xcodegen object. */
export function xcodegenConfigFromFlags(flags: {
  'xcodegen-spec'?: string;
  'xcodegen-project'?: string;
  'xcodegen-project-root'?: string;
}): XcodeGenConfig | undefined {
  if (!flags['xcodegen-spec'] && !flags['xcodegen-project'] && !flags['xcodegen-project-root']) {
    return undefined;
  }
  return {
    ...(flags['xcodegen-spec'] && { spec: flags['xcodegen-spec'] }),
    ...(flags['xcodegen-project'] && { project: flags['xcodegen-project'] }),
    ...(flags['xcodegen-project-root'] && { projectRoot: flags['xcodegen-project-root'] }),
  };
}
