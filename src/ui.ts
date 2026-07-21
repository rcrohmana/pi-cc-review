import type { ReviewProgressState } from './progress.ts';

export interface ReviewProgressView {
  readonly signal: AbortSignal;
  update(state: ReviewProgressState): void;
  setCancelling(): void;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
  onAbort?: () => void;
}

const phases: Record<ReviewProgressState['phase'], string> = {
  starting: 'Starting Claude Code…',
  delegating: 'Invoking native reviewers',
  synthesizing: 'Reconciling reviewer evidence',
  validating: 'Validating native delegation',
  cancelling: 'Cancelling Claude process…',
};
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class ProgressView implements ReviewProgressView {
  private readonly controller = new AbortController();
  private state: ReviewProgressState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cancelling = false;
  private disposed = false;
  onAbort?: () => void;

  constructor(privateTui: any, privateTheme: any, privateMode: string, privateCoordinatorModel: string, privateReviewerModel: string, privateEffort: string, state: ReviewProgressState, privateClock: () => number = () => Date.now(), interval: typeof setInterval = setInterval) {
    this.tui = privateTui; this.theme = privateTheme; this.mode = privateMode; this.coordinatorModel = privateCoordinatorModel; this.reviewerModel = privateReviewerModel; this.effort = privateEffort; this.clock = privateClock;
    this.state = this.safeState(state);
    this.startedAt = this.clock();
    this.timer = interval(() => { if (!this.disposed) this.tui.requestRender(); }, 150);
  }
  private readonly tui: any; private readonly theme: any; private readonly mode: string; private readonly coordinatorModel: string; private readonly reviewerModel: string; private readonly effort: string; private readonly clock: () => number; private readonly startedAt: number; private armedAt: number | undefined;
  get signal() { return this.controller.signal; }
  private safeState(state: ReviewProgressState): ReviewProgressState { const requiredAgents = [...state.requiredAgents]; return { ...state, requiredAgents, invokedAgents: state.invokedAgents.filter(name => requiredAgents.includes(name)) }; }
  update(state: ReviewProgressState) { this.state = this.safeState(state); this.tui.requestRender(); }
  setCancelling() { this.cancelling = true; this.update({ ...this.state, phase: 'cancelling' }); }
  private fit(value: string, width: number) { return value.slice(0, Math.max(1, width)); }
  render(width: number) {
    const seconds = Math.max(0, Math.floor((this.clock() - this.startedAt) / 1000));
    const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    const spinner = frames[Math.floor((this.clock() - this.startedAt) / 150) % frames.length];
    const hint = this.isArmed() && !this.cancelling ? 'Press Esc again to cancel' : 'Esc: cancel';
    const rows = [`${spinner} Claude Code Review · ${this.mode} · ${this.coordinatorModel} → ${this.state.requiredAgents.length}× ${this.reviewerModel} · ${this.effort}`, `Stage: ${phases[this.state.phase]}`, `Elapsed: ${elapsed} · Reviewers: ${this.state.invokedAgents.length}/${this.state.requiredAgents.length}`, ...this.state.requiredAgents.map(name => `${this.state.invokedAgents.includes(name) ? '✓' : '○'} ${name}`), hint];
    if (width < 20) return rows.map(row => this.theme?.fg?.('text', this.fit(row, width)) ?? this.fit(row, width));
    const inner = width - 2;
    const pad = (row: string) => `│${this.fit(row, inner).padEnd(inner)}│`;
    const panel = [`╭${'─'.repeat(inner)}╮`, ...rows.map(pad), `╰${'─'.repeat(inner)}╯`];
    return panel.map(row => this.theme?.fg?.('text', row) ?? row);
  }
  handleInput(data: string) { if (data === '\u001b' && !this.cancelling) { if (this.isArmed()) { this.setCancelling(); this.controller.abort(); this.onAbort?.(); } else { this.armedAt = this.clock(); this.tui.requestRender(); } } }
  private isArmed() { return this.armedAt !== undefined && this.clock() - this.armedAt <= 3000; }
  invalidate() { if (!this.disposed) this.tui.requestRender(); }
  dispose() { if (this.disposed) return; this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
export function createProgressView(tui: any, theme: any, mode: string, coordinatorModel: string, reviewerModel: string, effort: string, state: ReviewProgressState, clock?: () => number, interval?: typeof setInterval) { return new ProgressView(tui, theme, mode, coordinatorModel, reviewerModel, effort, state, clock, interval); }
