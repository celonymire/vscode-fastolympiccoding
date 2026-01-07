# 3.0.2

### Changed

- Moved buttons "Accept Answer", "Decline Answer", and "Compare Answers" to their corresponding textarea instead
- Textareas are directly editable in-place, providing icons to cancel and save the data. Editing status of testcases were removed in favor of this
- Use `process.hrtime` to check for elapsed time as it's much less influenced by the event loop
- Textareas no longer wraps text and provides scroll bars instead
- Updated terminology of placeholders from "stdin" to "input", and so on...
- The error messages regarding missing information tries to infer context to automatically add either an example configuration or a generic template to fill in.
- Judge's standard output writes to output textarea instead of input for stress tester

### Fixed

- Correctly compute the testcase status when data is being saved from edits
- On judge fatal error, correct the testcase being added to the judge file via stress tester to be able to reproduce the error

# 3.0.1

### Changed

- When creating runSettings.json through the command, it will have additional option to preview the examples
- Missing run setting related error messages will show the option to create or open run settings depending on the error

### Fixed

- Debugger not working
- An error message pointing to current file instead of the interactor file

# 3.0.0

### Added

- **Available on Open VSX!**
- Walkthrough to conveniently add a new `runSettings.json`
- Command to clear the compiled cache

### Changed

- Moved `goodSolutionFile`, `generatorFile`, and `interactorFile` to `runSettings.json` for greater customizability
- Made `runCommand` optional to better match folder-specific `runSettings.json` ergonomics
- Allow mixed languages of different files for interactive problems and Stress Tester

### Fixed

- Hanging compiling status in some cases
- Interactive testcases aren't being properly added from stress tester

### Removed

- `${path:...}` variable since `runSettings.json` has structure to know when values need to normalize the path
- `${exeExtname}` because that falls under compiler's responsibility to know they're in Windows
