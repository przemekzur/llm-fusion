export class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function fail(message, exitCode = 2) {
  throw new CliError(message, exitCode);
}
