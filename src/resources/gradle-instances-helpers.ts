import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { GradleInstances as GeneratedGradleInstances, type GradleInstance } from './gradle-instances';
import { exec, type ExecChildProcess, type GradleBuildExecRequest } from '../exec-client';
import { syncFolder as syncFolderImpl, type FolderSyncOptions } from '../folder-sync';
import { createIgnoreFn } from '../folder-sync-ignore';
import {
  createDaemonLogger,
  mintAssetUploadUrls,
  type LogLevel,
  type SyncResult,
} from './daemon-client-shared';

export type GradleCreateClientParams = { logLevel?: LogLevel } & (
  | { instance: GradleInstance }
  | { apiUrl: string; token: string }
);

export type GradleSyncOptions = {
  /**
   * Directory for the client-side folder-sync cache.
   * Defaults to a temporary directory under the OS temp directory.
   */
  basisCacheDir?: string;
  /**
   * Optional predicate for ignoring files and directories during sync.
   * Called with the relative path from the sync root (using forward slashes).
   * For directories, the path ends with '/'.
   * Return true to ignore, false to keep.
   */
  ignore?: (relativePath: string) => boolean;
  /**
   * Optional predicate for force-including paths that would otherwise be
   * dropped. Same calling convention as `ignore`; return true to force-sync.
   */
  include?: (relativePath: string) => boolean;
};

export type GradleBuildOptions = {
  /** Gradle tasks to run. Omit for the server default (assembleDebug). */
  tasks?: string[];
  /** Relative path to the Gradle root when auto-discovery is ambiguous. */
  projectPath?: string;
  /** Upload the built APK as a named org asset, or to a presigned URL. */
  upload?: { assetName: string } | { signedUploadUrl: string };
  /** React Native / Expo tuning; see GradleBuildExecRequest.reactNative. */
  reactNative?: { expoAppDir?: string; architectures?: string[] };
};

export type GradleClient = {
  sync(localCodePath: string, opts?: GradleSyncOptions): Promise<SyncResult>;
  gradlebuild(options?: GradleBuildOptions): ExecChildProcess;
};

// Machine-local or regenerable files that must never reach the build
// sandbox: local.properties points at the developer's own SDK and would
// shadow the image's. Only ROOT-level cache/output dirs are defaulted;
// nested module build/ dirs are the project .gitignore's job (dropping any
// 'build' segment would silently exclude legitimate packages named build).
function gradleDefaultIgnore(relativePath: string): boolean {
  const trimmed = relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
  const segments = trimmed.split('/');
  if (segments[segments.length - 1] === 'local.properties') {
    return true;
  }
  return segments.length === 1 && (trimmed === '.gradle' || trimmed === '.kotlin' || trimmed === 'build');
}

export class GradleInstances extends GeneratedGradleInstances {
  async createClient(params: GradleCreateClientParams): Promise<GradleClient> {
    let apiUrl: string;
    let token: string;
    if ('instance' in params) {
      if (!params.instance.status.apiUrl) {
        throw new Error('Instance not ready: apiUrl is not available');
      }
      apiUrl = params.instance.status.apiUrl;
      token = params.instance.status.token;
    } else {
      apiUrl = params.apiUrl;
      token = params.token;
    }

    const log = createDaemonLogger('[GradleInstance]', params.logLevel ?? 'info');
    const client = this._client;

    return {
      async sync(localCodePath: string, opts?: GradleSyncOptions): Promise<SyncResult> {
        const resolvedPath = path.resolve(localCodePath);
        const folderName = path.basename(resolvedPath);
        const hash = crypto.createHash('sha1').update(resolvedPath).digest('hex').slice(0, 8);
        const cacheKey = `limsync-cache-${folderName}-${hash}`;
        const basisCacheDir = opts?.basisCacheDir ?? path.join(os.tmpdir(), cacheKey);
        const userIgnore = opts?.ignore;
        const codeSyncOpts: FolderSyncOptions = {
          apiUrl,
          token,
          udid: cacheKey,
          install: false,
          ignoreFn: await createIgnoreFn(localCodePath, {
            basisCacheDir,
            log,
            xcodeDefaults: false,
            // Honor nested module .gitignore files (app/.gitignore's /build,
            // etc.); gradleDefaultIgnore only covers root-level build/.gradle/
            // .kotlin, so without this a locally-built project would sync its
            // nested build/ artifact trees.
            nestedGitignore: true,
            additional: userIgnore ? (p) => gradleDefaultIgnore(p) || userIgnore(p) : gradleDefaultIgnore,
            ...(opts?.include ? { include: opts.include } : {}),
          }),
          basisCacheDir,
          // Gradle builds are one-shot; no dev-loop watch like xcode.
          watch: false,
          launchMode: 'ForegroundIfRunning',
          log,
          syncSymlinks: true,
        };

        const result = await syncFolderImpl(localCodePath, codeSyncOpts);
        const out: SyncResult = {};
        if (result.bytesSent !== undefined) {
          out.bytesSent = result.bytesSent;
        }
        return out;
      },

      gradlebuild(options?: GradleBuildOptions): ExecChildProcess {
        const request: GradleBuildExecRequest = {
          command: 'gradlebuild',
          ...(options?.tasks && { tasks: options.tasks }),
          ...(options?.projectPath && { projectPath: options.projectPath }),
          ...(options?.reactNative && { reactNative: options.reactNative }),
        };

        if (options?.upload && 'assetName' in options.upload) {
          const requestPromise = mintAssetUploadUrls(client.assets, options.upload.assetName).then(
            (asset) => {
              request.signedUploadUrl = asset.signedUploadUrl;
              request.additionalMetadata = { signedDownloadUrl: asset.signedDownloadUrl };
              return request;
            },
          );
          return exec(requestPromise, { apiUrl, token, log });
        }

        if (options?.upload && 'signedUploadUrl' in options.upload) {
          request.signedUploadUrl = options.upload.signedUploadUrl;
        }

        return exec(request, { apiUrl, token, log });
      },
    };
  }
}
