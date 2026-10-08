import { Flags } from '@oclif/core';
import path from 'path';
import {
  DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
  DESTINATION_TUNNEL_DEFAULT_TTL_SECONDS,
  DESTINATION_TUNNEL_MAX_BODY_BYTES,
  DESTINATION_TUNNEL_MAX_TTL_SECONDS,
  type DestinationTunnelInspectionConfig,
} from '@limrun/api';

/** HTTP inspection flags shared by `android tunnel` and `ios tunnel`. */
export const tunnelInspectionFlags = {
  inspect: Flags.boolean({
    description: 'Print one HTTP summary per completed request. Use --no-inspect to disable inspection.',
    default: true,
    allowNo: true,
  }),
  har: Flags.string({
    description: 'Capture inspected HTTP traffic as HAR 1.2 at this path.',
  }),
  persist: Flags.boolean({
    description: 'Persist a body-inclusive network log as a session artifact.',
    default: false,
  }),
  ttl: Flags.integer({
    description: 'Persisted network-log lifetime in seconds (default 259200; maximum 2592000).',
    min: 1,
    max: DESTINATION_TUNNEL_MAX_TTL_SECONDS,
    dependsOn: ['persist'],
  }),
  'har-body-limit': Flags.integer({
    description: 'Maximum captured bytes per request or response body.',
    default: DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
    min: 1,
    max: DESTINATION_TUNNEL_MAX_BODY_BYTES,
  }),
};

export type TunnelInspectionFlags = {
  inspect: boolean;
  har?: string;
  persist: boolean;
  ttl?: number;
  'har-body-limit': number;
};

export type TunnelInspectionContext = {
  /** Whether HTTP inspection is negotiated for each generation. */
  inspect: boolean;
  /** Persist the completed network log as a session artifact. */
  persist?: boolean;
  /** Persisted network-log lifetime in seconds. */
  ttlSeconds?: number;
  /** Optional HAR destination; file IO remains in the CLI layer. */
  harPath?: string;
  /** Maximum captured bytes for each request and response body. */
  harBodyLimit: number;
};

/**
 * Rejects flag combinations oclif cannot express. dependsOn alone does not
 * catch --ttl without --persist, because persist defaults to false.
 */
function validateTunnelInspectionFlags(flags: TunnelInspectionFlags): void {
  if (flags.har && !flags.inspect && !flags.persist) {
    throw new Error('--har cannot be combined with --no-inspect.');
  }
  if (flags.ttl !== undefined && !flags.persist) {
    throw new Error('--ttl is only valid with --persist.');
  }
}

/**
 * Validates the parsed flags and maps them onto the tunnel context; --persist
 * implies inspection.
 */
export function tunnelInspectionContext(flags: TunnelInspectionFlags): TunnelInspectionContext {
  validateTunnelInspectionFlags(flags);
  return {
    inspect: flags.inspect || flags.persist,
    persist: flags.persist,
    ...(flags.ttl === undefined ? {} : { ttlSeconds: flags.ttl }),
    ...(flags.har ? { harPath: path.resolve(flags.har) } : {}),
    harBodyLimit: flags['har-body-limit'],
  };
}

/** The inspection a tunnel negotiates; bodies are kept only for a HAR file or the persisted log. */
export function tunnelInspectionConfig(context: TunnelInspectionContext): DestinationTunnelInspectionConfig {
  return {
    enabled: context.inspect,
    captureBodies: context.inspect && (context.harPath !== undefined || context.persist === true),
    maxBodyBytes: context.harBodyLimit ?? DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
    persist: context.persist ?? false,
    ttlSeconds: context.ttlSeconds ?? DESTINATION_TUNNEL_DEFAULT_TTL_SECONDS,
  };
}
