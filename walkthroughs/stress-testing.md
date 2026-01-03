# Stress Tester

We need both a file that outputs the correct solution and another that outputs a random input to both the current and correct solution. Additional information needs to be added to `runSettings.json` to tell the Stress Tester the names of these files. Here is an example:

```json
{
  "generatorFile": "${fileDirname}/${fileBasenameNoExtension}__Generator${fileExtname}",
  "goodSolutionFile": "${fileDirname}/${fileBasenameNoExtension}__Good${fileExtname}"
}
```

![Stress Tester Gif](../media/stress_tester.gif)
