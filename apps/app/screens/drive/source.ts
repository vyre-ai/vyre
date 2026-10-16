// The call the Drive screens share: the app's box connection, or a fake box in a test. Each Drive source (space-source.ts, linked-source.ts) is made over one.
export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
