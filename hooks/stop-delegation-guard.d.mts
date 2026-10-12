export function extractAgentName(content: unknown): string | undefined;
export function collectInvokedAgents(transcript: string): string[];
export function collectCompletedAgents(transcript: string): string[];
export function computeMissing(required: string[], invoked: string[]): string[];
export function buildBlockReason(missing: string[]): string;
export function readState(stateFile: string): { fired: number; blocks: number };
