# 3.0.1

### Fixed

- Debugger not working

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
