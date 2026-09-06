export class ForgeFlowError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message = code, details?: unknown) {
    super(message);
    this.name = 'ForgeFlowError';
    this.code = code;
    this.details = details;
  }
}

export class InvalidTransitionError extends ForgeFlowError {
  constructor(entity: string, from: string, to: string) {
    super('INVALID_STATE_TRANSITION', entity + ': ' + from + ' -> ' + to);
  }
}

export class StaleStateError extends ForgeFlowError {
  constructor(message = 'Durable state is stale') {
    super('STALE_STATE', message);
  }
}

export class DuplicateKeyError extends ForgeFlowError {
  constructor(key: string) {
    super('DUPLICATE_KEY', 'Duplicate durable key: ' + key);
  }
}

export class DataResetRequiredError extends ForgeFlowError {
  constructor(file: string) {
    super(
      'DATA_RESET_REQUIRED',
      'Existing incompatible database detected at ' + file +
        '. Set FORGEFLOW_ALLOW_DATA_RESET=true for an explicit destructive rebuild.',
    );
  }
}

export function assertNever(value: never): never {
  throw new ForgeFlowError('UNEXPECTED_VARIANT', 'Unexpected variant: ' + String(value));
}

export function failClosed(condition: unknown, code: string, message = code): asserts condition {
  if (!condition) throw new ForgeFlowError(code, message);
}
