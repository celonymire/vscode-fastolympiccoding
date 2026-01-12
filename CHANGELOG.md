# 4.0.0

### Added

- Ctrl+Enter hotkey to save currently edited textarea
- Ctrl+Enter to append newline instead of sending current online input

### Changed

- Use native addons to run solutions and enforce limits instead of using child_process. This bypasses the event loop and allows for more accurate limits as well as accurate metrics. Using native addons also means we effectively restrict this extension to only run on Windows, Linux, and macOS, which are the platforms that VSCode supports
- Use total CPU time to enforce time limit and a 2x multipler to enforce the wall time
- The extension excludes the web platform support explicitly and will not provide a "universal" VSIX. It would have failed implicity in the past, but now this restriction is enforced to platform specific VSIX.
- Trim off trailing whitespaces when requesting full data
- Don't save ongoing running statuses to avoid blocking interacting with testcase on malfunction
- Removed unused save all functionality

### Fixed

- Leading newline when adding real-time inputs to empty saved input
- Seed for generators in stress tester not utilizing full 64-bit integer range
