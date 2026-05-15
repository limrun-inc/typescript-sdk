export type ElementTreeNode = {
  AXLabel?: string | null;
  AXUniqueId?: string | null;
  AXValue?: string | null;
  children?: ElementTreeNode[];
  enabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  role?: string;
  role_description?: string;
  selected?: boolean;
  title?: string | null;
  traits?: string[];
  type?: string;
};

export type MaestroTreeNode = {
  attributes: Record<string, string>;
  children: MaestroTreeNode[];
  clickable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
};

export type JsonRecord = Record<string, unknown>;

export type RunOptions = {
  apiUrl: string;
  artifactsDir: string;
  flowPath: string;
  token: string;
  timeoutMs?: number;
};
