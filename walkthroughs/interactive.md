# Interactive Mode

We need to tell the Stress Tester the name of our interactor file. The extension will then establish a two-way communication between the solution and the interactor. Here is an example:

```json
{
  "interactorFile": "${fileDirname}/${fileBasenameNoExtension}__Interactor${fileExtname}"
}
```

![Interactive Workflow Gif](../media/interactive-workflow.gif)
