export interface ILanguageSettings {
  compileCommand?: string;
  runCommand: string;
  currentWorkingDirectory?: string;
}

export interface ITest {
  input: string;
  output: string;
}

export interface IProblem {
  name: string;
  group: string;
  url: string;
  interactive: boolean;
  memoryLimit: number;
  timeLimit: number;
  tests: ITest[];
  testType: "single" | "multiNumber";
  input:
    | {
        type: "stdin";
      }
    | {
        type: "file";
        fileName: string;
      }
    | {
        type: "regex";
        pattern: string;
      };
  output:
    | {
        type: "stdout";
      }
    | {
        type: "file";
        fileName: string;
      };
  languages:
    | {
        [key: string]: string;
      }
    | {
        java: {
          mainClass: string;
          taskClass: string;
        };
      };
  batch: {
    id: number;
    size: number;
  };
}

export function coerceToObject(data: unknown): object {
  if (typeof data === "object" && data !== null) {
    return data;
  }
  return {};
}
export function coerceToArray(data: unknown): object[] {
  const arr = [];
  if (Array.isArray(data)) {
    for (const obj of data) {
      arr.push(coerceToObject(obj));
    }
  }
  return arr;
}
