// One structured logger for the function: every line is a single JSON object
// with level, event, correlationId, action and status. Request bodies are never
// passed in, and any field whose name suggests a credential is dropped, so
// passwords and tokens cannot reach the function log.

export type LogLevel = 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = { correlationId?: string; status?: number } & Record<string, LogValue>;

export interface Logger {
  readonly action: string | null;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  withAction(action: string): Logger;
}

type Sink = Pick<Console, 'log' | 'warn' | 'error'>;

const SENSITIVE_FIELD = /password|token|secret|authorization|apikey|body/i;

export function createLogger(action: string | null = null, sink: Sink = console): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const { correlationId, status, ...rest } = fields;
    const extra: Record<string, LogValue> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (!SENSITIVE_FIELD.test(key)) extra[key] = value;
    }
    const line = JSON.stringify({
      level,
      event,
      correlationId: correlationId ?? null,
      action,
      status: status ?? null,
      ...extra,
    });
    if (level === 'error') sink.error(line);
    else if (level === 'warn') sink.warn(line);
    else sink.log(line);
  };
  return {
    action,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    withAction: (next) => createLogger(next, sink),
  };
}
