// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

export { Limrun as default } from './client';

export { type Uploadable, toFile } from './core/uploads';
export { APIPromise } from './core/api-promise';
export { Limrun, type ClientOptions } from './client';
export { PagePromise } from './core/pagination';
export * from './instance-client';
export * as Ios from './ios-client';
export { startHttpProxy, type HttpProxy, type StartHttpProxyOptions } from './http-proxy';
export { buildSettingKeyPattern, parseBuildSettingEntries, validateBuildSettings } from './build-settings';
export {
  exec,
  type ExecRequest,
  type ExecOptions,
  type ExecResult,
  type ExecChildProcess,
} from './exec-client';
export {
  type XcodeCreateClientParams,
  type XcodeClient,
  type RbeStatus,
  type RbeStartOptions,
  type RbeTunnelOptions,
  type Tunnel,
  deriveRbeTunnelUrl,
  type XcodeProjectConfig,
  type XcodeBuildOptions,
  type ReactNativeBuildConfig,
  type SimulatorAttachResult,
  type SimulatorStatus,
  type SimulatorBuildStatus,
  type SimulatorAttachment,
  type SimulatorDeviceInfo,
  type SimulatorInstallState,
} from './resources/xcode-instances-helpers';
export {
  LimrunError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  BadRequestError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  UnprocessableEntityError,
} from './core/error';
