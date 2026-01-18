# 4.0.0

### Added

- Persistent sessions for running testcases and stress tester. Whenever the active editor changes, the previous session is saved and restored when the file is opened again
- Ctrl+Enter hotkey to save currently edited textarea
- Ctrl+Enter to append newline instead of sending current online input
- Automatically show notification to check changelog when extension is updated
- Option to create file directly from the error popup if it doesn't exist
- `${debugPid}` for PID of the process for debugging
- Example debug command and attach configurations for C++, Python, and Java as well as convenient ways to automatically add them to launch.json file

### Changed

- Use native addons to run solutions and enforce limits instead of using child_process. This bypasses the event loop and allows for more accurate limits as well as accurate metrics. Using native addons also means we effectively restrict this extension to only run on Windows, Linux, and macOS. The web platform is excluded.
- Use total CPU time to enforce time limit and a 2x multipler to enforce the wall time
- Changes are debounced on judge prevent rapid IO bottlenecks
- Trim off trailing whitespaces when requesting full data
- Don't save ongoing running statuses to avoid blocking interacting with testcase on malfunction
- Removed unused save all functionality
- Allow showing testcase details on compiler error status

### Fixed

- Leading newline when adding real-time inputs to empty saved input
- Seed for generators in stress tester not utilizing full 64-bit integer range
- Tooltip not updating when the attribute changes
- Compilation errors being double logged resulting in unhandled promise rejections
- Interactor file compiling prematurely setting status of the testcase

### Removed

- Walkthrough. It never showed up by itself and was only accessible through the command palette. The README already covers majority of the information and the built-in error messages help fill in the necessary information.
