/** What the demo workflow is asked to do, and what it reports back. */

export interface DemoInput {
  /** Shows up in the UI's input tab and in every step's result. */
  label?: string;
  /** Total wall-clock the run should take, split across its steps and one timer. */
  durationMs?: number;
  /**
   * Make the last step fail its first two attempts. The point of the flag: the
   * two steps before it do NOT run again when it retries.
   */
  fail?: boolean;
}

export interface DemoResult {
  label: string;
  /** One line per step, each naming the attempt it succeeded on. */
  steps: string[];
}
