// The browser guest client under test feature-detects these; coding-agent's type environment has no DOM lib.
declare function requestAnimationFrame(callback: (time: number) => void): number;
declare function cancelAnimationFrame(handle: number): void;
