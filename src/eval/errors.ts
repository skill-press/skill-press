export interface EvaluationInputIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class EvaluationInputError extends Error {
  readonly issues: readonly EvaluationInputIssue[];

  constructor(message: string, issues: readonly EvaluationInputIssue[], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EvaluationInputError";
    this.issues = Object.freeze([...issues]);
  }
}
