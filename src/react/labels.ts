import type { DotState } from "../state.js";

/** A label is fixed text, or a function that gives the text for the dot's current state. */
export type DotLabel = string | ((state: DotState) => string);

/**
 * The words the dot shows. Every kind has one; `checking` is shown instead of `live` and `polling` when the dot has no recent
 * confirmation, and `owed` when records are owed. Give any subset to `LiveDot`'s `labels` prop to change them.
 */
export interface DotLabels {
  connecting: DotLabel;
  live: DotLabel;
  polling: DotLabel;
  checking: DotLabel;
  /** Shown instead of `live` and `polling` while records are owed (announced, but their read failed). It must not claim a live screen. */
  owed: DotLabel;
  reconnecting: DotLabel;
  offline: DotLabel;
  paused: DotLabel;
  hidden: DotLabel;
  stopped: DotLabel;
}

/** What the default labels need from the outside: a clock and a way to write a time. */
export interface LabelTools {
  now: () => number;
  formatTime: (ms: number) => string;
}

const STOP_PHRASES: Record<string, string> = {
  access_removed: "your access was removed",
  no_access: "no access to this vault",
  signed_out: "you are signed out",
  rejected: "the request was refused",
  could_not_load: "the data could not be loaded",
  stopped_by_app: "stopped",
};

/** The time as hours and minutes in the reader's own format. */
export const defaultFormatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Builds the English labels. In: the clock and the time writer (so a test or an app can fix both). Out: one label per kind.
 *
 * @param tools the clock and the time writer
 */
export function createDefaultLabels(tools: LabelTools): DotLabels {
  return {
    connecting: "Connecting",
    live: "Live",
    polling: "Live, checking every few seconds",
    checking: "Checking",
    // Plain count, and no claim: a screen that lacks announced records is not a live one.
    owed: (s) => `${s.owed} ${s.owed === 1 ? "change" : "changes"} could not be loaded yet`,
    reconnecting: (s) => {
      if (s.retryAt === null || !Number.isFinite(s.retryAt)) return "Reconnecting";
      // Rounded up with a floor of one: "in 0 seconds" would read as a broken counter.
      const seconds = Math.max(1, Math.ceil((s.retryAt - tools.now()) / 1000));
      return `Reconnecting in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
    },
    offline: (s) => (s.asOf === null ? "Offline" : `Offline, showing data as of ${tools.formatTime(s.asOf)}`),
    paused: (s) => {
      if (!(s.waiting > 0)) return "Paused";
      return `Paused, ${s.waiting} ${s.waiting === 1 ? "change" : "changes"} waiting`;
    },
    hidden: "Paused, tab hidden",
    stopped: (s) => `Stopped: ${STOP_PHRASES[s.cause ?? ""] ?? "stopped"}`,
  };
}

/** The English labels with the real clock and the reader's time format. */
export const defaultLabels: DotLabels = createDefaultLabels({ now: Date.now, formatTime: defaultFormatTime });
