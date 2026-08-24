export interface ImprovementWorkflowIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class ImprovementWorkflowError extends Error {
  readonly issues: readonly ImprovementWorkflowIssue[];

  constructor(message: string, issues: readonly ImprovementWorkflowIssue[]) {
    super(message);
    this.name = "ImprovementWorkflowError";
    this.issues = Object.freeze([...issues]);
  }
}

export function improvementWorkflowIssue(
  code: string,
  path: string,
  message: string,
): ImprovementWorkflowIssue {
  return Object.freeze({ code, path, message });
}
