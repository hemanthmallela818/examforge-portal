// Non-standard browser APIs used by the exam screens, always feature-tested at
// runtime: the Keyboard Lock API and the `keyboardLock` fullscreen option
// (lockdown), and the Network Information API (ExamNavbar connection quality).
export {};

declare global {
  interface Keyboard {
    lock?: (keyCodes?: string[]) => Promise<void>;
    unlock?: () => void;
  }

  interface NetworkInformation extends EventTarget {
    readonly effectiveType?: 'slow-2g' | '2g' | '3g' | '4g' | string;
    readonly downlink?: number;
  }

  interface Navigator {
    readonly keyboard?: Keyboard;
    readonly connection?: NetworkInformation;
  }

  interface FullscreenOptions {
    keyboardLock?: 'browser' | 'system' | 'none';
  }
}
