import { Flags } from '@oclif/core';
import path from 'path';
import {
  DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
  DESTINATION_TUNNEL_MAX_BODY_BYTES,
  DESTINATION_TUNNEL_MAX_TTL_SECONDS,
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
  inspect: boolean;
  persist?: boolean;
  ttlSeconds?: number;
  harPath?: string;
  harBodyLimit: number;
};

/** Rejects flag combinations oclif cannot express; --ttl needs --persist via dependsOn. */
export function validateTunnelInspectionFlags(flags: TunnelInspectionFlags): void {
  if (flags.har && !flags.inspect && !flags.persist) {
    throw new Error('--har cannot be combined with --no-inspect.');
  }
}

/** Maps the parsed flags onto the tunnel context; --persist implies inspection. */
export function tunnelInspectionContext(flags: TunnelInspectionFlags): TunnelInspectionContext {
  return {
    inspect: flags.inspect || flags.persist,
    persist: flags.persist,
    ...(flags.ttl === undefined ? {} : { ttlSeconds: flags.ttl }),
    ...(flags.har ? { harPath: path.resolve(flags.har) } : {}),
    harBodyLimit: flags['har-body-limit'],
  };
}
