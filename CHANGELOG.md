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
