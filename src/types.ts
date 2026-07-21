export type Mode = 'auto' | 'plan' | 'spec' | 'code' | 'repo';
export type EffectiveMode = Exclude<Mode, 'auto'>;

export interface ReviewArgs {
  mode: Mode;
  file?: string;
  base?: string;
  focus?: string;
  deep: boolean;
  raw: boolean;
  keepBundle: boolean;
  help: boolean;
}

export class ReviewError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const LIMITS = {
  focus: 2_000,
  context: 40_000,
  message: 16_000,
  patch: 250_000,
  bundle: 500_000,
  timeout: 900_000,
  artifactBytes: 200_000,
  repoSnapshot: 180_000,
  repoFile: 40_000,
  repoEntries: 1_000,
  repoDepth: 12,
};
