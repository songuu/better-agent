export interface WorkspacePackage {
  directory: string;
  manifest: Record<string, unknown> & {
    name?: unknown;
  };
}

export function validateWorkspaceGraph(workspacePackages: WorkspacePackage[]): string[];
