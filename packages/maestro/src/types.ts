import type { InstanceClient } from '@limrun/api/ios-client';

export type MaestroRunnerAsset = {
  name: string;
  signedDownloadUrl?: string;
};

export type MaestroIosInstance = {
  metadata: {
    id: string;
  };
  status: {
    apiUrl?: string;
    token: string;
    signedStreamUrl?: string;
    targetHttpPortUrlPrefix?: string;
  };
};

export type LimrunMaestroApi = {
  assets: {
    list: (query: {
      includeAppStore?: boolean;
      includeDownloadUrl?: boolean;
      nameFilter?: string;
    }) => Promise<MaestroRunnerAsset[]>;
    getOrUpload?: (body: { path: string; name?: string }) => Promise<MaestroRunnerAsset>;
  };
  iosInstances: {
    create: (body: any) => Promise<MaestroIosInstance>;
    delete: (id: string) => Promise<unknown>;
  };
};

export type LimrunMaestroClient = InstanceClient;

export type PreparedMaestroRun = {
  instance: MaestroIosInstance;
  client: LimrunMaestroClient;
  udid: string;
  maestroBin: string;
  maestroVersion: string;
  runnerAssetName: string;
  driverPort: number;
  runnerPort: number;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
};

export type PrepareMaestroRunOptions = {
  limrun: LimrunMaestroApi;
  instance: MaestroIosInstance;
  client?: LimrunMaestroClient;
  maestroBin?: string;
  maestroVersion?: string;
  driverPort?: number;
  runnerPort?: number;
  cwd?: string;
};

export type RunMaestroTestOptions = {
  prepared: PreparedMaestroRun;
  flowPath?: string;
  flowPaths?: string[];
  outputDir?: string;
  env?: Record<string, string>;
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
};

export type RunMaestroTestResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type RunMaestroOnLimrunOptions = {
  apiKey?: string;
  limrun?: LimrunMaestroApi;
  maestroBin?: string;
  maestroVersion?: string;
  flowPath?: string;
  flowPaths?: string[];
  outputDir?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  keepInstance?: boolean;
  reuseIfExists?: boolean;
  displayName?: string;
  labels?: Record<string, string>;
  region?: string;
  model?: 'iphone' | 'ipad' | 'watch';
  initialAssets?: string[];
};

export type RunMaestroOnLimrunResult = RunMaestroTestResult & {
  instance: MaestroIosInstance;
  keptInstance: boolean;
};

export type SimctlResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ProxyServer = {
  port: number;
  close: () => Promise<void>;
};

export type ShimServer = {
  url: string;
  close: () => Promise<void>;
};
