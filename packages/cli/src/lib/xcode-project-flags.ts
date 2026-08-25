import { Flags } from '@oclif/core';
import type { XcodeGenConfig, XcodeProjectConfig } from '@limrun/api';

/** Project-selection flags shared by the xcodebuild-backed commands. */
export const xcodeProjectFlags = {
  scheme: Flags.string({ description: 'Xcode scheme to build, such as MyApp' }),
  workspace: Flags.string({
    description: 'Workspace file to pass to xcodebuild, such as MyApp.xcworkspace',
  }),
  project: Flags.string({ description: 'Project file to pass to xcodebuild, such as MyApp.xcodeproj' }),
  configuration: Flags.string({
    description: 'Xcode build configuration.',
    options: ['Debug', 'Release'],
  }),
  'xcodegen-spec': Flags.string({
    description:
      'XcodeGen project spec path relative to the synced folder root, like `xcodegen generate --spec`. Forces server-side generation with the bundled XcodeGen. Omit to use project.yml at the root.',
  }),
  'xcodegen-project': Flags.string({
    description:
      "Directory (relative to the synced folder root) the Xcode project is generated into, like `xcodegen generate --project`. Forces server-side generation. Defaults to the spec file's directory.",
  }),
  'xcodegen-project-root': Flags.string({
    description:
      "Project root directory (relative to the synced folder root) that relative paths in the spec resolve against, like `xcodegen generate --project-root`. Forces server-side generation. Defaults to the spec file's directory.",
  }),
};

/** Maps the shared project-selection flags onto the request's xcodebuild object. */
export function projectConfigFromFlags(flags: {
  scheme?: string;
  workspace?: string;
  project?: string;
  configuration?: string;
}): Partial<XcodeProjectConfig> {
  return {
    ...(flags.scheme && { scheme: flags.scheme }),
    ...(flags.workspace && { workspace: flags.workspace }),
    ...(flags.project && { project: flags.project }),
    ...(flags.configuration && { configuration: flags.configuration as 'Debug' | 'Release' }),
  };
}

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
