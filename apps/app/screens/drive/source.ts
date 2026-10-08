// The Drive screen's call shape: the app's box connection, or a fake box in a test. The Space's own Drive is its only source (space-source.ts); the box's shared folders went with VyreDrive.
export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
