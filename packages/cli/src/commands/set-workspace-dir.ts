import path from 'path';
import { Args, Command, Flags } from '@oclif/core';
import { assignWorkspaceDir, normalizeDir, unassignWorkspaceDir } from '../lib/workspace';

export default class SetWorkspaceDir extends Command {
  static summary = 'Assign a directory to an isolated lim workspace.';
  static description = `Bind a directory to a named workspace so that 'lim' commands run from it (and its subdirectories) share one set of "most recent" instances — even when the directory is not a git repo or worktree.

Inside a git repo, lim already isolates by the repo/worktree root automatically. Use this to give a plain directory its own isolated workspace, or to deliberately share one workspace across directories by assigning them the same name.

The assignment governs the directory and everything beneath it, except a nested git worktree or clone whose root is deeper than the assignment, which keeps its own isolated workspace (the most specific boundary wins).`;

  static examples = [
    '<%= config.bin %> set-workspace-dir my-agent',
    '<%= config.bin %> set-workspace-dir shared-pool --dir ./service-a',
    '<%= config.bin %> set-workspace-dir --clear',
  ];

  static args = {
    name: Args.string({
      description: 'Workspace name to assign. Directories sharing a name share one workspace.',
      required: false,
    }),
  };

  static flags = {
    dir: Flags.string({
      description: 'Directory to assign (defaults to the current directory).',
    }),
    clear: Flags.boolean({
      description: 'Remove the workspace assignment for the directory instead of setting it.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SetWorkspaceDir);
    const dir = flags.dir ? path.resolve(flags.dir) : process.cwd();
    const normalized = normalizeDir(dir);

    if (flags.clear) {
      const removed = unassignWorkspaceDir(dir);
      this.log(
        removed ?
          `Removed workspace assignment for ${normalized}.`
        : `No workspace assignment found for ${normalized}.`,
      );
      return;
    }

    const name = args.name?.trim();
    if (!name) {
      this.error('Provide a workspace name, or pass --clear to remove an existing assignment.');
    }
    if (name.startsWith('__lim_')) {
      this.error('Workspace names starting with "__lim_" are reserved for internal use.');
    }

    assignWorkspaceDir(dir, name);
    this.log(`Assigned ${normalized} to workspace "${name}".`);
    this.log(`lim commands run from here (and its subdirectories) now share the "${name}" workspace.`);
  }
}
