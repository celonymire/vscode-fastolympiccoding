# 4.0.4

### Added

- Support for opened files without active workspaces

### Changed
- Made text expansion editor's title human-friendly

### Fixed

- Sometimes leading newlines would be inserted when switching back to a file with running sessions

# 4.0.3

### Changed

- Let the stress tester run indefinitely by default
- Folding now doesn't depend on extensions

### Fixed

- New Testcase button text cuts off if shrinked down
- Truncated data would be saved as actual data when running or debugging
- Folding now folds the entire file content not just the last code block of the file

# 4.0.2

### Added

- Recommended extensions for general use of languages to enhance the motive of recommending them
- Option to view example debug configurations
- Notes for various languages to convey potentially important information
- Delete testcase button for running status

### Changed

- File template no longer shows the base directory for its prefix
- Display "COMPILING" before testcase icon for stress tester to align with judge
- Changed recommended debugging extension for C, C++, and other compiled languages to Microsoft's official C/C++ extension
- Default to current workspace folder for file template base directory if none is specified

### Fixed

- (Regression) File template insertion stopped working since 4.0.0
- Rejection errors in file template insertion were not handled
- Correctly reject changing testcase type during running and compiling

# 4.0.1

### Added

- Default configuration for TypeScript

### Changed

- Show empty stdout for testcase with a placeholder instead of hiding it
- Added file name to the file template picker item's description to improve matching
- Always show the icon to indicate the type of current testcase and make it clickable to toggle testcase interactivity
- Also show the dropdown button (that does nothing) for compiling status to keep the toolbars consistent
- Shorten the compiling error to just "CE" in stress tester for consistency
- Allow dropdown when compiling
- Allow showing details even in faded with same effect
- Don't clear previous data from stress testers when compiling

### Fixed

- (Regression) skipped testcases are still being ran
- Don't half the opacity of clickable elements

# 4.0.0

### Added

- Persistent sessions for running testcases and stress tester. Whenever the active editor changes, the previous session is saved and restored when the file is opened again
- Default run and debug configurations for C++, Python, Java, Go, Rust, JavaScript, Haskell, Ruby, and C# (no default debug configurations for Kotlin due to breakpoints not functioning)
- Ctrl+Enter hotkey to save currently edited textarea
- Ctrl+Enter to append newline instead of sending current online input
- Automatically show notification to check changelog when extension is updated
- Option to create file directly from the error popup if it doesn't exist
- `${debugPid}` for PID of the process for debugging
- Example debug command and attach configurations for C++, Python, and Java as well as convenient ways to automatically add them to launch.json file
- Toggle show details button for stress tester as well as more statuses for judge
- Icon to open the corresponding file for stress tester
- Icon to open the interactor for judge
- Command and context menu to change the port for Competitive Companion

### Changed

- Use native addons to run solutions and enforce limits instead of using child_process. This bypasses the event loop and allows for more accurate limits as well as accurate metrics. Using native addons also means we effectively restrict this extension to only run on Windows, Linux, and macOS.
- Use total CPU time to enforce time limit and a 2x multipler to enforce the wall time
- Changes are debounced on judge prevent rapid IO bottlenecks
- Trim off trailing whitespaces when requesting full data
- Don't save ongoing running statuses to avoid blocking interacting with testcase on malfunction
- Allow showing testcase details on compiler error status
- Enhanced integrated view to display compilation output and errors
- Made the bubble texts in the UI more compact
- Combined IO from solution and interactor to display the order of interactions
- Optimized the toolbar of the judge and stress tester to avoid unnecessary updates
- Stress tester now opens the file for added testcase

### Fixed

- Leading newline when adding real-time inputs to empty saved input
- Seed for generators in stress tester not utilizing full 64-bit integer range
- Tooltip not updating when the attribute changes
- Compilation errors being double logged resulting in unhandled promise rejections
- Interactor file compiling prematurely setting status of the testcase
- Race condition due to unnecessary async calls causing status to be incorrect in few scenarios
- Stress Tester would hang in some situations when some files returned with non-zero exit code
- Interactive testcase status being overridden when saving new interactor secret during the run
- Testcase runtime errors weren't detected when the interactor had failure causing it to not return an exit code
- Testcase stuck in running state when settings for the file were invalid or not found

### Removed

- Web platform support explicitly (it would've never worked before)
- Walkthrough. It never showed up by itself and was only accessible through the command palette. The README already covers majority of the information and the built-in error messages help fill in the necessary information.
- Removed unused save all functionality
- Removed custom caret placing from the textarea because it acts inconsistently with the custom truncated display of IO texts
